import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARGE_FROM_ROWS, chargeFor, countingReads, readsPerTransaction, EACH_MEMBER_DAILY_READS, MEMBER_DAILY_READS, MEMBER_LIMIT_REACHED, memberKey } from './member-read-limit'
import worker from './index'
import { utcDay } from './rule-rerun'

const origin = 'http://localhost:5173'
// 'member' signs in as dev.member@example.com; 'other' as DEV_USER_EMAIL, which is not the Admin, so a second Member.
type Who = 'admin' | 'member' | 'other'
const EMAIL = { member: 'dev.member@example.com', other: 'dev@example.com' }

const call = (path: string, who: Who) => exports.default.fetch(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }))

const today = () => utcDay(new Date())
const usage = async () => (await env.DB.prepare('SELECT member_key, usage_day, rows_read FROM member_read_usage ORDER BY member_key').all()).results
const charged = async (who: 'member' | 'other') =>
  (await env.DB.prepare('SELECT rows_read FROM member_read_usage WHERE member_key = ?').bind(await memberKey(today(), EMAIL[who])).first<{ rows_read: number }>())?.rows_read ?? 0
const seed = (key: string, day: string, rows: number) => env.DB.prepare('INSERT INTO member_read_usage (member_key, usage_day, rows_read) VALUES (?, ?, ?)').bind(key, day, rows).run()

// A cheap read (the Categories, a few dozen rows) and a dear one (net worth reads every Transaction several times; ADR 0004).
const CHEAP = '/api/categories'
const DEAR = '/api/charts/net-worth?range=all'
const TRANSACTIONS = 400
/** The hold a dear request reserves: its reads for each Transaction times the highest Transaction ID (IDs go on rising across this file's tests). */
const holdOf = async (perTransaction: number) =>
  perTransaction * (await env.DB.prepare('SELECT MAX(id) AS id FROM transactions').first<{ id: number }>())!.id

/** The Worker's own handler, called with `db` standing in for D1 (CODING_STANDARDS.md: Tests), as `who`. */
async function fetchWith(db: D1Database, path: string, who: Who) {
  const ctx = createExecutionContext()
  const res = await worker.fetch!(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }) as never, { ...env, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  return res
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
  await env.DB.batch(['member_read_usage', 'transactions', 'accounts'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
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

describe('which requests are dear', () => {
  it('holds by the reads for each Transaction for net worth, the other charts and a Transaction list that searches, sorts or counts', () => {
    const per = (path: string, query = '') => readsPerTransaction(path, new URLSearchParams(query))

    expect(per('/api/charts/net-worth', 'range=all')).toBe(6)
    expect(per('/api/charts/spending', 'period=this-month')).toBe(4)
    expect(per('/api/transactions')).toBe(1) // the first page counts
    expect(per('/api/transactions', 'offset=200')).toBe(0)
    expect(per('/api/transactions', 'count=false')).toBe(0)
    expect(per('/api/transactions', 'count=only')).toBe(1)
    expect(per('/api/transactions', 'count=false&text=EXAMPLE')).toBe(2)
    expect(per('/api/transactions', 'count=false&text=%20%20')).toBe(0)
    expect(per('/api/transactions', 'count=false&sort=amount')).toBe(4)
    expect(per('/api/transactions', 'sort=date&offset=200')).toBe(0)
    expect(per('/api/categories')).toBe(0)
    expect(per('/api/transactions/export.csv')).toBe(0)
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

  it('adds up many small reads, charged by chance, until the Member is refused', async () => {
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
    const failing = withDb((target, sql) => (sql.includes('VALUES (?2, ?1, ?3)') ? ({ bind: () => ({ run: () => Promise.reject(new Error('D1 is full')) }) } as never) : target.prepare(sql)))

    expect((await fetchWith(failing, DEAR, 'member')).status).toBe(200)
    expect(await charged('member')).toBe(await holdOf(6)) // the hold: net worth's 6 reads for each Transaction
  })

  it('settles a dear request to exactly what it read', async () => {
    const tally = { rows: 0 }
    await fetchWith(countingReads(env.DB, tally), DEAR, 'admin') // the Admin's request reads what the route reads, and is never charged

    expect((await call(DEAR, 'member')).status).toBe(200)
    expect(tally.rows).toBeGreaterThan(CHARGE_FROM_ROWS)
    expect(tally.rows).not.toBe(await holdOf(6)) // so the charge below is the reads, not the hold
    expect(await charged('member')).toBe(tally.rows)
  })

  it('charges a request to the UTC day its reads finished, not the day it began', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-25T23:59:59.900Z'))
    // The clock passes 00:00 UTC while the route reads.
    const midnight = withDb((target, sql) => {
      if (!sql.includes('member_read_usage')) vi.setSystemTime(new Date('2026-10-26T00:00:00.100Z'))
      return target.prepare(sql)
    })

    const res = await fetchWith(midnight, DEAR, 'member')
    vi.useRealTimers()

    expect(res.status).toBe(200)
    const rows = await usage()
    expect(rows).toHaveLength(1) // the hold on the 25th was cleared with the 25th
    expect(rows[0]).toMatchObject({ usage_day: '2026-10-26', member_key: await memberKey('2026-10-26', EMAIL.member) })
    expect(rows[0]!.rows_read).toBeGreaterThan(CHARGE_FROM_ROWS)
  })

  describe('requests sent together', () => {
    const K = 8
    const together = (path: string, who: 'member' | 'other') => Promise.all(Array.from({ length: K }, () => fetchWith(env.DB, path, who).then((res) => res.status)))

    it.each([DEAR, '/api/transactions?sort=amount', '/api/transactions?text=EXAMPLE', '/api/transactions?count=only'])(
      'let at most one past one Member\'s limit: %s',
      async (path) => {
        await seed(await memberKey(today(), EMAIL.member), today(), EACH_MEMBER_DAILY_READS - 1)

        const statuses = await together(path, 'member')

        expect(statuses.filter((s) => s === 200)).toHaveLength(1)
        expect(statuses.filter((s) => s === 429)).toHaveLength(K - 1)
      },
    )

    it.each([DEAR, '/api/transactions?sort=amount'])('let at most one past all Members\' limit: %s', async (path) => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), path, 'admin')
      await seed('another member', today(), MEMBER_DAILY_READS - 1)

      const statuses = await together(path, 'member')

      expect(statuses.filter((s) => s === 200)).toHaveLength(1)
      expect(await charged('member')).toBe(tally.rows) // one request's reads: the refused ones' holds were never added
    })

    it('all pass, and are all charged, while well under the limits', async () => {
      const tally = { rows: 0 }
      await fetchWith(countingReads(env.DB, tally), DEAR, 'admin')

      expect(await together(DEAR, 'member')).toEqual(Array(K).fill(200))
      expect(await charged('member')).toBe(K * tally.rows)
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
