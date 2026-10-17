import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RULES } from './rule-criteria'
import { MAX_INLINE_APPLY } from './rule-from-transaction'
import { callAsAdminWith, callWhileInterrupted, meteredDb } from './test-support'

// Seam 1: the Edit panel's Create Rule, through the Worker's exported handler (POST /api/rules/from-transaction). The Admin makes a Rule from a Transaction, and in one batch the
// Rule is added last, the other Uncategorised Transactions it matches are given its Category, and this Transaction is given it too. The Rules' own tests are in rules.test.ts.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown; origin?: string; contentType?: string } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: opts.origin ?? origin, 'Content-Type': opts.contentType ?? 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

type Made = {
  description: string
  memo?: string
  cents?: number
  /** The Category the Admin chose by hand (an Override), the Rule that categorised it, and what that Rule gave it. */
  override?: number | null
  rule?: { id: number; category: number | null; transfer?: boolean }
  /** The ID of the Transaction it is paired with: it is a Transfer. */
  pairedWith?: number
}
type Stored = { id: number; override: number | null; ruleId: number | null; ruleCategory: number | null; ruleTransfer: number | null }

const ACCOUNT_NUMBER = '99-9999-9999999-99'
let accountId = 0
let categories: Record<string, number> = {}

const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id
const DAY = '2026-10-05'
const SHOP = 'EXAMPLE COUNTDOWN'

async function made(t: Made): Promise<number> {
  const { meta } = await env.DB.prepare(
    'INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, bank_type, source, override_category, rule_id, rule_category, rule_transfer, transfer_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(accountId, DAY, t.cents ?? -1000, t.description, t.memo ?? '', 'EFTPOS', 'import', t.override ?? null, t.rule?.id ?? null, t.rule?.category ?? null, t.rule?.transfer ? 1 : null, t.pairedWith ?? null)
    .run()
  return meta.last_row_id
}
/** `count` made-up Transactions in one statement, each `name` and a number: the Account's history, which the request has to get through. */
const manyMade = (count: number, name: string) =>
  env.DB.prepare(
    "INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, bank_type, source) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3) SELECT ?1, '2026-10-01', -1000, ?2 || i, '', 'EFTPOS', 'import' FROM n",
  )
    .bind(accountId, name, count)
    .run()

const stored = async (id: number): Promise<Stored> =>
  (await env.DB.prepare('SELECT id, override_category AS override, rule_id AS ruleId, rule_category AS ruleCategory, rule_transfer AS ruleTransfer FROM transactions WHERE id = ?').bind(id).first<Stored>())!
const countWhere = async (where: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).first<{ n: number }>())!.n
const changeLog = async () => (await env.DB.prepare('SELECT summary, type, before, after FROM change_log ORDER BY id').all<{ summary: string; type: string; before: string | null; after: string | null }>()).results
const rules = async () =>
  (await env.DB.prepare('SELECT id, position, text_contains AS textContains, direction, category_id AS categoryId, is_transfer AS transfer FROM rules WHERE removed_at IS NULL ORDER BY position, id').all()).results

/** Adds a Rule through the real route, which changes no Transaction already stored. Returns its ID. */
async function addRule(body: Record<string, unknown>) {
  const res = await call('/api/rules', { method: 'POST', body })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return ((await res.json()) as { id: number }).id
}

type Created = {
  id: number
  number: number
  categorised: number
  thisBy: 'rule' | 'override'
  overrideBecause: 'no-match' | 'earlier-rule' | 'categorised' | null
  moreUncategorised: number | null
}
type Body = { transactionId: number; textContains: string; direction?: 'in' | 'out' | null; categoryId: number }
const create = (body: Partial<Body> | Record<string, unknown>, opts: { who?: Who; origin?: string; contentType?: string } = {}) => call('/api/rules/from-transaction', { method: 'POST', body, ...opts })
async function created(body: Body): Promise<Created> {
  const res = await create(body)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return res.json()
}

type CategoryRecord = { id: number; name: string }
let starters: CategoryRecord[] = []
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

