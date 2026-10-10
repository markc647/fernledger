import { createScheduledController } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from './index'
import { applyRulesStatement } from './rule-apply'
import { BACKUP_CRON } from './backup'
import { MAX_RULES } from './rule-criteria'
import { BACKUP_CHUNKS, chunkFor, continueRerun, CRON_CHUNKS, cronQueries, DAILY_READ_BUDGET, DAILY_WRITE_BUDGET, ESTIMATED_STEP_READS, ESTIMATED_WRITES_PER_ROW, MIN_CHUNK, QUERIES_PER_CHUNK, QUERIES_TO_FINISH, READS_PER_ROW, restartRerun, RERUN_CHUNK, startRerun, STEP_READS, stepRerun, stopRerun, utcDay } from './rule-rerun'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member (the dev identity
// cookie is honoured on localhost only; Access token handling is tested in api.test.ts).
//
// Re-running Rules over all history (worker/rule-rerun.ts) walks the Transactions by ID in chunks of RERUN_CHUNK, one chunk per
// request or cron run, and keeps its place in `data_migration_progress`. The big fixture below is 20 chunks long, so a test that
// finishes the walk has had to resume it 19 times.
const origin = 'http://localhost:5173'
const ACCOUNTS = ['99-9999-9999999-99', '99-9999-9999999-98']

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

type Job = {
  id: number
  status: 'running' | 'done' | 'stopped'
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  totalRows: number
  doneRows: number
  changedRows: number
  percent: number
  restarts: number
  stepRows: number
  cronRowsPerDay: number
  paused: boolean
}
type Stored = { id: number; rule_id: number | null; rule_category: number | null; rule_transfer: number | null }

const start = (who: Who = 'admin') => call('/api/rules/rerun', { who, method: 'POST', body: {} })
const stop = (who: Who = 'admin') => call('/api/rules/rerun/stop', { who, method: 'POST', body: {} })
const step = (who: Who = 'admin') => call('/api/rules/rerun/step', { who, method: 'POST', body: {} })
const latest = async (who: Who = 'member') => ((await (await call('/api/rules/rerun', { who })).json()) as { job: Job | null }).job

async function startOk() {
  const res = await start()
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return ((await res.json()) as { job: Job }).job
}
async function stepOk() {
  const res = await step()
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  return ((await res.json()) as { job: Job }).job
}
/** Steps until the job is done, returning each step's answer. */
async function stepToEnd(limit = 100) {
  const jobs: Job[] = []
  for (let i = 0; i < limit; i++) {
    const job = await stepOk()
    jobs.push(job)
    if (job.status === 'done') return jobs
  }
  throw new Error(`Still running after ${limit} steps`)
}

const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, type, before, after FROM change_log ORDER BY id').all()).results
const reruns = async () => (await env.DB.prepare('SELECT * FROM data_migration_progress ORDER BY id').all()).results
const stored = async () => (await env.DB.prepare('SELECT id, rule_id, rule_category, rule_transfer FROM transactions ORDER BY id').all<Stored>()).results
const countWhere = async (where: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).first<{ n: number }>())!.n

async function addRule(body: Record<string, unknown>) {
  const res = await call('/api/rules', { method: 'POST', body })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return ((await res.json()) as { id: number }).id
}

/** Five Rules that overlap, in priority order: money out at a supermarket, fuel, a round-up Transfer, direct debits, then any supermarket. */
async function saveRules() {
  const ids = {
    supermarketOut: await addRule({ textContains: 'SUPERMARKET', direction: 'out', categoryId: await categoryId('Groceries') }),
    fuel: await addRule({ textContains: 'FUEL', categoryId: await categoryId('Fuel') }),
    roundUp: await addRule({ textContains: 'ROUND UP', transfer: true }),
    directDebit: await addRule({ bankType: 'DIRECT DEBIT', minCents: 1000, categoryId: await categoryId('Power and gas') }),
    supermarket: await addRule({ textContains: 'SUPERMARKET', categoryId: await categoryId('Gifts and donations') }),
  }
  return ids
}
const RULES = 5

