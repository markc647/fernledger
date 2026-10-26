import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARGE_FROM_ROWS, chargeFor, countingReads, dearReads, HOLD_EXPIRY_MS, MEMBER_BUSY, MEMBER_MAX_IN_FLIGHT, OFFSET_FROM, pageRows, readsPerTransaction, EACH_MEMBER_DAILY_READS, MEMBER_DAILY_READS, MEMBER_LIMIT_REACHED, memberKey } from './member-read-limit'
import worker from './index'
import { utcDay } from './rule-rerun'

const origin = 'http://localhost:5173'
// 'member' signs in as dev.member@example.com; 'other' as DEV_USER_EMAIL, which is not the Admin, so a second Member.
type Who = 'admin' | 'member' | 'other'
const EMAIL = { member: 'dev.member@example.com', other: 'dev@example.com' }

describe("a Member's key", () => {
  it('is the same for the same day, email and secret, and differs with the secret', async () => {
    const day = '2026-10-26'
    expect(await memberKey(day, EMAIL.member, 'secret-one')).toBe(await memberKey(day, EMAIL.member, 'secret-one'))
    expect(await memberKey(day, EMAIL.member, 'secret-one')).not.toBe(await memberKey(day, EMAIL.member, 'secret-two'))
    expect(await memberKey(day, EMAIL.member, 'secret-one')).not.toBe(await memberKey(day, EMAIL.member))
    // HMAC-SHA-256 of the same text, worked out apart from the code: Node's createHmac('sha256', 'secret-one').update(`2026-10-26\n${EMAIL.member}`).
    expect(await memberKey(day, EMAIL.member, 'secret-one')).toBe('f30df655f8b147606b32bc119b193d188dd39e1f8f6a73c8a1870eca1e1d41df')
  })

  it('is the plain hash of the day and email without a secret, as before the secret', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`2026-10-26\n${EMAIL.member}`)))
    expect(await memberKey('2026-10-26', EMAIL.member)).toBe([...digest].map((b) => b.toString(16).padStart(2, '0')).join(''))
  })
})

const call = (path: string, who: Who) => exports.default.fetch(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }))

const today = () => utcDay(new Date())
const usage = async () => (await env.DB.prepare('SELECT member_key, usage_day, rows_read FROM member_read_usage ORDER BY member_key').all()).results
/** What counts towards a Member's limit today: what they were charged and what they still hold. */
const charged = async (who: 'member' | 'other') =>
  (await env.DB.prepare('SELECT rows_read + held AS counted FROM member_read_usage WHERE member_key = ?').bind(await memberKey(today(), EMAIL[who])).first<{ counted: number }>())?.counted ?? 0
const seed = (key: string, day: string, rows: number) => env.DB.prepare('INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?, ?, ?)').bind(key, day, rows).run()

// A cheap read (the Categories, a few dozen rows) and a dear one (net worth reads every Transaction several times; ADR 0004).
const CHEAP = '/api/categories'
const DEAR = '/api/charts/net-worth?range=all'
const TRANSACTIONS = 1_200 // more than one chunk of the CSV export (EXPORT_CHUNK_ROWS), so its sizing is measured
const YEAR = { from: '2025-10-01', to: '2026-09-30' } // the dates the Transactions below are in
// Every dear route, as a Member would ask it, with its reads for each Transaction.
const DEAR_ROUTES = [
  { path: DEAR, perTransaction: 10 },
  { path: `/api/charts/spending?from=${YEAR.from}&to=${YEAR.to}`, perTransaction: 5 },
  { path: '/api/transactions?sort=amount', perTransaction: 9 },
  { path: '/api/transactions?text=NOTHING-MATCHES', perTransaction: 5 }, // every row tested, none found
  // Uncategorised matches nothing here (every Transaction has a Rule's Category), so the date index is walked to the end with every join:
  // the case of a filter few match. Transfers and the Category match a fifth and a half, so their pages are found early.
  { path: '/api/transactions?count=false&uncategorised=true', perTransaction: 5 },
  { path: '/api/transactions?count=false&transfers=only', perTransaction: 5 },
  { path: '/api/transactions?uncategorised=true', perTransaction: 7 },
  { path: `/api/transactions/export.csv?from=${YEAR.from}&to=${YEAR.to}`, perTransaction: 12 },
  { path: `/api/reports/spending?from=${YEAR.from}&to=${YEAR.to}`, perTransaction: 5 },
  { path: `/api/reports/income-vs-spending?from=${YEAR.from}&to=${YEAR.to}`, perTransaction: 5 },
  { path: `/api/reports/loans?categoryId=LOANS&to=${YEAR.to}`, perTransaction: 11 },
  { path: `/api/reports/balances?accountId=ACCOUNT&from=${YEAR.from}&to=${YEAR.to}`, perTransaction: 9 },
  { path: `/api/reports/budget-vs-actual?from=${YEAR.from}&to=${YEAR.to}`, perTransaction: 5 },
  { path: '/api/budgets/vs-actual?month=2026-03', perTransaction: 4 },
  { path: '/api/balances', perTransaction: 2 },
  { path: '/api/balances/ACCOUNT/history', perTransaction: 7 },
  { path: '/api/imports/imported/ACCOUNT', perTransaction: 2 },
  { path: '/api/transactions?count=false&categoryId=CATEGORY', perTransaction: 5 },
  { path: '/api/transactions?count=false&sort=amount', perTransaction: 7 },
  { path: '/api/transactions?count=false&text=NOTHING-MATCHES', perTransaction: 3 },
  { path: '/api/transactions?count=only', perTransaction: 2 },
]
/** The hold a dear request reserves: its reads for each Transaction times the highest Transaction ID (the count here, as beforeEach starts the IDs again). */
const holdOf = async (perTransaction: number) =>
  perTransaction * (await env.DB.prepare('SELECT MAX(id) AS id FROM transactions').first<{ id: number }>())!.id