beforeEach(async () => {
  await env.DB.batch(['data_migration_progress', 'transactions', 'rules', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(c.id, c.name)))
  accountId = (await env.DB.prepare('INSERT INTO accounts (account_number, name) VALUES (?, ?) RETURNING id').bind(ACCOUNT_NUMBER, 'Example').first<{ id: number }>())!.id
  categories = { groceries: await categoryId('Groceries'), fuel: await categoryId('Fuel'), eatingOut: await categoryId('Eating out') }
})

describe('making a Rule from a Transaction', () => {
  it('adds the Rule last, gives the other Uncategorised Transactions it matches the Category, gives this one the Category by the Rule too, and logs it', async () => {
    const { groceries, fuel } = categories
    const earlier = await addRule({ textContains: 'EXAMPLE PETROL', categoryId: fuel })
    await env.DB.prepare('DELETE FROM change_log').run() // the log of this request alone
    const here = await made({ description: `EFTPOS 1234 ${SHOP} AUCKLAND 12/10` })
    const other = await made({ description: `${SHOP} ALBANY` })
    const inTheMemo = await made({ description: 'SOMETHING ELSE', memo: `example Countdown 99` }) // the memo is looked in too, and capital letters are ignored
    const noMatch = await made({ description: 'EXAMPLE BAKERY' })

    const result = await created({ transactionId: here, textContains: SHOP, direction: 'out', categoryId: groceries! })

    expect(result).toEqual({ id: expect.any(Number), number: 2, categorised: 3, thisBy: 'rule', overrideBecause: null, moreUncategorised: null })
    expect(await rules()).toMatchObject([{ id: earlier }, { id: result.id, position: 2, textContains: SHOP, direction: 'out', categoryId: groceries, transfer: 0 }])
    for (const id of [here, other, inTheMemo]) expect(await stored(id), `Transaction ${id}`).toEqual({ id, override: null, ruleId: result.id, ruleCategory: groceries, ruleTransfer: null })
    expect(await stored(noMatch)).toMatchObject({ override: null, ruleId: null, ruleCategory: null })
    // The Category is the Rule's, as any other Rule gives it.
    const list = (await (await call('/api/transactions?limit=50')).json()) as { transactions: { id: number; categoryName: string | null; categorySource: string | null }[] }
    expect(list.transactions.find((t) => t.id === here)).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })

    expect(await changeLog()).toEqual([
      // The Rule is logged as Add a Rule logs it.
      { summary: `Added a Rule: text contains "${SHOP}" and money out, category Groceries`, type: 'rule', before: null, after: expect.stringContaining('"category":"Groceries"') },
      { summary: 'Gave 3 Transactions the Category Groceries with the new Rule (Rule 2)', type: 'rule', before: null, after: JSON.stringify({ transactionsGivenTheCategory: 3 }) },
    ])
  })

  it('looks for money in or money out as the Rule does, and either when it says neither', async () => {
    const { groceries } = categories
    const here = await made({ description: `${SHOP} REFUND`, cents: 500 })
    const out = await made({ description: `${SHOP} SHOPPING`, cents: -500 })
    const zero = await made({ description: `${SHOP} FREE`, cents: 0 })

    const result = await created({ transactionId: here, textContains: SHOP, direction: 'in', categoryId: groceries! })

    expect(result).toMatchObject({ categorised: 1, thisBy: 'rule' })
    expect(await stored(out)).toMatchObject({ ruleId: null })
    expect(await stored(zero)).toMatchObject({ ruleId: null })
    expect(await rules()).toMatchObject([{ direction: 'in' }])

    const either = await created({ transactionId: out, textContains: SHOP, direction: null, categoryId: groceries! })
    expect(either).toMatchObject({ categorised: 2, thisBy: 'rule' }) // this one and the $0.00 one: the first Rule gave the money in its Category already
    expect(await stored(zero)).toMatchObject({ ruleId: either.id })
  })

  it('never changes a Transaction the Admin set the Category of, one an earlier Rule gave a Category, or a Transfer', async () => {
    const { groceries, fuel, eatingOut } = categories
    const earlier = await addRule({ textContains: 'NOTHING THAT MATCHES', categoryId: fuel })
    const here = await made({ description: SHOP })
    const overridden = await made({ description: `${SHOP} 1`, override: fuel })
    const rulesChoice = await made({ description: `${SHOP} 2`, rule: { id: earlier, category: eatingOut } })
    const paired = await made({ description: `${SHOP} 3`, pairedWith: here })
    const marked = await made({ description: `${SHOP} 4`, rule: { id: earlier, category: null, transfer: true } })
    const before = await Promise.all([overridden, rulesChoice, paired, marked].map(stored))

    const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

    expect(result).toMatchObject({ categorised: 1 }) // only this one
    expect(await Promise.all([overridden, rulesChoice, paired, marked].map(stored))).toEqual(before)
  })

  it('treats a removed Category as none, as Uncategorised does: a Transaction whose Override or Rule is of one is given the Category', async () => {
    const { groceries, fuel } = categories
    const gone = (await env.DB.prepare("INSERT INTO categories (name, removed_at) VALUES ('Old one', '2026-01-01T00:00:00Z') RETURNING id").first<{ id: number }>())!.id
    const earlier = await addRule({ textContains: 'NOTHING THAT MATCHES', categoryId: fuel })
    const here = await made({ description: SHOP })
    const overrideOfARemovedOne = await made({ description: `${SHOP} 1`, override: gone })
    const ruleOfARemovedOne = await made({ description: `${SHOP} 2`, rule: { id: earlier, category: gone } })

    const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

    expect(result.categorised).toBe(3)
    expect(await stored(overrideOfARemovedOne)).toMatchObject({ ruleId: result.id, ruleCategory: groceries, override: gone }) // what the Override says is not touched, only the Rule's result
    expect(await stored(ruleOfARemovedOne)).toMatchObject({ ruleId: result.id, ruleCategory: groceries })
  })

  describe('follows the Rules in their order', () => {
    // A Rule saved after the Transactions were stored changes none of them until the Rules are applied to all Transactions, so an Uncategorised Transaction can match an earlier Rule. The
    // new Rule is last, so for that Transaction the earlier Rule wins, and the new one leaves it as it is (it is the next re-run that would give it the earlier Rule's Category).
    it('and leaves a Transaction an earlier Rule matches, a Category Rule or a Transfer Rule', async () => {
      const { groceries, fuel } = categories
      await addRule({ textContains: 'FIRST', categoryId: fuel })
      await addRule({ textContains: 'SECOND', transfer: true })
      const here = await made({ description: SHOP })
      const first = await made({ description: `${SHOP} FIRST` })
      const second = await made({ description: `${SHOP} SECOND` })
      const free = await made({ description: `${SHOP} THIRD` })

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result.categorised).toBe(2) // this one and the third
      expect(await stored(first)).toMatchObject({ ruleId: null, ruleCategory: null })
      expect(await stored(second)).toMatchObject({ ruleId: null, ruleTransfer: null })
      expect(await stored(free)).toMatchObject({ ruleId: result.id })
    })

    it('and is not stopped by an earlier Rule that does nothing: its Category was removed', async () => {
      const { groceries, eatingOut } = categories
      await addRule({ textContains: 'FIRST', categoryId: eatingOut })
      await env.DB.prepare('UPDATE categories SET removed_at = ? WHERE id = ?').bind('2026-01-01T00:00:00Z', eatingOut).run()
      const here = await made({ description: SHOP })
      const first = await made({ description: `${SHOP} FIRST` })

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result.categorised).toBe(2)
      expect(await stored(first)).toMatchObject({ ruleId: result.id, ruleCategory: groceries })
    })
  })

  describe('gives this Transaction the Category as an Override, as Save does, when the Rule does not', () => {
    it('because the text no longer matches it', async () => {
      const { groceries } = categories
      const here = await made({ description: 'EFTPOS 1234 COUNTDOWN AUCKLAND 12/10' })
      const other = await made({ description: 'WOOLWORTHS METRO' })

      const result = await created({ transactionId: here, textContains: 'WOOLWORTHS', categoryId: groceries! })

      expect(result).toMatchObject({ categorised: 1, thisBy: 'override', overrideBecause: 'no-match', moreUncategorised: null })
      expect(await stored(here)).toMatchObject({ override: groceries, ruleId: null })
      expect(await stored(other)).toMatchObject({ ruleId: result.id })
      expect(await changeLog()).toMatchObject([
        { type: 'transaction', summary: `Set Override on Transaction ${here} (${DAY}, EFTPOS 1234 COUNTDOWN AUCKLAND 12/10) to Groceries`, before: '{"override":null}', after: '{"override":"Groceries"}' },
        { type: 'rule', summary: 'Added a Rule: text contains "WOOLWORTHS", category Groceries' },
        { type: 'rule', summary: 'Gave 1 Transaction the Category Groceries with the new Rule (Rule 1)' },
      ])
    })

    it('because an earlier Rule matches it', async () => {
      const { groceries, fuel } = categories
      await addRule({ textContains: SHOP, categoryId: fuel })
      const here = await made({ description: SHOP })

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result).toMatchObject({ categorised: 0, thisBy: 'override', overrideBecause: 'earlier-rule' })
      expect(await stored(here)).toMatchObject({ override: groceries, ruleId: null })
    })

    it('because it already has a Category, from a Rule or the Admin, or is a Transfer; and leaves an Override that is already this Category as it is', async () => {
      const { groceries, fuel, eatingOut } = categories
      const earlier = await addRule({ textContains: 'NOTHING THAT MATCHES', categoryId: fuel })
      const fromARule = await made({ description: `${SHOP} 1`, rule: { id: earlier, category: fuel } })
      const byHand = await made({ description: `${SHOP} 2`, override: eatingOut })
      const aTransfer = await made({ description: `${SHOP} 3`, pairedWith: byHand })
      const alreadyIt = await made({ description: `${SHOP} 4`, override: groceries })

      for (const id of [fromARule, byHand, aTransfer, alreadyIt]) {
        const result = await created({ transactionId: id, textContains: `${SHOP} ${[fromARule, byHand, aTransfer, alreadyIt].indexOf(id) + 1}`, categoryId: groceries! })
        expect(result, `Transaction ${id}`).toMatchObject({ categorised: 0, thisBy: 'override', overrideBecause: 'categorised' })
        expect(await stored(id), `Transaction ${id}`).toMatchObject({ override: groceries })
      }
      // Only three of those four changed an Override, and each of the four added a Rule.
      expect((await changeLog()).filter((entry) => entry.type === 'transaction')).toHaveLength(3)
      expect(await rules()).toHaveLength(5)
    })
  })

  describe('when a lot of Transactions match, Apply the Rules to all Transactions stays the way to do them', () => {
    it(`gives ${MAX_INLINE_APPLY} others the Category, and no more`, async () => {
      const { groceries } = categories
      const here = await made({ description: SHOP })
      await manyMade(MAX_INLINE_APPLY, `${SHOP} `)

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result).toMatchObject({ categorised: MAX_INLINE_APPLY + 1, thisBy: 'rule', moreUncategorised: null })
      expect(await countWhere(`rule_id = ${result.id}`)).toBe(MAX_INLINE_APPLY + 1)
    })

    it('with more, saves the Rule and gives this Transaction the Category, leaves the others for the re-run, and says how many', async () => {
      const { groceries } = categories
      const here = await made({ description: SHOP })
      await manyMade(MAX_INLINE_APPLY + 25, `${SHOP} `)

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result).toMatchObject({ categorised: 1, thisBy: 'rule', moreUncategorised: MAX_INLINE_APPLY + 25 })
      expect(await rules()).toHaveLength(1)
      expect(await stored(here)).toMatchObject({ ruleId: result.id })
      expect(await countWhere('rule_id IS NOT NULL')).toBe(1)
      expect(await changeLog()).toMatchObject([{ summary: expect.stringContaining('Added a Rule') }, { summary: 'Gave 1 Transaction the Category Groceries with the new Rule (Rule 1)' }])

      // The button the Rules page has gives the rest the Category, and this one is as the re-run would have it.
      expect((await call('/api/rules/rerun', { method: 'POST', body: {} })).status).toBe(201)
      let job: { status: string } | null = { status: 'running' }
      for (let step = 0; step < 10 && job?.status === 'running'; step++) job = ((await (await call('/api/rules/rerun/step', { method: 'POST', body: {} })).json()) as { job: { status: string } | null }).job
      expect(job).toMatchObject({ status: 'done' })
      expect(await countWhere(`rule_category = ${groceries}`)).toBe(MAX_INLINE_APPLY + 26)
    })

    it('counts only the Uncategorised ones towards the limit: a text that many Transactions with a Category match does not stop the rest being given theirs', async () => {
      const { groceries, fuel } = categories
      const here = await made({ description: SHOP })
      await manyMade(MAX_INLINE_APPLY + 100, `${SHOP} CHOSEN `)
      await env.DB.prepare('UPDATE transactions SET override_category = ? WHERE description LIKE ?').bind(fuel, `${SHOP} CHOSEN %`).run()
      await manyMade(5, `${SHOP} FREE `)

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result).toMatchObject({ categorised: 6, moreUncategorised: null })
      expect(await countWhere(`override_category = ${fuel}`)).toBe(MAX_INLINE_APPLY + 100)
      expect(await countWhere(`rule_id = ${result.id}`)).toBe(6)
    })

    it('with more, and this Transaction not matched by the text, gives it an Override and nothing else', async () => {
      const { groceries } = categories
      const here = await made({ description: 'SOMETHING ELSE' })
      await manyMade(MAX_INLINE_APPLY + 1, `${SHOP} `)

      const result = await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

      expect(result).toMatchObject({ categorised: 0, thisBy: 'override', moreUncategorised: MAX_INLINE_APPLY + 1 })
      expect(await countWhere('rule_id IS NOT NULL')).toBe(0)
      expect(await stored(here)).toMatchObject({ override: groceries })
    })
  })

  it('sends a re-run that is going back to the first Transaction, as any change to the Rules does', async () => {
    const { groceries, fuel } = categories
    const earlier = await addRule({ textContains: 'NOTHING THAT MATCHES', categoryId: fuel })
    expect(earlier).toBeGreaterThan(0)
    const here = await made({ description: SHOP })
    await manyMade(1100, 'EXAMPLE FILLER ') // more than a step of the run looks at, so the run is still going when the Rule is made
    expect((await call('/api/rules/rerun', { method: 'POST', body: {} })).status).toBe(201)
    await call('/api/rules/rerun/step', { method: 'POST', body: {} })
    expect((await env.DB.prepare("SELECT cursor FROM data_migration_progress WHERE status = 'running'").first<{ cursor: number }>())!.cursor).toBeGreaterThan(0)

    await created({ transactionId: here, textContains: SHOP, categoryId: groceries! })

    expect(await env.DB.prepare("SELECT cursor, restarts FROM data_migration_progress WHERE status = 'running'").first()).toEqual({ cursor: 0, restarts: 1 })
  })
})