/** Adds `count` made-up Transactions across two Accounts, in one statement: an eighth each of supermarkets, fuel, round-ups and power, the rest matching no Rule. */
async function fill(count: number) {
  const accounts = (await env.DB.prepare('SELECT id FROM accounts ORDER BY account_number DESC').all<{ id: number }>()).results.map((a) => a.id)
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
     INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, bank_type, source)
     SELECT CASE WHEN i % 2 = 0 THEN ?1 ELSE ?2 END,
            date('2020-01-01', '+' || (i / 30) || ' days'),
            CASE WHEN i % 11 = 0 THEN 1000 + i % 5000 ELSE -(1000 + i % 5000) END,
            CASE i % 8 WHEN 0 THEN 'EXAMPLE SUPERMARKET ' WHEN 1 THEN 'EXAMPLE FUEL STOP ' WHEN 2 THEN 'EXAMPLE ROUND UP ' WHEN 3 THEN 'EXAMPLE POWER CO ' ELSE 'EXAMPLE MISC ' END || i,
            '',
            CASE i % 8 WHEN 2 THEN 'AUTO PAYMENT' WHEN 3 THEN 'DIRECT DEBIT' ELSE 'EFTPOS' END,
            'import'
     FROM n`,
  )
    .bind(accounts[0], accounts[1], count)
    .run()
}

/** What applying the Rules to every Transaction from scratch gives: the Import's own statement, run over each Account, on rows that start with no result. */
async function fromScratch() {
  await env.DB.prepare('UPDATE transactions SET rule_id = NULL, rule_category = NULL, rule_transfer = NULL').run()
  for (const accountNumber of ACCOUNTS) await applyRulesStatement(env.DB, { accountNumber, afterId: 0 }).run()
  return stored()
}

/** Whatever the re-run left must be what applying the Rules from scratch gives. (The snapshot is taken first: `fromScratch` rewrites every result.) */
async function expectSameAsFromScratch() {
  const afterRerun = await stored()
  expect(await fromScratch()).toEqual(afterRerun)
}

type CategoryRecord = { id: number; name: string }
let starters: CategoryRecord[] = []
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

/** Back to the starter Categories, two Accounts and nothing else, so no test depends on what an earlier one left. */
async function resetEverything() {
  await env.DB.batch(['transactions', 'rules', 'accounts', 'change_log', 'categories', 'data_migration_progress'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'transactions'").run() // the IDs start from 1 again
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(c.id, c.name)))
  await env.DB.batch(ACCOUNTS.map((number, i) => env.DB.prepare('INSERT INTO accounts (account_number, name) VALUES (?, ?)').bind(number, `Example ${i + 1}`)))
}

/**
 * A D1 binding that counts what the code under test asks of it: queries (each statement of a batch is one, as the free plan counts
 * them), and the rows D1 says it read and wrote.
 */
function metered(db: D1Database = env.DB, hooks: { beforeBatch?: () => Promise<void> } = {}) {
  const usage = { queries: 0, rowsRead: 0, rowsWritten: 0 }
  const tally = (meta: D1Result['meta']) => {
    usage.rowsRead += meta.rows_read
    usage.rowsWritten += meta.rows_written
  }
  const unwrapped = new WeakMap<object, D1PreparedStatement>()
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => {
        const result = await statement.all()
        usage.queries++
        tally(result.meta)
        return result
      },
      run: async () => {
        const result = await statement.run()
        usage.queries++
        tally(result.meta)
        return result
      },
      first: async (column?: string) => {
        const result = await statement.all()
        usage.queries++
        tally(result.meta)
        const row = (result.results[0] ?? null) as Record<string, unknown> | null
        return column === undefined || row === null ? row : row[column]
      },
    }
    unwrapped.set(wrapped, statement)
    return wrapped as unknown as D1PreparedStatement
  }
  const binding = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      // Another request gets in between this one's reads and its batch.
      await hooks.beforeBatch?.()
      const results = await db.batch(statements.map((s) => unwrapped.get(s)!))
      usage.queries += statements.length
      for (const result of results) tally(result.meta)
      return results
    },
  } as unknown as D1Database
  return { db: binding, usage }
}

const cron = async (bindings: Env = env, at = new Date('2026-10-12T18:00:00Z')) =>
  worker.scheduled(createScheduledController({ cron: '0 18 * * *', scheduledTime: at }), bindings)

describe('a big history', () => {
  // 20,000 Transactions is 20 chunks. Built once; each test starts from no Rules, no Overrides and no results.
  const BIG = 20_000
  const LONG = { timeout: 120_000 }

  beforeAll(async () => {
    await resetEverything()
    await fill(BIG)
  })
  beforeEach(async () => {
    // Results first: a Transaction points at the Rule that gave it one.
    await env.DB.prepare('UPDATE transactions SET rule_id = NULL, rule_category = NULL, rule_transfer = NULL, override_category = NULL, note = NULL').run()
    await env.DB.batch(['rules', 'change_log', 'data_migration_progress'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  })

  it('is walked in chunks, one per step, and the last step finishes it with the same result as applying the Rules from scratch', LONG, async () => {
    await saveRules()
    const started = await startOk()
    expect(started).toMatchObject({ status: 'running', totalRows: BIG, doneRows: 0, changedRows: 0, restarts: 0, finishedAt: null })

    const jobs = await stepToEnd()

    // Several steps were needed: no single request did the whole history.
    expect(jobs.length).toBe(BIG / RERUN_CHUNK)
    jobs.forEach((job, i) => expect(job.doneRows, `after step ${i + 1}`).toBe(Math.min((i + 1) * RERUN_CHUNK, BIG)))
    expect(jobs.slice(0, -1).every((job) => job.status === 'running' && job.finishedAt === null)).toBe(true)
    const done = jobs.at(-1)!
    expect(done).toMatchObject({ status: 'done', totalRows: BIG, doneRows: BIG, restarts: 0 })
    expect(done.finishedAt).not.toBeNull()

    const afterRerun = await stored()
    expect(afterRerun.filter((t) => t.rule_id !== null).length).toBe(BIG / 2) // the fixture has something for every Rule to do: half the Transactions match one
    expect(done.changedRows).toBe(afterRerun.filter((t) => t.rule_id !== null).length) // every Transaction a Rule matched was written, and no other
    expect(await fromScratch()).toEqual(afterRerun)
  })

  it('stops part way and carries on from where it got to, in later requests and cron runs', LONG, async () => {
    await saveRules()
    await startOk()
    for (let i = 0; i < 7; i++) await stepOk()
    const midway = (await reruns())[0] as { cursor: number; done_rows: number }
    expect(midway.done_rows).toBe(7 * RERUN_CHUNK)
    expect(midway.cursor).toBe(7 * RERUN_CHUNK) // the IDs are 1 to 20,000, so the last one done is the 7,000th

    // The page is closed here. Mark one Transaction on each side of the cursor with a result no Rule gives it: a walk that began
    // again from the start would put both right, one that carries on from the cursor leaves the one behind it as it is.
    const wrong = await categoryId('Tax')
    const behind = 4 // MISC rows (id % 8 = 4) match no Rule
    const ahead = 7 * RERUN_CHUNK + 4
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id IN (?, ?)').bind(wrong, behind, ahead).run()

    // A cron run carries on (not the browser): CRON_CHUNKS chunks, then the browser's step, then crons until it is done.
    await cron()
    expect(((await reruns())[0] as { done_rows: number }).done_rows).toBe((7 + CRON_CHUNKS) * RERUN_CHUNK)
    expect((await stepOk()).doneRows).toBe((8 + CRON_CHUNKS) * RERUN_CHUNK)
    for (let i = 0; i < 20 && (await latest())?.status === 'running'; i++) await cron()

    const done = (await latest())!
    expect(done).toMatchObject({ status: 'done', doneRows: BIG, restarts: 0 })
    const after = new Map((await stored()).map((t) => [t.id, t]))
    expect(after.get(behind)!.rule_category).toBe(wrong) // not looked at again
    expect(after.get(ahead)!.rule_category).toBeNull() // looked at, and put right
    await env.DB.prepare('UPDATE transactions SET rule_category = NULL WHERE id = ?').bind(behind).run()
    await expectSameAsFromScratch()
  })

  it('never writes an Override, a Note or anything of a Transaction but its Rule result', LONG, async () => {
    await saveRules()
    await env.DB.prepare("UPDATE transactions SET override_category = ?, note = 'keep this' WHERE id % 97 = 0").bind(await categoryId('Travel')).run()
    const everythingElse = () => env.DB.prepare('SELECT id, account_id, date, amount_cents, description, bank_memo, bank_type, bank_reference, source, bank_unique_id, override_category, note FROM transactions ORDER BY id').all()
    const before = (await everythingElse()).results
    expect(before.filter((t) => t.override_category !== null).length).toBeGreaterThan(100)

    await startOk()
    await stepToEnd()

    expect((await everythingElse()).results).toEqual(before)
    // Some of the Transactions with an Override are ones a Rule matches, so their Rule result is stored under it, and the Override still decides the Category.
    const underOverride = await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE override_category IS NOT NULL AND rule_category IS NOT NULL').first<{ n: number }>()
    expect(underOverride!.n).toBeGreaterThan(0)
    const listed = (await (await call('/api/transactions?categoryId=' + (await categoryId('Travel')) + '&limit=200&count=false')).json()) as { transactions: { categorySource: string }[] }
    expect(listed.transactions.length).toBe(200)
    expect(listed.transactions.every((t) => t.categorySource === 'override')).toBe(true)
  })

  it('puts right the Transactions that no longer match, and writes only the ones whose result changes', LONG, async () => {
    const rules = await saveRules()
    await startOk()
    await stepToEnd()
    const first = await stored()

    // Run again with nothing changed: every Transaction is looked at and none is written.
    expect(((await startOk()).changedRows)).toBe(0)
    const again = await stepToEnd()
    expect(again.at(-1)).toMatchObject({ status: 'done', doneRows: BIG, changedRows: 0 })
    expect(await stored()).toEqual(first)

    // Now change the Rules: one is removed, one moves to the top, one gets another Category. Those that lose their Rule must lose its result.
    await call(`/api/rules/${rules.fuel}`, { method: 'DELETE', body: {} })
    await call('/api/rules/order', { method: 'PUT', body: { ids: [rules.supermarket, rules.supermarketOut, rules.roundUp, rules.directDebit] } })
    await call(`/api/rules/${rules.directDebit}`, { method: 'PUT', body: { bankType: 'DIRECT DEBIT', minCents: 1000, categoryId: await categoryId('Insurance') } })
    const fuel = first.filter((t) => t.rule_id === rules.fuel)
    expect(fuel.length).toBe(BIG / 8)

    await startOk()
    const second = await stepToEnd()
    const afterwards = await stored()
    const after = new Map(afterwards.map((t) => [t.id, t]))

    expect(fuel.every((t) => after.get(t.id)!.rule_id === null && after.get(t.id)!.rule_category === null)).toBe(true)
    // Supermarkets now all go to the Rule that was last (it is first now), whichever way the money went.
    expect(await countWhere(`rule_id = ${rules.supermarketOut}`)).toBe(0)
    expect(await countWhere(`rule_id = ${rules.supermarket}`)).toBe(BIG / 8)
    // The job counts as changed exactly the Transactions whose stored result is different now. The round-ups and the half that match nothing are not among them.
    const same = (a: Stored, b: Stored) => a.rule_id === b.rule_id && a.rule_category === b.rule_category && a.rule_transfer === b.rule_transfer
    const changed = first.filter((t) => !same(t, after.get(t.id)!)).length
    expect(changed).toBeGreaterThan((BIG / 8) * 2) // fuel cleared, the supermarkets that went out moved to another Rule, direct debits in another Category
    expect(second.at(-1)!.changedRows).toBe(changed)
    await expectSameAsFromScratch()
  })

  it('writes one Change Log entry when it starts and one when it finishes, each with counts, and none for the steps between', LONG, async () => {
    await saveRules()
    const before = (await changeLog()).length

    await startOk()
    for (let i = 0; i < 5; i++) await stepOk()
    await stepToEnd()

    const entries = (await changeLog()).slice(before)
    expect(entries).toMatchObject([
      { summary: 'Started applying the Rules to up to 20,000 Transactions', type: 'rule', actor: 'admin@example.com', before: null },
      { summary: expect.stringMatching(/^Finished applying the Rules to all Transactions: 20,000 looked at, [\d,]+ updated$/), type: 'rule', actor: 'admin@example.com', before: null },
    ])
    expect(JSON.parse(entries[0]!.after as string)).toEqual({ transactionsUpTo: BIG })
    const finished = JSON.parse(entries[1]!.after as string)
    expect(finished).toEqual({ transactionsLookedAt: BIG, transactionsUpdated: (await latest())!.changedRows })
  })

  describe('costs, per step, what the free plan allows (ADR 0004: 10 ms CPU, 50 queries, 100k rows written and 5 million read a day)', () => {
    it('is a few queries, rows read in proportion to the chunk and the Rules, and one write for each Transaction it changes', LONG, async () => {
      await saveRules()
      await startOk()
      const steps: { queries: number; rowsRead: number; rowsWritten: number }[] = []
      for (let i = 0; i < BIG / RERUN_CHUNK; i++) {
        const { db, usage } = metered()
        const job = await stepRerun(db)
        steps.push({ ...usage })
        expect(job).not.toBeNull()
      }
      expect((await latest())!.status).toBe('done')

      // Every step: the 50 queries an invocation may make are far off. (Finding the job, the end of the chunk, the batch of 2, the day's tally, and when it ends 3 more.)
      expect(Math.max(...steps.map((s) => s.queries))).toBeLessThanOrEqual(1 + QUERIES_PER_CHUNK + QUERIES_TO_FINISH)
      // The chunk is read twice (the walk and the row it updates) and each row is checked against the Rules it has to get past.
      expect(Math.max(...steps.map((s) => s.rowsRead))).toBeLessThanOrEqual(RERUN_CHUNK * (RULES + 10))
      // At most a table row and an index entry for each Transaction changed, plus the progress row and the Change Log entry. (Measured
      // locally at 876 for a chunk with 500 changes. D1 may count more index entries, up to two for a Category that changes to another.)
      expect(Math.max(...steps.map((s) => s.rowsWritten))).toBeLessThanOrEqual(RERUN_CHUNK * 2 + 10)
      // The whole of 20,000 Transactions against a day's allowance (5,000,000 read, 100,000 written).
      const total = steps.reduce((sum, s) => ({ rowsRead: sum.rowsRead + s.rowsRead, rowsWritten: sum.rowsWritten + s.rowsWritten }), { rowsRead: 0, rowsWritten: 0 })
      expect(total.rowsRead).toBeLessThanOrEqual(BIG * (RULES + 10))
      expect(total.rowsWritten).toBeLessThanOrEqual(BIG * 2 + 100)
    })

    it('writes next to nothing when no result changes', LONG, async () => {
      await saveRules()
      await startOk()
      await stepToEnd()
      await startOk()

      const { db, usage } = metered()
      await stepRerun(db)

      expect(usage.rowsWritten).toBeLessThanOrEqual(3) // the progress row only
    })

    // The most there can be, none of which matches until the last: every Transaction walks past all of them (the Rules are read in
    // priority order and the walk stops at the first match). This is the dear case: a step reads about 106,000 rows, and a
    // 100,000-Transaction history 10 million, which is two days' reads, so the job would pause at the daily limit and carry on.
    // With the most Rules the chunk is smaller (chunkFor), so a step stays about STEP_READS whatever the Rules.
    it.each([5, 30, MAX_RULES])('reads about a row per Rule for each Transaction, with %i Rules and no early match, in a chunk sized to them', LONG, async (rules) => {
      const groceries = await categoryId('Groceries')
      await env.DB.batch(Array.from({ length: rules }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 1, i === rules - 1 ? 'EXAMPLE' : `NO SUCH SHOP ${i}`, groceries)))
      const size = chunkFor(rules)
      expect(await startOk()).toMatchObject({ stepRows: size })
      const { db, usage } = metered()

      const job = await stepRerun(db)

      expect(job!.doneRows).toBe(size)
      expect(size).toBe(rules === 5 ? RERUN_CHUNK : rules === 30 ? 625 : 227)
      expect(usage.queries).toBeLessThanOrEqual(1 + QUERIES_PER_CHUNK + QUERIES_TO_FINISH)
      expect(usage.rowsRead).toBeLessThanOrEqual(size * (rules + READS_PER_ROW) + 400) // 400: the count of Rules, read with the job each time
      expect(usage.rowsRead).toBeGreaterThan(size * rules) // so a bound this tight is about the Rules, not slack
      expect(usage.rowsRead).toBeLessThanOrEqual(STEP_READS + 1_000) // the same step whatever the Rules (5 Rules: 15,000, as the chunk is capped)
      expect(usage.rowsWritten).toBeLessThanOrEqual(size * 2 + 10) // all matched the last Rule: a table row and an index entry each, and the job's place
    })

    it('costs one query when there is nothing to carry on, on a cron run', async () => {
      const { db, usage } = metered()
      await continueRerun(db)
      expect(usage).toMatchObject({ queries: 1, rowsWritten: 0 })
    })

    it('is a bounded number of chunks and queries in a cron run', LONG, async () => {
      await saveRules()
      await startOk()
      const { db, usage } = metered()

      await continueRerun(db)

      expect((await latest())!.doneRows).toBe(CRON_CHUNKS * RERUN_CHUNK)
      expect(usage.queries).toBeLessThanOrEqual(cronQueries(CRON_CHUNKS)) // 16 of the 50 the plan allows; the backup (20) and Sync share the cron
      expect(cronQueries(CRON_CHUNKS) + 20).toBeLessThan(50)
    })

    // A cron run that is also carrying a backup on has the invocation's encoding and hashing to do as well, so it does one chunk.
    it('does one chunk when a backup is being carried on in the same run', LONG, async () => {
      await saveRules()
      await startOk()
      try {
        await worker.scheduled(createScheduledController({ cron: BACKUP_CRON, scheduledTime: new Date('2026-10-11T15:00:00Z') }), env) // starts a backup of 20,000 Transactions, which is more than one run writes
        expect((await latest())!.doneRows).toBe(0) // the weekly cron leaves the re-run alone
        const { db, usage } = metered()

        await cron({ ...env, DB: db } as Env)

        expect((await latest())!.doneRows).toBe(BACKUP_CHUNKS * RERUN_CHUNK)
        // The backup's continuation makes D1 queries too (up to 20 operations with R2's), so the invocation's share is both.
        expect(usage.queries).toBeLessThanOrEqual(cronQueries(BACKUP_CHUNKS) + 20)
        expect(cronQueries(BACKUP_CHUNKS) + 20).toBeLessThan(50)
      } finally {
        for (const object of (await env.BACKUPS.list()).objects) await env.BACKUPS.delete(object.key)
      }
    })

    it('starts and restarts without counting the Transactions: the highest ID is the one read', LONG, async () => {
      await saveRules()
      const started = metered()
      await startRerun(started.db, { email: 'admin@example.com', role: 'admin' })
      expect(started.usage.rowsRead).toBeLessThanOrEqual(30) // the highest ID and the job, not 20,000 Transactions

      await stepOk()
      const restarted = metered()
      await restartRerun(restarted.db).run()
      expect(restarted.usage.rowsRead).toBeLessThanOrEqual(30)
      expect(await latest()).toMatchObject({ doneRows: 0, restarts: 1, totalRows: BIG })
    })

    it('a step that lost its place to another does no work: it reads next to nothing and changes nothing', LONG, async () => {
      await saveRules()
      await startOk()
      const before = await stored()
      // The other request moves the job on (as a winning step would have) after this one has read where it is and before its batch.
      const other = () => env.DB.prepare("UPDATE data_migration_progress SET cursor = 1000, done_rows = 1000 WHERE status = 'running'").run().then(() => undefined)
      const { db, usage } = metered(env.DB, { beforeBatch: other })

      const job = await stepRerun(db)

      expect(job).toMatchObject({ status: 'running', doneRows: 1000 }) // the other's, not this one's
      expect(await stored()).toEqual(before) // neither moved a Transaction (the other only moved the place)
      // The end of the chunk was read (1,000 rows) and the walk and the move found nothing to do. Walking the chunk would add about 9,000.
      expect(usage.rowsRead).toBeLessThanOrEqual(RERUN_CHUNK + 100)
      expect(usage.rowsWritten).toBe(0)
    })

    it('a step that was stopped meanwhile does no work either', LONG, async () => {
      await saveRules()
      await startOk()
      const before = await stored()
      const { db, usage } = metered(env.DB, { beforeBatch: async () => void (await stop()) })

      const job = await stepRerun(db)

      expect(job).toMatchObject({ status: 'stopped', doneRows: 0 })
      expect(await stored()).toEqual(before)
      expect(usage.rowsRead).toBeLessThanOrEqual(RERUN_CHUNK + 100)
    })
  })
})

describe('a small history', () => {
  const N = 2500 // three chunks
  beforeEach(async () => {
    await resetEverything()
    await fill(N)
  })

  describe('starting', () => {
    it('records the job, counts the Transactions it will look at, and answers with it', async () => {
      await saveRules()

      const res = await start()

      expect(res.status).toBe(201)
      const { job } = (await res.json()) as { job: Job }
      expect(job).toMatchObject({ status: 'running', totalRows: N, doneRows: 0, changedRows: 0, restarts: 0, finishedAt: null })
      expect(await reruns()).toMatchObject([{ id: job.id, kind: 'rules-rerun', status: 'running', cursor: 0, end_id: N, total_rows: N, done_rows: 0, started_by: 'admin@example.com' }])
      expect(await latest()).toEqual(job)
    })

    it('changes no Transaction yet', async () => {
      await saveRules()
      const before = await stored()
      await startOk()
      expect(await stored()).toEqual(before)
    })

    it('has nothing to report before the first time', async () => {
      expect(await latest()).toBeNull()
      expect(await (await step()).json()).toEqual({ job: null })
    })

    it('is refused while another is running, and writes nothing', async () => {
      await startOk()
      const entries = (await changeLog()).length

      const res = await start()

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'A re-run is already in progress' })
      expect(await reruns()).toHaveLength(1)
      expect(await changeLog()).toHaveLength(entries)
    })

    it('lets only one of two requests that start together in', async () => {
      const results = await Promise.all([start(), start(), start()])

      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409])
      expect(await reruns()).toHaveLength(1)
      expect((await changeLog()).filter((e) => String(e.summary).startsWith('Started applying'))).toHaveLength(1)
    })

    it('can be done again once the last has finished, as a job of its own', async () => {
      const first = await startOk()
      await stepToEnd()
      const second = await startOk()

      expect(second.id).toBeGreaterThan(first.id)
      expect(await reruns()).toMatchObject([{ status: 'done' }, { status: 'running' }])
    })

    it('finishes straight away when there are no Transactions', async () => {
      await env.DB.prepare('DELETE FROM transactions').run()
      expect(await startOk()).toMatchObject({ totalRows: 0 })

      expect(await stepOk()).toMatchObject({ status: 'done', doneRows: 0, changedRows: 0 })
    })
  })

  describe('stepping', () => {
    it('answers with where the job has got to when there is nothing to do', async () => {
      await startOk()
      const jobs = await stepToEnd()

      const res = await step()

      expect(res.status).toBe(200)
      expect(((await res.json()) as { job: Job }).job).toEqual(jobs.at(-1))
    })

    it('does not count a Transaction twice when steps overlap, and does not skip one', async () => {
      await saveRules()
      await startOk()

      await Promise.all([step(), step(), step()])
      const midway = (await reruns())[0] as { cursor: number; done_rows: number }

      // Whatever order they ran in, the job's count is the Transactions up to its cursor. (A chunk taken twice is counted once.)
      expect(midway.done_rows).toBe(await countWhere(`id <= ${midway.cursor}`))
      expect(midway.done_rows).toBeGreaterThanOrEqual(RERUN_CHUNK)
      const done = (await stepToEnd()).at(-1)!
      expect(done.doneRows).toBe(N)
      await expectSameAsFromScratch()
    })

    it('answers 429 when D1 says the daily allowance is used up, and the job stays where it was', async () => {
      await saveRules()
      await startOk()
      await stepOk()
      await env.DB.prepare("CREATE TRIGGER fail_rerun BEFORE UPDATE OF rule_id ON transactions BEGIN SELECT RAISE(ABORT, 'exceeded the daily rows written limit'); END").run()
      const before = { job: await reruns(), results: await stored() }
      try {
        const res = await step()
        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({ error: 'Daily limit reached' })
      } finally {
        await env.DB.prepare('DROP TRIGGER fail_rerun').run()
      }

      // Not the chunk's results and not its place in the job: both are saved together or neither is.
      expect(await reruns()).toEqual(before.job)
      expect(await stored()).toEqual(before.results)
      expect((await stepToEnd()).at(-1)).toMatchObject({ status: 'done', doneRows: N })
      await expectSameAsFromScratch()
    })

    it('copes with Transactions that were removed, leaving gaps in the IDs', async () => {
      await saveRules()
      await env.DB.prepare('DELETE FROM transactions WHERE id % 3 = 0 OR (id BETWEEN 1000 AND 1800)').run()
      const left = await countWhere('1 = 1')
      // The count would read every Transaction, so the job says the most there can be: the highest ID.
      expect(await startOk()).toMatchObject({ totalRows: N })

      const done = (await stepToEnd()).at(-1)!

      expect(done).toMatchObject({ status: 'done', totalRows: N, doneRows: left, percent: 100 })
      await expectSameAsFromScratch()
    })

    it('leaves Transactions added after it started to whatever added them', async () => {
      await saveRules()
      await startOk()
      await stepOk()
      // An Import's own Rules statement would give these their results; here they have none.
      await fill(100)

      const done = (await stepToEnd()).at(-1)!

      expect(done).toMatchObject({ status: 'done', totalRows: N, doneRows: N })
      expect(await countWhere(`id > ${N} AND rule_id IS NOT NULL`)).toBe(0)
    })

    it('takes a Rule whose Category was removed to be no Rule at all, and moves on to the next', async () => {
      const care = (await (await call('/api/categories', { method: 'POST', body: { name: 'Test Care Fees' } })).json()) as { id: number }
      await addRule({ textContains: 'FUEL', categoryId: care.id })
      const next = await addRule({ textContains: 'FUEL', categoryId: await categoryId('Fuel') })
      const fuelRows = await countWhere("description LIKE '%FUEL STOP%'")
      await startOk()
      await stepToEnd()
      expect(await countWhere(`rule_category = ${care.id}`)).toBe(fuelRows)

      await call(`/api/categories/${care.id}`, { method: 'DELETE', body: {} })
      await startOk()
      await stepToEnd()

      expect(await countWhere(`rule_category = ${care.id}`)).toBe(0)
      expect(await countWhere(`rule_id = ${next}`)).toBe(fuelRows)
    })
  })

  describe('while it runs, a change to the Rules sends it back to the start', () => {
    // The Transactions already looked at were given results by the Rules as they were. Finishing the walk would leave them
    // that way, so the job starts again from the first Transaction. Its place and counts go back to nothing; it stays one job.
    async function runningAfterOneChunk() {
      const rules = await saveRules()
      const job = await startOk()
      await stepOk()
      expect((await latest())!.doneRows).toBe(RERUN_CHUNK)
      return { rules, job }
    }
    const restarted = async (job: Job) => {
      expect(await latest()).toMatchObject({ id: job.id, status: 'running', doneRows: 0, changedRows: 0, restarts: 1, totalRows: N })
      expect(await reruns()).toMatchObject([{ id: job.id, cursor: 0, done_rows: 0, restarts: 1 }])
    }
    const finishesWithTheNewRules = async () => {
      expect((await stepToEnd()).at(-1)).toMatchObject({ status: 'done', doneRows: N, restarts: 1 })
      await expectSameAsFromScratch()
    }

    it('when a Rule is added', async () => {
      const { job } = await runningAfterOneChunk()
      await addRule({ textContains: 'MISC', categoryId: await categoryId('Other income') })
      await restarted(job)
      await finishesWithTheNewRules()
      expect(await countWhere('rule_category IS NOT NULL')).toBeGreaterThan(N / 2)
    })

    it('when a Rule is changed', async () => {
      const { job, rules } = await runningAfterOneChunk()
      await call(`/api/rules/${rules.fuel}`, { method: 'PUT', body: { textContains: 'POWER', categoryId: await categoryId('Fuel') } })
      await restarted(job)
      await finishesWithTheNewRules()
    })

    it('when a Rule is removed', async () => {
      const { job, rules } = await runningAfterOneChunk()
      await call(`/api/rules/${rules.supermarket}`, { method: 'DELETE', body: {} })
      await restarted(job)
      await finishesWithTheNewRules()
    })

    it('when the Rules are put in another order', async () => {
      const { job, rules } = await runningAfterOneChunk()
      await call('/api/rules/order', { method: 'PUT', body: { ids: [rules.supermarket, rules.supermarketOut, rules.fuel, rules.roundUp, rules.directDebit] } })
      await restarted(job)
      await finishesWithTheNewRules()
    })

    it('when the Category of a Rule is removed', async () => {
      const { job } = await runningAfterOneChunk()
      await call(`/api/categories/${await categoryId('Fuel')}`, { method: 'DELETE', body: {} })
      await restarted(job)
      await finishesWithTheNewRules()
    })

    it('counts the Transactions again, so one added before the change is part of the job', async () => {
      const { job } = await runningAfterOneChunk()
      await fill(100)
      await addRule({ textContains: 'MISC', categoryId: await categoryId('Other income') })

      expect(await latest()).toMatchObject({ id: job.id, totalRows: N + 100, doneRows: 0 })
      expect((await stepToEnd()).at(-1)).toMatchObject({ doneRows: N + 100 })
      await expectSameAsFromScratch()
    })

    it('but not when a Rule is saved as it was, the order is as it was, or a Category is renamed', async () => {
      const { job, rules } = await runningAfterOneChunk()
      await call(`/api/rules/${rules.fuel}`, { method: 'PUT', body: { textContains: ' FUEL ', categoryId: await categoryId('Fuel') } })
      await call('/api/rules/order', { method: 'PUT', body: { ids: [rules.supermarketOut, rules.fuel, rules.roundUp, rules.directDebit, rules.supermarket] } })
      await call(`/api/categories/${await categoryId('Travel')}`, { method: 'PATCH', body: { name: 'Trips' } })

      expect(await latest()).toMatchObject({ id: job.id, doneRows: RERUN_CHUNK, restarts: 0 })
    })

    it('does not write a Change Log entry of its own, or start another job', async () => {
      const { job, rules } = await runningAfterOneChunk()
      const before = (await changeLog()).length
      await call(`/api/rules/${rules.fuel}`, { method: 'DELETE', body: {} })

      const added = (await changeLog()).slice(before)
      expect(added).toMatchObject([{ summary: expect.stringMatching(/^Removed a Rule/), type: 'rule' }])
      expect(await reruns()).toHaveLength(1)
      expect((await latest())!.id).toBe(job.id)
    })

    it('does not start one when none is running, or open one that has finished', async () => {
      const rules = await saveRules()
      await addRule({ textContains: 'MISC', categoryId: await categoryId('Other income') })
      expect(await reruns()).toEqual([])

      await startOk()
      await stepToEnd()
      await call(`/api/rules/${rules.fuel}`, { method: 'DELETE', body: {} })

      expect(await reruns()).toMatchObject([{ status: 'done', restarts: 0 }])
    })

    it('is finished by a request that was already running when the Rules changed only with the new Rules', async () => {
      const { rules } = await runningAfterOneChunk()

      await Promise.all([step(), call(`/api/rules/${rules.fuel}`, { method: 'DELETE', body: {} }), step()])
      await stepToEnd()

      await expectSameAsFromScratch()
    })
  })

  describe("the job's own share of the day's rows", () => {
    // D1 Free's allowance is for the whole app, and when it is gone every request fails until 00:00 UTC. The job counts what D1 says each
    // step read and wrote and pauses before a chunk that would take it past its share (2.5 million reads, 40,000 writes), until the day changes.
    const today = () => utcDay(new Date())
    const setTally = (day: string | null, reads: number, writes: number) =>
      env.DB.prepare("UPDATE data_migration_progress SET usage_day = ?, day_rows_read = ?, day_rows_written = ? WHERE status = 'running'").bind(day, reads, writes).run()
    const tally = async () => (await env.DB.prepare('SELECT usage_day, day_rows_read, day_rows_written FROM data_migration_progress ORDER BY id DESC LIMIT 1').first<{ usage_day: string | null; day_rows_read: number; day_rows_written: number }>())!

    it('counts what each step reads and writes against today', async () => {
      await saveRules()
      await startOk()
      expect(await tally()).toEqual({ usage_day: null, day_rows_read: 0, day_rows_written: 0 })
      const { db, usage } = metered()

      await stepRerun(db)

      const counted = await tally()
      expect(counted.usage_day).toBe(today())
      // What D1 reported for the walk, the move and the end of the chunk: nearly all of what the step read (not the job's own few lookups).
      expect(counted.day_rows_read).toBeGreaterThan(usage.rowsRead * 0.9)
      expect(counted.day_rows_read).toBeLessThanOrEqual(usage.rowsRead)
      expect(counted.day_rows_written).toBeGreaterThan(0)
      expect(counted.day_rows_written).toBeLessThanOrEqual(usage.rowsWritten)

      await stepOk()
      expect((await tally()).day_rows_read).toBeGreaterThan(counted.day_rows_read) // added to, not started again
    })

    it.each([
      ['reads', DAILY_READ_BUDGET - 1, 0],
      ['writes', 0, DAILY_WRITE_BUDGET - 1],
    ])('pauses when the next chunk would pass its share of the day\'s %s, and does nothing while it is', async (_which, reads, writes) => {
      await saveRules()
      await startOk()
      await setTally(today(), reads, writes)
      const before = { transactions: await stored(), job: await reruns() }
      const { db, usage } = metered()

      const job = await stepRerun(db)

      expect(job).toMatchObject({ status: 'running', paused: true, doneRows: 0 })
      expect(usage).toEqual({ queries: 1, rowsRead: expect.any(Number), rowsWritten: 0 }) // it only looked at the job
      expect(usage.rowsRead).toBeLessThanOrEqual(10)
      expect(await stored()).toEqual(before.transactions)
      expect(await reruns()).toEqual(before.job)
      // The answer to the page is the same, and a Member reading it sees the job is waiting.
      const res = await step()
      expect(res.status).toBe(200)
      expect(((await res.json()) as { job: Job }).job).toMatchObject({ paused: true, doneRows: 0 })
      expect(await latest()).toMatchObject({ paused: true })
    })

    it('leaves a paused job alone on a cron run, for the one query it takes to look', async () => {
      await saveRules()
      await startOk()
      await setTally(today(), DAILY_READ_BUDGET - 1, 0)
      const { db, usage } = metered()

      await continueRerun(db)

      expect(usage).toMatchObject({ queries: 1, rowsWritten: 0 })
      expect((await latest())!.doneRows).toBe(0)
    })

    it('carries on when the day has changed, from the next step or cron run, and starts counting again', async () => {
      await saveRules()
      await startOk()
      await setTally('2020-01-01', DAILY_READ_BUDGET, DAILY_WRITE_BUDGET) // all of another day's share, which is no concern of today's
      expect(await latest()).toMatchObject({ paused: false })

      const job = await stepOk()

      expect(job).toMatchObject({ paused: false, doneRows: RERUN_CHUNK })
      const counted = await tally()
      expect(counted.usage_day).toBe(today())
      expect(counted.day_rows_read).toBeLessThan(DAILY_READ_BUDGET / 10) // only this step's

      await setTally('2020-01-01', DAILY_READ_BUDGET, DAILY_WRITE_BUDGET)
      await cron()
      expect((await latest())!.doneRows).toBeGreaterThan(RERUN_CHUNK)
    })

    it('pauses part way through the day when what is left is less than a chunk, and finishes with the right result the next day', async () => {
      await saveRules()
      await startOk()
      await setTally(today(), DAILY_READ_BUDGET - ESTIMATED_STEP_READS - 2_000, 0) // room for one step (estimated at 30,000 reads) and not for a second after it has read what it reads

      const first = await stepOk()
      const second = await stepOk()

      expect(first).toMatchObject({ doneRows: RERUN_CHUNK, paused: true })
      expect(second).toMatchObject({ doneRows: RERUN_CHUNK, paused: true, status: 'running' }) // nothing more happened
      expect((await tally()).day_rows_read).toBeLessThan(DAILY_READ_BUDGET) // so it never took the day's allowance past its share

      await setTally('2020-01-01', DAILY_READ_BUDGET, DAILY_WRITE_BUDGET) // the next day
      const done = (await stepToEnd()).at(-1)!

      expect(done).toMatchObject({ status: 'done', doneRows: N, percent: 100 })
      await expectSameAsFromScratch()
    })

    it.each([0, 1, 14, 15, 16, 30, 60, MAX_RULES])('is sized the same in SQL (where the step works it out) and in the page\'s numbers, with %i Rules', async (rules) => {
      const groceries = await categoryId('Groceries')
      if (rules > 0) await env.DB.batch(Array.from({ length: rules }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 1, `NO SUCH SHOP ${i}`, groceries)))
      const started = await startOk()
      expect(started.stepRows).toBe(chunkFor(rules))

      const job = await stepOk()

      expect(job.doneRows).toBe(Math.min(chunkFor(rules), N)) // what the step looked at, as SQL sized it
      expect(chunkFor(rules)).toBeGreaterThanOrEqual(MIN_CHUNK)
      expect(chunkFor(rules)).toBeLessThanOrEqual(RERUN_CHUNK)
    })

    it('is sized to the Rules: fewer Transactions in a step when there are many, so a step is about the same reads', async () => {
      const groceries = await categoryId('Groceries')
      await env.DB.batch(Array.from({ length: MAX_RULES }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 1, `NO SUCH SHOP ${i}`, groceries)))
      const started = await startOk()
      expect(started.stepRows).toBe(chunkFor(MAX_RULES))
      expect(started.cronRowsPerDay).toBe(2 * CRON_CHUNKS * started.stepRows)

      const job = await stepOk()

      expect(job.doneRows).toBe(chunkFor(MAX_RULES))
      expect(job.doneRows).toBeLessThan(RERUN_CHUNK)
    })
  })

  describe('ending the job', () => {
    // Whichever request ends a job writes its entry, and only that one: not a second request that found the same job at its end, and not a
    // request that read the job at its end before the Rules changed under it or it was stopped.
    async function atItsEnd() {
      await saveRules()
      await startOk()
      await env.DB.prepare("UPDATE data_migration_progress SET cursor = end_id, done_rows = total_rows WHERE status = 'running'").run()
    }
    const finishes = async () => (await changeLog()).filter((e) => String(e.summary).startsWith('Finished applying'))

    it('is recorded once, however many requests find it at its end together', async () => {
      await atItsEnd()

      const answers = await Promise.all([step(), step(), step(), step()])

      expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200])
      expect(await latest()).toMatchObject({ status: 'done' })
      expect(await finishes()).toHaveLength(1)
    })

    it('is recorded once from the cron and a request together', async () => {
      await atItsEnd()

      await Promise.all([step(), cron(), step()])

      expect(await finishes()).toHaveLength(1)
    })

    it('is not recorded, and the job is not ended, when the Rules changed after the request read it', async () => {
      await atItsEnd()
      const { db } = metered(env.DB, { beforeBatch: async () => void (await restartRerun(env.DB).run()) }) // what a change to a Rule does, in the same batch as the change

      const job = await stepRerun(db)

      expect(job).toMatchObject({ status: 'running', doneRows: 0, restarts: 1 })
      expect(await finishes()).toEqual([])
      // It is not lost: the job goes on from the start, and ends once when it gets to the end.
      await stepToEnd()
      expect(await finishes()).toHaveLength(1)
    })

    it('is not recorded when the Admin stopped the job after the request read it, and the stop is recorded once', async () => {
      await atItsEnd()
      const { db } = metered(env.DB, { beforeBatch: async () => void (await stop()) })

      const job = await stepRerun(db)

      expect(job).toMatchObject({ status: 'stopped' })
      expect(await finishes()).toEqual([])
      expect((await changeLog()).filter((e) => String(e.summary).startsWith('Stopped applying'))).toHaveLength(1)
    })
  })

  describe('stopping', () => {
    it('ends the job, writes one entry with the counts, and leaves the results it had given', async () => {
      await saveRules()
      await startOk()
      const first = await stepOk()
      const before = (await changeLog()).length

      const res = await stop()

      expect(res.status).toBe(200)
      const { job } = (await res.json()) as { job: Job }
      expect(job).toMatchObject({ status: 'stopped', doneRows: RERUN_CHUNK, changedRows: first.changedRows, percent: expect.any(Number) })
      expect(job.finishedAt).not.toBeNull()
      expect((await changeLog()).slice(before)).toMatchObject([
        { summary: `Stopped applying the Rules to all Transactions: 1,000 looked at, ${first.changedRows.toLocaleString('en-NZ')} updated`, type: 'rule', actor: 'admin@example.com' },
      ])
      expect(await countWhere(`id <= ${RERUN_CHUNK} AND rule_id IS NOT NULL`)).toBeGreaterThan(0)
      expect(await countWhere(`id > ${RERUN_CHUNK} AND rule_id IS NOT NULL`)).toBe(0)
    })

    it('is followed by steps and cron runs that do nothing, and a change to the Rules that does not bring it back', async () => {
      const rules = await saveRules()
      await startOk()
      await stepOk()
      await stop()
      const before = await stored()

      expect(await stepOk()).toMatchObject({ status: 'stopped', doneRows: RERUN_CHUNK })
      await cron()
      await call(`/api/rules/${rules.fuel}`, { method: 'DELETE', body: {} })

      expect(await latest()).toMatchObject({ status: 'stopped', doneRows: RERUN_CHUNK, restarts: 0 })
      expect(await stored()).toEqual(before)
    })

    it('can be followed by a new run, which starts from the first Transaction', async () => {
      await saveRules()
      await startOk()
      await stepOk()
      await stop()

      const next = await startOk()

      expect(next).toMatchObject({ status: 'running', doneRows: 0 })
      expect((await stepToEnd()).at(-1)).toMatchObject({ status: 'done', doneRows: N })
      await expectSameAsFromScratch()
    })

    it('writes no entry when the job ended between the request reading it and stopping it', async () => {
      await saveRules()
      await startOk()
      const entries = (await changeLog()).length
      const { db } = metered(env.DB, { beforeBatch: async () => void (await env.DB.prepare("UPDATE data_migration_progress SET status = 'done', finished_at = '2026-10-11T00:00:00.000Z' WHERE status = 'running'").run()) })

      expect(await stopRerun(db, { email: 'admin@example.com', role: 'admin' })).toBeNull()

      expect(await changeLog()).toHaveLength(entries) // not "Stopped" for a job that had already ended
      expect(await latest()).toMatchObject({ status: 'done' })
    })

    it('is refused when no job is running, writing nothing', async () => {
      const entries = (await changeLog()).length
      let res = await stop()
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'No re-run is in progress' })

      await startOk()
      await stepToEnd() // ended: a stop that arrives now has nothing to stop
      const afterwards = (await changeLog()).length
      res = await stop()
      expect(res.status).toBe(409)
      expect(await changeLog()).toHaveLength(afterwards)
      expect(afterwards).toBeGreaterThan(entries)
    })
  })

  describe('what a changed Transaction costs in writes', () => {
    // D1 bills every table row and index entry written. A Transaction's result is on its row, and its Category is in the rule_category
    // index too (migration 1402), so the writes for one Transaction are: a Transfer mark 1 (the row), a Category it did not have 2 (the row
    // and an index entry), and a Category that changes to another 2 in the local database (the row, and its index entry changed). D1 may
    // bill that entry as a delete and an insert, which would be 3, so the day's budget counts 3 for every changed Transaction
    // (ESTIMATED_WRITES_PER_ROW). The README says the same.
    it('is 1 for a Transfer mark, 2 for a Category, and 2 (counted as 3 against the day) for a change from one Category to another', async () => {
      const writesOfTheFirstStep = async () => {
        const { db, usage } = metered()
        await stepRerun(db)
        const written = usage.rowsWritten
        await stop() // so the next run can start; the stop does not count
        return written
      }
      const inFirstChunk = (where: string) => countWhere(`id <= ${RERUN_CHUNK} AND ${where}`)
      // The job's own bookkeeping (its place, its tally) is a few writes in each step.
      const perRow = (written: number, rows: number) => Math.round((written - 4) / rows)

      await addRule({ textContains: 'ROUND UP', transfer: true })
      await startOk()
      const transfers = await writesOfTheFirstStep()
      const transferRows = await inFirstChunk('rule_transfer = 1')
      expect(transferRows).toBeGreaterThan(100)
      expect(perRow(transfers, transferRows)).toBe(1)

      const misc = await addRule({ textContains: 'MISC', categoryId: await categoryId('Groceries') })
      await startOk()
      const gained = await writesOfTheFirstStep()
      const gainedRows = await inFirstChunk('rule_category IS NOT NULL')
      expect(gainedRows).toBeGreaterThan(100)
      expect(perRow(gained, gainedRows)).toBe(2)

      await call(`/api/rules/${misc}`, { method: 'PUT', body: { textContains: 'MISC', categoryId: await categoryId('Fuel') } })
      await startOk()
      const moved = await writesOfTheFirstStep()
      expect(perRow(moved, gainedRows)).toBe(2)
      expect(ESTIMATED_WRITES_PER_ROW).toBe(3)
    })

    it('is counted as 3 for every Transaction in a chunk when the job decides whether the chunk fits in the day', async () => {
      await saveRules()
      await startOk()
      const chunk = RERUN_CHUNK * ESTIMATED_WRITES_PER_ROW

      await env.DB.prepare("UPDATE data_migration_progress SET usage_day = ?, day_rows_written = ? WHERE status = 'running'").bind(utcDay(new Date()), DAILY_WRITE_BUDGET - chunk + 1).run()
      expect(await latest()).toMatchObject({ paused: true })

      await env.DB.prepare("UPDATE data_migration_progress SET day_rows_written = ? WHERE status = 'running'").bind(DAILY_WRITE_BUDGET - chunk).run()
      expect(await latest()).toMatchObject({ paused: false })
    })
  })

  describe('on a cron run', () => {
    it('carries on a running job by a few chunks, and does nothing when there is none', async () => {
      await cron()
      expect(await reruns()).toEqual([])

      await saveRules()
      await fill(CRON_CHUNKS * RERUN_CHUNK) // more than a cron run does
      await startOk()
      await cron()
      expect(await latest()).toMatchObject({ status: 'running', doneRows: CRON_CHUNKS * RERUN_CHUNK })
    })

    it('finishes it, and records the finish for the Admin who started it', async () => {
      await saveRules()
      await startOk()
      const before = (await changeLog()).length
      for (let i = 0; i < 4 && (await latest())!.status === 'running'; i++) await cron()

      expect(await latest()).toMatchObject({ status: 'done', doneRows: N })
      expect((await changeLog()).slice(before)).toMatchObject([{ summary: expect.stringMatching(/^Finished applying the Rules/), type: 'rule', actor: 'admin@example.com' }])
      await expectSameAsFromScratch()
    })

    it('stops quietly when D1 says the daily allowance is used up, and carries on the next day', async () => {
      await saveRules()
      await startOk()
      await env.DB.prepare("CREATE TRIGGER fail_rerun BEFORE UPDATE OF rule_id ON transactions BEGIN SELECT RAISE(ABORT, 'exceeded the daily rows written limit'); END").run()
      try {
        await cron()
      } finally {
        await env.DB.prepare('DROP TRIGGER fail_rerun').run()
      }
      expect(await latest()).toMatchObject({ status: 'running', doneRows: 0 })

      await cron(env, new Date('2026-10-13T18:00:00Z'))
      expect((await latest())!.doneRows).toBeGreaterThan(0)
    })
  })

  describe('a Member', () => {
    it('can see how far it has got', async () => {
      const job = await startOk()
      const res = await call('/api/rules/rerun', { who: 'member' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ job })
    })

    it('is refused when not signed in', async () => {
      expect((await exports.default.fetch(new Request('https://app.test/api/rules/rerun'))).status).toBe(401)
      expect((await exports.default.fetch(new Request('https://app.test/api/rules/rerun', { method: 'POST' }))).status).toBe(401)
    })

    // Each case is refused with 403 and leaves the job, the Transactions and the Change Log exactly as they were.
    // Take the Admin guard out of worker/app.ts and each of these changes something, so each of these fails.
    it.each([
      ['start a re-run', false, '/api/rules/rerun'],
      ['do a step of one', true, '/api/rules/rerun/step'],
      ['stop one', true, '/api/rules/rerun/stop'],
    ])('cannot %s', async (_what, running, path) => {
      await saveRules()
      if (running) await startOk()
      const snapshot = async () => ({ jobs: await reruns(), transactions: await stored(), changeLog: await changeLog() })
      const before = await snapshot()

      const res = await call(path, { who: 'member', method: 'POST', body: {} })

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Read-only' })
      expect(await snapshot()).toEqual(before)
    })
  })
})