/** The Worker's own handler, called with `db` standing in for D1 (CODING_STANDARDS.md: Tests), as `who`. */
async function fetchWith(db: D1Database, path: string, who: Who, more: Partial<Env> = {}) {
  const ctx = createExecutionContext()
  const res = await worker.fetch!(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }) as never, { ...env, ...more, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
/**
 * What the Reports need to read their most: a balance check for balance history, a Budget, and half the Transactions given the Loans
 * Category. Gives back what turns a path's ACCOUNT and LOANS into those IDs.
 */
async function historyForReports() {
  // Every join a read can make, populated, since each costs a read a row: a Rule's Category on every Transaction, an Override on half (a Loans
  // Category, so the Loans Report has a loan), a fifth of them in Transfer pairs across two Accounts, a balance check on each Account, a Budget,
  // and a Change Log as long as the Transactions.
  await env.DB.prepare("INSERT INTO accounts (name, account_number) VALUES ('Example savings', '99-9999-9999999-98')").run()
  const ids = (await env.DB.prepare(
    `SELECT (SELECT MIN(id) FROM accounts) AS account, (SELECT MAX(id) FROM accounts) AS other,
       (SELECT id FROM categories WHERE kind = 'loans' ORDER BY id LIMIT 1) AS loans,
       (SELECT id FROM categories WHERE kind = 'spending' ORDER BY id LIMIT 1) AS spending,
       (SELECT id FROM categories WHERE kind = 'spending' ORDER BY id LIMIT 1 OFFSET 1) AS ruled`,
  ).first<{ account: number; other: number; loans: number; spending: number; ruled: number }>())!
  const rule = (await env.DB.prepare("INSERT INTO rules (position, text_contains, category_id) VALUES (1, 'EXAMPLE', ?) RETURNING id").bind(ids.ruled).first<{ id: number }>())!.id
  await env.DB.batch([
    env.DB.prepare('UPDATE transactions SET rule_id = ?1, rule_category = ?2, override_category = CASE WHEN id % 2 = 0 THEN ?3 END').bind(rule, ids.ruled, ids.loans),
    env.DB.prepare('UPDATE transactions SET account_id = ?1, amount_cents = 100 WHERE id % 10 = 1').bind(ids.other),
    env.DB.prepare('UPDATE transactions SET transfer_of = CASE WHEN id % 10 = 0 THEN id + 1 ELSE id - 1 END WHERE id % 10 IN (0, 1) AND id > 1 AND id < (SELECT MAX(id) FROM transactions)'),
    ...[ids.account, ids.other].map((account) =>
      env.DB.prepare("INSERT INTO balance_checks (account_id, as_of_date, bank_cents, source, through_transaction_id, status) VALUES (?1, '2025-10-02', 123456, 'import', (SELECT MIN(id) FROM transactions WHERE account_id = ?1), 'alone')").bind(account), // long before, so the current balances read every Transaction after it
    ),
    env.DB.prepare("INSERT INTO budgets (category_id, effective_from_month, amount_cents) VALUES (?1, '2025-10', 50000)").bind(ids.spending),
    env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
       INSERT INTO change_log (actor, type, summary) SELECT 'admin@example.com', 'transaction', 'Changed EXAMPLE ' || i FROM seq`,
    ),
  ])
  return (path: string) => path.replace('ACCOUNT', String(ids.account)).replace('LOANS', String(ids.loans)).replace('CATEGORY', String(ids.ruled))
}

/** D1 whose charges (a cheap request's and a dear one's settling, which share their VALUES) fail, as when D1's daily writes are gone. */
const failingCharges = () =>
  withDb((target, sql) =>
    /^(INSERT INTO member_read_usage \(member_key, usage_day, rows_read\) VALUES|UPDATE member_read_usage|INSERT INTO member_read_usage \(member_key, usage_day, rows_read, held, held_count\)\s+SELECT \?2)/.test(sql)
      ? ({ bind: () => ({ run: () => Promise.reject(new Error('D1 is full')) }) } as never)
      : target.prepare(sql),
  )

/**
 * D1 that holds back net worth's histories (one batch) until `release`, so requests can be kept in flight: `reserved` counts the requests
 * that got as far as that batch, which is after the limit has let them in.
 */
function heldBack() {
  const state = { reserved: 0, release: () => {} }
  const gate = new Promise<void>((resolve) => (state.release = resolve))
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => (state.reserved++, await gate, target.batch(statements))
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db, state }
}

/** D1 whose `prepare` goes through `prepare(target, sql)`. */
const withDb = (prepare: (target: D1Database, sql: string) => D1PreparedStatement) =>
  new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => prepare(target, sql)
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

// The draw a small read is charged by. Mulberry32, so a seeded run gives the same draws every time.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
}
const drawWith = (next: () => number) =>
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((words: Uint32Array) => {
    for (let i = 0; i < words.length; i++) words[i] = next()
    return words
  }) as never)
const NEVER = 0xffffffff // a draw no small read is charged on

afterEach(() => vi.restoreAllMocks())

beforeEach(async () => {
  drawWith(() => NEVER) // so a test that does not draw on purpose sees no small read charged
  await env.DB.batch([
    env.DB.prepare('UPDATE member_read_usage SET held = 0'), // so 5002's trigger lets the rows go
    ...['member_read_usage', 'kept_reports', 'budgets', 'balance_checks', 'transactions', 'rules', 'change_log', 'accounts'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'transactions'"), // so the highest ID is the count, as in a database never cleared
  ])
  await env.DB.prepare("INSERT INTO accounts (name, account_number) VALUES ('Example everyday', '99-9999-9999999-99')").run()
  await env.DB.prepare(
    `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
     INSERT INTO transactions (account_id, date, amount_cents, description, source)
     SELECT (SELECT id FROM accounts), date('2025-10-01', '+' || (i % 365) || ' days'), -100, 'EXAMPLE ' || i, 'import' FROM seq`,
  ).run()
})

describe('counting a Member\'s reads', () => {
  it('adds up the rows D1 reports for each way a statement can be run', async () => {
    const sql = 'SELECT id, description FROM transactions WHERE amount_cents < ?'
    const direct = (await env.DB.prepare(sql).bind(0).all()).meta.rows_read
    expect(direct).toBeGreaterThan(0)
    const tally = { rows: 0 }
    const db = countingReads(env.DB, tally)

    const all = await db.prepare(sql).bind(0).all()
    const first = await db.prepare(sql).bind(0).first<{ id: number }>()
    const column = await db.prepare(sql).bind(0).first<number>('id')
    const raw = await db.prepare(sql).bind(0).raw({ columnNames: true })
    await db.prepare(sql).bind(0).run()
    await db.batch([db.prepare(sql).bind(0), db.prepare(sql).bind(0)])

    expect(tally.rows).toBe(direct * 7)
    expect(first).toEqual(all.results[0])
    expect(column).toBe(first!.id)
    expect(raw[0]).toEqual(['id', 'description'])
    expect(raw).toHaveLength(all.results.length + 1)
  })
})

describe('the migration and the Worker', () => {
  it('take holds as spent at the same age', () => {
    const migration = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS.find((m) => m.name.startsWith('5002_'))!
    expect(migration.queries.join('\n')).toContain(`- ${HOLD_EXPIRY_MS}`)
  })
})

describe('which requests are dear', () => {
  it('holds by the reads for each Transaction for net worth, the other charts and a Transaction list that searches, sorts or counts', () => {
    const per = (path: string, query = '') => readsPerTransaction(path, new URLSearchParams(query))

    const dear = (path: string, query = '') => per(path, query) > 0
    for (const path of ['/api/charts/net-worth', '/api/charts/spending', '/api/transactions/export.csv', '/api/reports/spending', '/api/reports/loans', '/api/reports/balances', '/api/budgets/vs-actual', '/api/balances', '/api/balances/7/history', '/api/imports/imported/7']) {
      expect(dear(path), path).toBe(true)
    }
    for (const path of ['/api/categories', '/api/transactions/pending', '/api/reports/transactions', '/api/budgets', '/api/balances/7', '/api/imports/imported']) expect(dear(path), path).toBe(false)
    // The list: dear when it searches, sorts by other than date, counts (the first page does) or filters by Category or Transfer.
    expect(dear('/api/transactions')).toBe(true) // the first page counts
    expect(dear('/api/transactions', 'offset=00')).toBe(true) // the route reads it as the first page
    expect(dear('/api/transactions', 'offset=200')).toBe(false)
    expect(dear('/api/transactions', 'count=false')).toBe(false)
    expect(dear('/api/transactions', 'count=false&text=%20%20')).toBe(false)
    expect(dear('/api/transactions', 'sort=date&offset=200')).toBe(false)
    expect(dear('/api/transactions', 'count=false&accountId=1')).toBe(false) // an Account's own index
    for (const query of ['count=only', 'count=false&text=EXAMPLE', 'count=false&sort=amount', 'count=false&uncategorised=true', 'count=false&categoryId=3', 'count=false&transfers=only']) {
      expect(dear('/api/transactions', query), query).toBe(true)
    }
    // Its parts add up.
    expect(per('/api/transactions', 'sort=amount&text=EXAMPLE')).toBe(per('/api/transactions', 'count=false&sort=amount') + per('/api/transactions', 'count=false&text=EXAMPLE') + per('/api/transactions', 'count=only'))
    // A chart or Report not in the list is held as the dearest.
    for (const path of DEAR_ROUTES.map((r) => new URL(r.path, origin).pathname).filter((p) => p !== '/api/transactions')) expect(per('/api/reports/some-new-report')).toBeGreaterThanOrEqual(per(path))
    expect(per('/api/charts/some-new-chart')).toBe(per('/api/reports/some-new-report'))
    expect(dearReads('/api/change-log', new URLSearchParams()).perEntry).toBeGreaterThan(0)
  })

  // Every dear route's reads, measured, are within its reads for each Transaction times the number of Transactions (not the highest ID, which
  // only makes a hold larger): otherwise requests sent together could pass a limit by the difference.
  it.each(DEAR_ROUTES.map((r) => [r.path, r.perTransaction]))('holds enough for %s', async (path, perTransaction) => {
    const url = new URL((await historyForReports())(path), origin)
    const tally = { rows: 0 }
    const res = await fetchWith(countingReads(env.DB, tally), url.pathname + url.search, 'admin')

    expect(res.status, await res.clone().text()).toBe(200)
    expect(readsPerTransaction(url.pathname, url.searchParams)).toBe(perTransaction)

    expect(tally.rows).toBeGreaterThan(TRANSACTIONS / 4) // it read the seeded history, not an empty answer
    expect(tally.rows).toBeLessThanOrEqual(perTransaction * TRANSACTIONS)
  })

  it('holds enough for the Change Log, by its own size', async () => {
    await historyForReports()
    const tally = { rows: 0 }
    const res = await fetchWith(countingReads(env.DB, tally), '/api/change-log', 'admin')
    const entries = (await env.DB.prepare('SELECT COUNT(*) AS n FROM change_log').first<{ n: number }>())!.n

    expect(res.status).toBe(200)
    expect(dearReads('/api/change-log', new URLSearchParams())).toEqual({ perTransaction: 0, perEntry: 3 })

    expect(tally.rows).toBeGreaterThan(entries)
    expect(tally.rows).toBeLessThanOrEqual(3 * entries)
  })
})

describe('a Transaction list page far in', () => {
  const rows = (path: string, query = '') => pageRows(path, new URLSearchParams(query)).rows
  const FAR = `/api/transactions?count=false&offset=${OFFSET_FROM}&limit=200`

  it('counts the rows it skips and shows, from OFFSET_FROM on, read as the route reads them', () => {
    expect(rows('/api/transactions', `offset=${OFFSET_FROM - 1}`)).toBe(0)
    expect(rows('/api/transactions', `offset=${OFFSET_FROM}`)).toBe(OFFSET_FROM + 50) // the default page
    expect(rows('/api/transactions', 'offset=1000&limit=200')).toBe(1_200)
    expect(rows('/api/transactions', 'offset=1000&limit=5000')).toBe(1_200) // the route's largest page is 200
    expect(rows('/api/transactions', 'offset=01000')).toBe(1_050)
    expect(rows('/api/transactions', 'offset=lots')).toBe(0) // the route refuses it, reading nothing
    expect(rows('/api/transactions', 'offset=1e3')).toBe(0)
    expect(rows('/api/transactions', 'offset=Infinity')).toBe(0)
    expect(rows('/api/transactions', 'offset=1000&limit=0')).toBe(1_001) // the route's smallest page is 1
    expect(rows('/api/transactions/export.csv', 'offset=5000')).toBe(0)
  })

  // Measured as in 'holds enough': the page reads within 2 for each row it skips and shows, the offset capped at the Transactions there are.
  it.each([FAR, '/api/transactions?count=false&offset=1100&limit=100', '/api/transactions?count=false&offset=5000&limit=200'])('holds enough for %s', async (path) => {
    await historyForReports() // every join populated
    const url = new URL(path, origin)
    const tally = { rows: 0 }
    const res = await fetchWith(countingReads(env.DB, tally), path, 'admin')
    const page = pageRows(url.pathname, url.searchParams)

    expect(res.status).toBe(200)
    expect(tally.rows).toBeGreaterThan(OFFSET_FROM / 2) // it walked the rows, not an empty answer

    expect(tally.rows).toBeLessThanOrEqual(7 * Math.min(page.rows, TRANSACTIONS + page.limit))
    expect(tally.rows).toBeGreaterThan(Math.min(page.rows, TRANSACTIONS)) // so a hold of 1 a row would fall short
  })

  it('caps the hold at a page past the last Transaction, so a huge offset holds no more than it can read', async () => {
    expect((await fetchWith(failingCharges(), '/api/transactions?count=false&offset=999999999', 'member')).status).toBe(200)
    expect(await charged('member')).toBe(7 * (TRANSACTIONS + 50)) // the hold, kept as the settling failed: a page past the last row
  })

  it('lets at most one past a limit when they are sent together', async () => {
    await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS - 1)

    const statuses = await Promise.all(Array.from({ length: 8 }, () => fetchWith(env.DB, FAR, 'member').then((res) => res.status)))

    expect(statuses.filter((status) => status === 200)).toHaveLength(1)
    expect(statuses.filter((status) => status === 429)).toHaveLength(7)
  })

})

describe('charging a small read by chance', () => {
  it('charges what was read from CHARGE_FROM_ROWS up, and below it CHARGE_FROM_ROWS or nothing, so the same on average', () => {
    drawWith(seeded(1))
    expect(chargeFor(CHARGE_FROM_ROWS)).toBe(CHARGE_FROM_ROWS)
    expect(chargeFor(54_321)).toBe(54_321)
    expect(chargeFor(0)).toBe(0)

    const charges = Array.from({ length: 20_000 }, () => chargeFor(50))
    expect(new Set(charges)).toEqual(new Set([0, CHARGE_FROM_ROWS]))
    const total = charges.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(20_000 * 50 * 0.9) // 1,000,000 expected
    expect(total).toBeLessThan(20_000 * 50 * 1.1)
  })

  it('draws with crypto.getRandomValues', () => {
    drawWith(() => 0) // the lowest draw charges any read of a row or more
    expect(chargeFor(1)).toBe(CHARGE_FROM_ROWS)
    drawWith(() => NEVER)
    expect(chargeFor(CHARGE_FROM_ROWS - 1)).toBe(0)
  })
})

describe('the Members\' daily limit', () => {
  it('neither counts nor limits a Member on the Paid plan, and writes nothing', async () => {
    await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS) // past the limit
    const before = await usage()
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cloudflare_plan', 'paid')").run()
    try {
      for (const path of [DEAR, CHEAP]) expect((await call(path, 'member')).status, path).toBe(200)
      expect(await usage()).toEqual(before) // nothing held, settled or charged
    } finally {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'cloudflare_plan'").run()
    }
    expect((await call(DEAR, 'member')).status).toBe(429) // back on Free, the limit holds again
  })

  it('keeps the count under the HMAC of MEMBER_KEY_SECRET when the Worker has it, and goes on counting under it', async () => {
    const secret = 'member_key_example'
    expect((await fetchWith(env.DB, DEAR, 'member', { MEMBER_KEY_SECRET: secret })).status).toBe(200)
    const rows = await usage()
    expect(rows.map((row) => row.member_key)).toEqual([await memberKey(today(), EMAIL.member, secret)])
    expect(rows[0]!.member_key).not.toBe(await memberKey(today(), EMAIL.member)) // not the plain hash a backup's reader could work out

    expect((await fetchWith(env.DB, DEAR, 'member', { MEMBER_KEY_SECRET: secret })).status).toBe(200)
    expect(await usage()).toHaveLength(1)
  })

  it('charges a Member\'s request that read at least CHARGE_FROM_ROWS, and writes nothing for a cheaper one the draw passes over', async () => {
    for (let i = 0; i < 100; i++) expect((await call(CHEAP, 'member')).status).toBe(200)
    expect(await usage()).toEqual([])

    expect((await call(DEAR, 'member')).status).toBe(200)
    const once = await charged('member')
    expect(once).toBeGreaterThanOrEqual(CHARGE_FROM_ROWS)
    expect((await call(DEAR, 'member')).status).toBe(200)
    expect(await charged('member')).toBe(once * 2)
    expect(await usage()).toHaveLength(1) // one row a Member a day: no email in it
    expect(JSON.stringify(await usage())).not.toContain('example.com')
  })

  it('never counts the Admin', async () => {
    expect((await call(DEAR, 'admin')).status).toBe(200)
    expect(await usage()).toEqual([])
  })

  it('refuses every Member once all of them together reach MEMBER_DAILY_READS, without writing, and still answers the Admin', async () => {
    // Three other Members' worth, each under their own limit, that add up to the shared one.
    for (const [i, rows] of [600_000, 600_000, MEMBER_DAILY_READS - 1_200_000].entries()) await seed(`other-${i}`, today(), rows)
    const before = await usage()

    for (const who of ['member', 'other'] as const) {
      const res = await call(CHEAP, who)
      expect(res.status, who).toBe(429)
      expect(await res.json()).toEqual(MEMBER_LIMIT_REACHED)
    }
    expect(await usage()).toEqual(before)
    expect((await call(DEAR, 'admin')).status).toBe(200)
    expect((await call('/api/me', 'member')).status).toBe(200) // the page can still say why
  })

  it('refuses a Member who reaches EACH_MEMBER_DAILY_READS, without writing, while another Member carries on', async () => {
    await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS)
    const before = await usage()

    expect((await call(DEAR, 'member')).status).toBe(429)
    expect(await usage()).toEqual(before)
    expect((await call(DEAR, 'other')).status).toBe(200)
    expect(await charged('other')).toBeGreaterThanOrEqual(CHARGE_FROM_ROWS)
  })

  it('lets a Member just under a limit make one more request, and charges it', async () => {
    await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS - 1)

    expect((await call(DEAR, 'member')).status).toBe(200)
    expect(await charged('member')).toBeGreaterThan(EACH_MEMBER_DAILY_READS)
    expect((await call(CHEAP, 'member')).status).toBe(429)
  })

  it('adds up many small reads, charged by chance, until the Member is refused', { timeout: 30_000 }, async () => {
    drawWith(seeded(42))
    await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS - 3 * CHARGE_FROM_ROWS + 1) // three charges from the limit

    const seen = [await charged('member')]
    let requests = 0
    let status = 200
    while (status === 200 && requests < 2_000) {
      status = (await call(CHEAP, 'member')).status
      requests += 1
      const now = await charged('member')
      if (now !== seen.at(-1)) seen.push(now)
    }

    expect(status).toBe(429)
    expect(seen.slice(1).map((n, i) => n - seen[i]!)).toEqual([CHARGE_FROM_ROWS, CHARGE_FROM_ROWS, CHARGE_FROM_ROWS])
    expect(requests).toBeGreaterThan(10) // most small reads were not charged, and wrote nothing
  })

  it('keeps today\'s counts when a request begun before 00:00 UTC is charged after it', async () => {
    const yesterday = utcDay(new Date(Date.now() - 86_400_000))
    await seed(await memberKey(today(), EMAIL.other), today(), 5_000)

    await seed(await memberKey(yesterday, EMAIL.member), yesterday, 2_000) // the late charge's row

    expect(await usage()).toHaveLength(2)
    expect(await charged('other')).toBe(5_000)
  })

  it('still answers a dear read whose settling fails, and keeps its hold charged so the limits still hold', async () => {
    const failing = failingCharges()

    expect((await fetchWith(failing, DEAR, 'member')).status).toBe(200)
    expect(await charged('member')).toBe(await holdOf(10)) // the hold: net worth's 10 reads for each Transaction
  })

  it('still answers a cheap read whose charge fails', async () => {
    drawWith(() => 0) // the draw charges it
    const failing = failingCharges()

    expect((await fetchWith(failing, CHEAP, 'member')).status).toBe(200)
    expect(await usage()).toEqual([])
  })

  describe('with few Transactions or none', () => {
    beforeEach(() => env.DB.prepare('DELETE FROM transactions').run())

    it('holds CHARGE_FROM_ROWS at the least, and keeps it when settling fails', async () => {
      const failing = failingCharges()

      expect((await fetchWith(failing, DEAR, 'member')).status).toBe(200)
      expect(await charged('member')).toBe(CHARGE_FROM_ROWS)
    })

    it('charges a dear request CHARGE_FROM_ROWS at the least, so dear requests write at most about 2 * MEMBER_DAILY_READS / CHARGE_FROM_ROWS rows a day', async () => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')
      expect(tally.rows).toBeLessThan(CHARGE_FROM_ROWS) // it reads next to nothing

      for (let i = 1; i <= 3; i++) {
        expect((await call(DEAR, 'member')).status).toBe(200)
        expect(await charged('member')).toBe(i * CHARGE_FROM_ROWS)
      }
    })

    it('still lets only one dear request past a limit when they are sent together', async () => {
      await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS - 1)

      const statuses = await Promise.all(Array.from({ length: 8 }, () => fetchWith(env.DB, DEAR, 'member').then((res) => res.status)))

      expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    })
  })

  it('settles a dear request to exactly what it read', async () => {
    const tally = { rows: 0 }
    await fetchWith(countingReads(env.DB, tally), DEAR, 'admin') // the Admin's request reads what the route reads, and is never charged

    expect((await call(DEAR, 'member')).status).toBe(200)
    expect(tally.rows).toBeGreaterThan(CHARGE_FROM_ROWS)
    expect(tally.rows).not.toBe(await holdOf(10)) // so the charge below is the reads, not the hold
    expect(await charged('member')).toBe(tally.rows)
  })

  describe('a request that runs across 00:00 UTC', () => {
    // The clock passes 00:00 UTC while the route reads.
    const acrossMidnight = async (path: string) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-25T23:59:59.900Z'))
      const midnight = withDb((target, sql) => {
        if (!sql.includes('member_read_usage')) vi.setSystemTime(new Date('2026-10-26T00:00:00.100Z'))
        return target.prepare(sql)
      })
      try {
        return await fetchWith(midnight, path, 'member')
      } finally {
        vi.useRealTimers()
      }
    }
    const reads = async (path: string) => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), path, 'admin')
      return tally.rows
    }

    it('charges a dear one to the day its reads finished, and the hold on the day before goes with that day', async () => {
      const read = await reads(DEAR)

      expect((await acrossMidnight(DEAR)).status).toBe(200)
      const rows = await usage()
      expect(rows.find((r) => r.usage_day === '2026-10-26')).toEqual({ usage_day: '2026-10-26', member_key: await memberKey('2026-10-26', EMAIL.member), rows_read: read })
      // The 25th's row was kept while its hold was in flight; settling released the hold and then charged the 26th, whose first row cleared it.
      expect(await env.DB.prepare("SELECT rows_read, held, held_count FROM member_read_usage WHERE usage_day = '2026-10-25'").all().then((r) => r.results)).toEqual([])
    })

    it('counts a hold still in flight from the day before in the new day\'s admission, and charges its reads to the new day', async () => {
      const read = await reads(DEAR)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-25T23:59:59.900Z'))
      // Net worth's histories are one batch, held back here until the new day has been asked for.
      let reserved = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const held = new Proxy(env.DB, {
        get(target, property) {
          if (property === 'batch') return async (statements: D1PreparedStatement[]) => ((reserved = true), await gate, target.batch(statements))
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      try {
        const inFlight = fetchWith(held, DEAR, 'member')
        await vi.waitFor(() => expect(reserved).toBe(true))
        vi.setSystemTime(new Date('2026-10-26T00:00:00.100Z'))
        await seed(await memberKey('2026-10-26', EMAIL.member), '2026-10-26', EACH_MEMBER_DAILY_READS - CHARGE_FROM_ROWS) // the hold in flight makes up the rest

        for (const path of [CHEAP, DEAR]) {
          const refused = await fetchWith(env.DB, path, 'member')
          expect(refused.status, path).toBe(429)
          expect(await refused.json()).toEqual(MEMBER_LIMIT_REACHED)
        }
        release()
        expect((await inFlight).status).toBe(200)
      } finally {
        vi.useRealTimers()
      }
      expect((await usage()).find((r) => r.usage_day === '2026-10-26')!.rows_read).toBe(EACH_MEMBER_DAILY_READS - CHARGE_FROM_ROWS + read)
    })

    it('takes nothing off what the new day has already charged the Member', async () => {
      const read = await reads(DEAR)
      await seed(await memberKey('2026-10-26', EMAIL.member), '2026-10-26', 5_000) // another request already charged on the 26th

      expect((await acrossMidnight(DEAR)).status).toBe(200)
      expect((await usage()).find((r) => r.usage_day === '2026-10-26')).toMatchObject({ rows_read: 5_000 + read })
    })

    it('charges a cheap one to the day its reads finished', async () => {
      drawWith(() => 0) // the draw charges it

      expect((await acrossMidnight(CHEAP)).status).toBe(200)
      expect(await usage()).toEqual([{ usage_day: '2026-10-26', member_key: await memberKey('2026-10-26', EMAIL.member), rows_read: CHARGE_FROM_ROWS }])
    })
  })

  it('takes holds older than HOLD_EXPIRY_MS as spent, so requests that never settled can\'t lock a Member out', async () => {
    // Four holds whose requests never settled (cancelled, say), the last reserved just over a minute ago.
    await env.DB.prepare('INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count, held_at) VALUES (?, ?, 0, 4000, 4, ?)')
      .bind(await memberKey(today(), EMAIL.member), today(), Date.now() - HOLD_EXPIRY_MS - 1_000)
      .run()
    const tally = { rows: 0 }
    await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')

    expect((await fetchWith(env.DB, DEAR, 'member')).status).toBe(200)
    const row = await env.DB.prepare('SELECT rows_read, held, held_count FROM member_read_usage WHERE member_key = ?').bind(await memberKey(today(), EMAIL.member)).first()
    expect(row).toEqual({ rows_read: 4000 + tally.rows, held: 0, held_count: 0 }) // the four charged as spent, and this one settled
  })

  it('corrects the charge of a request that settles after its hold was taken as spent, and leaves the holds that began since alone', async () => {
    const reads = async () => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')
      return tally.rows
    }
    const read = await reads()
    const row = async () => env.DB.prepare('SELECT rows_read, held, held_count FROM member_read_usage WHERE member_key = ?').bind(await memberKey(today(), EMAIL.member)).first()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const late = heldBack()
      const first = fetchWith(late.db, DEAR, 'member')
      await vi.waitFor(() => expect(late.state.reserved).toBe(1))
      const hold = (await row())!.held as number
      vi.setSystemTime(Date.now() + HOLD_EXPIRY_MS + 1_000) // the first is taken as spent by the next reservation
      const next = heldBack()
      const second = fetchWith(next.db, DEAR, 'member')
      await vi.waitFor(() => expect(next.state.reserved).toBe(1))
      expect(await row()).toEqual({ rows_read: hold, held: hold, held_count: 1 }) // the first charged as spent; the second held

      late.state.release()
      expect((await first).status).toBe(200)
      expect(await row()).toEqual({ rows_read: read, held: hold, held_count: 1 }) // the first's charge corrected to its reads; the second still held
      next.state.release()
      expect((await second).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
    expect(await row()).toEqual({ rows_read: 2 * read, held: 0, held_count: 0 })
  })

  it('takes a hold that never settled as spent a minute after it began, however often the Member asks in between', async () => {
    const key = await memberKey(today(), EMAIL.member)
    const row = () => env.DB.prepare('SELECT held, held_count FROM member_read_usage WHERE member_key = ?').bind(key).first()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const began = Date.now()
      // One hold whose request never settled, reserved 50 seconds ago.
      await env.DB.prepare('INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count, held_at) VALUES (?, ?, 0, 1000, 1, ?)').bind(key, today(), began - 50_000).run()

      expect((await fetchWith(env.DB, DEAR, 'member')).status).toBe(200)
      expect(await row()).toEqual({ held: 1000, held_count: 1 }) // still in flight: it began 50 seconds ago
      vi.setSystemTime(began + 15_000)
      expect((await fetchWith(env.DB, DEAR, 'member')).status).toBe(200)
      expect(await row()).toEqual({ held: 0, held_count: 0 }) // 65 seconds: taken as spent, though the Member asked 15 seconds ago
    } finally {
      vi.useRealTimers()
    }
  })

  it('still counts young holds as in flight, so a fifth request waits its turn', async () => {
    await env.DB.prepare('INSERT INTO member_read_usage (member_key, usage_day, rows_read, held, held_count, held_at) VALUES (?, ?, 0, 4000, 4, ?)')
      .bind(await memberKey(today(), EMAIL.member), today(), Date.now() - 1_000)
      .run()

    const res = await fetchWith(env.DB, DEAR, 'member')
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(MEMBER_BUSY)
    expect((await fetchWith(env.DB, CHEAP, 'member')).status).toBe(200) // a cheap request isn't leased
  })

  describe('requests sent together', () => {
    const K = 8
    const together = (path: string, who: 'member' | 'other') => Promise.all(Array.from({ length: K }, () => fetchWith(env.DB, path, who).then((res) => res.status)))

    // A Member reads a Report only once the Admin has kept it (kept-reports.ts).
    const keep = (report: string) =>
      env.DB.prepare("INSERT INTO kept_reports (report, account_id, from_date, to_date, made_by) VALUES (?, NULL, ?, ?, 'admin@example.com')").bind(report, YEAR.from, YEAR.to).run()

    it.each([
      DEAR,
      '/api/transactions?sort=amount',
      '/api/transactions?text=EXAMPLE',
      '/api/transactions?count=only',
      `/api/transactions/export.csv?from=${YEAR.from}&to=${YEAR.to}`,
      '/api/budgets/vs-actual?month=2026-03',
      `/api/reports/spending?from=${YEAR.from}&to=${YEAR.to}`,
      `/api/reports/budget-vs-actual?from=${YEAR.from}&to=${YEAR.to}`,
      `/api/reports/income-vs-spending?from=${YEAR.from}&to=${YEAR.to}`,
      `/api/reports/balances?accountId=ACCOUNT&from=${YEAR.from}&to=${YEAR.to}`,
      `/api/reports/loans?categoryId=LOANS&to=${YEAR.to}`,
      `/api/charts/spending?from=${YEAR.from}&to=${YEAR.to}`,
      '/api/balances',
      '/api/balances/ACCOUNT/history',
      '/api/imports/imported/ACCOUNT',
      '/api/change-log',
      '/api/transactions?count=false&uncategorised=true',
      '/api/transactions?count=false&categoryId=CATEGORY',
      '/api/transactions?count=false&transfers=only',
    ])(
      'let at most one past one Member\'s limit: %s',
      async (template) => {
        const path = (await historyForReports())(template)
        await keep('spending')
        await keep('budget-vs-actual')
        await keep('income-vs-spending')
        await keep('balances')
        await env.DB.prepare("INSERT INTO kept_reports (report, from_date, to_date, made_by) VALUES ('loans', NULL, ?, 'admin@example.com')").bind(YEAR.to).run()
        await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS - 1)

        const statuses = await together(path, 'member')

        expect(statuses.filter((s) => s === 200)).toHaveLength(1)
        expect(statuses.filter((s) => s === 429)).toHaveLength(K - 1)
      },
    )

    it.each([DEAR, '/api/transactions?sort=amount', `/api/transactions/export.csv?from=${YEAR.from}&to=${YEAR.to}`, `/api/reports/spending?from=${YEAR.from}&to=${YEAR.to}`, `/api/reports/budget-vs-actual?from=${YEAR.from}&to=${YEAR.to}`, '/api/budgets/vs-actual?month=2026-03'])('let at most one past all Members\' limit: %s', async (path) => {
      await keep('spending')
      await keep('budget-vs-actual')
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), path, 'admin')
      await seed('another member', today(), MEMBER_DAILY_READS - 1)

      const statuses = await together(path, 'member')

      expect(statuses.filter((s) => s === 200)).toHaveLength(1)
      // One request's reads (1,000 at the least, and a row or two more for a Member's kept-Report check): the refused ones' holds were never added.
      expect(await charged('member')).toBeGreaterThanOrEqual(Math.max(tally.rows, CHARGE_FROM_ROWS))
      expect(await charged('member')).toBeLessThanOrEqual(Math.max(tally.rows, CHARGE_FROM_ROWS) + 3)
    })

    it('admit MEMBER_MAX_IN_FLIGHT of one Member\'s, well under the limits, and say the rest are busy, and charge only those admitted', async () => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')

      // The ones let in are held in flight until the rest have been answered, so none settles early and frees a place.
      const { db, state } = heldBack()
      const sent = Array.from({ length: K }, () => fetchWith(db, DEAR, 'member'))
      const busy = await Promise.all(sent.map((answer) => Promise.race([answer, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))])))
      expect(busy.filter((r) => r !== null)).toHaveLength(K - MEMBER_MAX_IN_FLIGHT)
      for (const r of busy.filter((r) => r !== null)) {
        expect(r!.status).toBe(429)
        expect(await r!.json()).toEqual(MEMBER_BUSY)
      }
      expect(state.reserved).toBe(MEMBER_MAX_IN_FLIGHT)
      state.release()
      const responses = await Promise.all(sent)
      expect(responses.filter((r) => r.status === 200)).toHaveLength(MEMBER_MAX_IN_FLIGHT)
      expect(await charged('member')).toBe(MEMBER_MAX_IN_FLIGHT * tally.rows)
      expect(await together(DEAR, 'other')).toEqual(expect.arrayContaining([200])) // another Member has a lease of their own
    })

    it('pass a limit by no more than MEMBER_MAX_IN_FLIGHT requests\' reads, however many are sent', async () => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')
      const seeded = EACH_MEMBER_DAILY_READS - 1
      await seed(await memberKey(today(), EMAIL.member), today(), seeded)

      const statuses = await Promise.all(Array.from({ length: 3 * K }, () => fetchWith(env.DB, DEAR, 'member').then((res) => res.status)))

      expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(MEMBER_MAX_IN_FLIGHT)
      expect((await charged('member')) - EACH_MEMBER_DAILY_READS).toBeLessThanOrEqual(MEMBER_MAX_IN_FLIGHT * tally.rows) // with holds that cover them, one
      expect((await charged('member')) - seeded).toBeLessThanOrEqual(tally.rows)
    })

    it('let them in again once the requests in flight have settled', async () => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')
      expect((await together(DEAR, 'member')).filter((status) => status === 200)).toHaveLength(MEMBER_MAX_IN_FLIGHT)

      for (let i = 0; i < K; i++) expect((await fetchWith(env.DB, DEAR, 'member')).status).toBe(200) // one at a time, so never more than one in flight
      expect(await charged('member')).toBe((MEMBER_MAX_IN_FLIGHT + K) * tally.rows)
    })
  })

  it('starts each UTC day at nothing, and the next charge clears the days before', async () => {
    const yesterday = utcDay(new Date(Date.now() - 86_400_000))
    await seed(await memberKey(yesterday, EMAIL.member), yesterday, EACH_MEMBER_DAILY_READS)
    await seed('earlier', yesterday, MEMBER_DAILY_READS)

    expect((await call(CHEAP, 'member')).status).toBe(200)
    expect(await usage()).toHaveLength(2) // a cheap request writes nothing, not even the clearing
    expect((await call(DEAR, 'member')).status).toBe(200)
    const rows = await usage()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ usage_day: today(), member_key: await memberKey(today(), EMAIL.member) })
  })
})