describe('what it refuses, and writes nothing for', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ transactionId: 0, textContains: SHOP, categoryId: categories.groceries, ...extra })
  const nothingWritten = async () => {
    expect(await rules()).toHaveLength(0)
    expect(await changeLog()).toEqual([])
    expect(await countWhere('rule_id IS NOT NULL OR override_category IS NOT NULL')).toBe(0)
  }

  it.each([
    ['no text', { textContains: undefined }, 'textContains'],
    ['blank text', { textContains: '   ' }, 'textContains'],
    ['text over 100 characters', { textContains: 'x'.repeat(101) }, 'textContains'],
    ['text that is a number', { textContains: 5 }, 'textContains'],
    ['a direction that is neither', { direction: 'sideways' }, 'direction'],
    ['no Category', { categoryId: undefined }, 'categoryId'],
    ['a Category that is not a whole number above zero', { categoryId: 0 }, 'categoryId'],
    ['no Transaction', { transactionId: undefined }, 'transactionId'],
    ['a Transaction that is not a whole number above zero', { transactionId: -3 }, 'transactionId'],
    ['a criterion the panel does not offer', { bankType: 'EFTPOS' }, ''],
  ])('%s: 400', async (_name, change, field) => {
    const here = await made({ description: SHOP })
    const res = await create({ ...body({ transactionId: here }), ...change })

    expect(res.status).toBe(400)
    // It names the field and never what was in it.
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
    await nothingWritten()
  })

  it('a Category that is not there, or was removed: 400, naming the Category', async () => {
    const here = await made({ description: SHOP })
    const removed = await categoryId('Fuel')
    await env.DB.prepare('UPDATE categories SET removed_at = ? WHERE id = ?').bind('2026-01-01T00:00:00Z', removed).run()

    for (const id of [removed, 999_999]) {
      const res = await create(body({ transactionId: here, categoryId: id }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'categoryId' })
    }
    await nothingWritten()
  })

  it('a Transaction that is not there: 404', async () => {
    const res = await create(body({ transactionId: 999_999 }))

    expect(res.status).toBe(404)
    await nothingWritten()
  })

  it('a Member: 403', async () => {
    const here = await made({ description: SHOP })
    const res = await create(body({ transactionId: here }), { who: 'member' })

    expect(res.status).toBe(403)
    await nothingWritten()
  })

  it('another site: 403', async () => {
    const here = await made({ description: SHOP })
    const res = await create(body({ transactionId: here }), { origin: 'https://example.invalid' })

    expect(res.status).toBe(403)
    await nothingWritten()
  })

  it('a body that is not JSON: 415', async () => {
    const here = await made({ description: SHOP })
    const res = await create(body({ transactionId: here }), { contentType: 'text/plain' })

    expect(res.status).toBe(415)
    await nothingWritten()
  })

  it(`a ${MAX_RULES + 1}st Rule: 409, and nothing else is changed`, async () => {
    await env.DB.batch(Array.from({ length: MAX_RULES }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 1, `filler ${i}`, categories.fuel)))
    const here = await made({ description: SHOP })
    const other = await made({ description: `${SHOP} 2` })

    const res = await create(body({ transactionId: here }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: `There are already ${MAX_RULES} Rules; remove one first` })
    expect(await stored(here)).toMatchObject({ override: null, ruleId: null })
    expect(await stored(other)).toMatchObject({ ruleId: null })
    expect(await changeLog()).toEqual([])
  })
})

describe('when another request lands between its reads and its batch', () => {
  const request = (transactionId: number) => ({ transactionId, textContains: SHOP, categoryId: categories.groceries })

  it('the last place taken: 409, and no Override, no Category on a Transaction and no entry is written', async () => {
    await env.DB.batch(Array.from({ length: MAX_RULES - 1 }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 1, `filler ${i}`, categories.fuel)))
    const matched = await made({ description: `${SHOP} 1` })
    const elsewhere = await made({ description: 'SOMEWHERE ELSE' }) // not matched by the text, so this one's Category would be an Override
    const takePlace = () => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(MAX_RULES, 'the last place', categories.fuel).run()

    for (const id of [matched, elsewhere]) {
      await env.DB.prepare('DELETE FROM rules WHERE text_contains = ?').bind('the last place').run()
      const res = await callWhileInterrupted('/api/rules/from-transaction', 'POST', request(id), takePlace)

      expect(res.status, `Transaction ${id}`).toBe(409)
      expect(await stored(id)).toMatchObject({ override: null, ruleId: null })
      expect(await stored(matched)).toMatchObject({ override: null, ruleId: null })
      expect(await changeLog()).toEqual([])
    }
  })

  it('the Category removed: 400, and nothing is written', async () => {
    const here = await made({ description: SHOP })
    const res = await callWhileInterrupted('/api/rules/from-transaction', 'POST', request(here), () => env.DB.prepare('UPDATE categories SET removed_at = ? WHERE id = ?').bind('2026-01-01T00:00:00Z', categories.groceries).run())

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'categoryId' })
    expect(await rules()).toHaveLength(0)
    expect(await stored(here)).toMatchObject({ override: null, ruleId: null })
    expect(await changeLog()).toEqual([])
  })

  it('the Admin giving a Transaction it was about to categorise a Category of their own: that one is left as they set it, and the others are given the Rule', async () => {
    const here = await made({ description: SHOP })
    const meanwhile = await made({ description: `${SHOP} 2` })
    const still = await made({ description: `${SHOP} 3` })

    const res = await callWhileInterrupted('/api/rules/from-transaction', 'POST', request(here), () => env.DB.prepare('UPDATE transactions SET override_category = ? WHERE id = ?').bind(categories.fuel, meanwhile).run())

    expect(res.status).toBe(201)
    expect(((await res.json()) as Created).categorised).toBe(2) // the count is what was written, not what was read
    expect(await stored(meanwhile)).toMatchObject({ override: categories.fuel, ruleId: null, ruleCategory: null })
    expect(await stored(still)).toMatchObject({ ruleCategory: categories.groceries })
  })
})

describe('what it costs (ADR 0004: 100,000 rows written and 5 million read a day on the free plan, 50 queries a request)', () => {
  const GROCERIES = () => categories.groceries!

  /** Makes the Rule through a metered database. */
  async function metered(body: Body) {
    const { db, usage } = meteredDb()
    const res = await callAsAdminWith(db, '/api/rules/from-transaction', 'POST', body)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
    return { usage, result: (await res.json()) as Created }
  }

  it('writes two rows for each Transaction it categorises (its row and its entry in the Category index) and a few more for the Rule and its entries, in a few queries', async () => {
    const written: number[] = []
    for (const others of [10, 60]) {
      await env.DB.batch(['transactions', 'rules', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
      const here = await made({ description: SHOP })
      await manyMade(others, `${SHOP} `)
      const { usage, result } = await metered({ transactionId: here, textContains: SHOP, categoryId: GROCERIES() })
      expect(result.categorised).toBe(others + 1)
      expect(usage.queries).toBeLessThanOrEqual(12)
      written.push(usage.rowsWritten)
    }
    // 50 more Transactions are 100 more rows written, and nothing else grows.
    expect(written[1]! - written[0]!).toBe(100)
    // What there is besides: the Rule (its row, its entry in rules_position and the count of IDs given out), its two Change Log entries (a row and an index entry each), and the
    // re-run's restart, which writes nothing when none is going.
    expect(written[0]).toBe(2 * 11 + FIXED_WRITES)
    // At the limit, a request writes about a thousand of the day's 100,000 rows.
    expect(2 * (MAX_INLINE_APPLY + 1) + FIXED_WRITES).toBeLessThan(1100)
  })

  it('reads each Transaction once to find the ones that match, and some for each one it categorises', async () => {
    const HISTORY = 3000
    await env.DB.batch(Array.from({ length: 30 }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 1, `NO SUCH SHOP ${i}`, categories.fuel)))
    await manyMade(HISTORY, 'EXAMPLE OLD ')
    const here = await made({ description: SHOP })
    await manyMade(100, `${SHOP} `)

    const { usage, result } = await metered({ transactionId: here, textContains: SHOP, categoryId: GROCERIES() })

    expect(result.categorised).toBe(101)
    // The walk reads every Transaction once (3,101 rows). Each of the 100 others then walks the 30 Rules above the new one (a read each, as in rule-rerun.ts) and is updated by its ID.
    // Measured: 7,438. A walk that read the criteria again for each Transaction was 10,522.
    expect(usage.rowsRead).toBeLessThanOrEqual(HISTORY + 101 + 101 * (30 + 15))
  })

  it('with too many to do now, finds that out without reading the history to its end, counts them, and writes only the Rule and this Transaction', async () => {
    const HISTORY = 2000
    const MATCHES = 2000
    await manyMade(HISTORY, 'EXAMPLE OLD ')
    const here = await made({ description: SHOP })
    await manyMade(MATCHES, `${SHOP} `)
    const rows = HISTORY + MATCHES + 1

    const { usage, result } = await metered({ transactionId: here, textContains: SHOP, categoryId: GROCERIES() })

    expect(result).toMatchObject({ categorised: 1, moreUncategorised: MATCHES })
    // The pass that looks for the others stops at the 501st it finds, so it reads the history and 501 more; then the count reads everything. Without the stop it is twice `rows`.
    expect(usage.rowsRead).toBeLessThanOrEqual(rows + HISTORY + MAX_INLINE_APPLY + 200)
    expect(usage.rowsWritten).toBeLessThanOrEqual(2 + FIXED_WRITES)
  })
})

/** The rows written besides two for each Transaction categorised: the Rule (3) and two Change Log entries (2 each), measured. */
const FIXED_WRITES = 7
