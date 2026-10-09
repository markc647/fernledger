import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RULES } from './rule-criteria'
import { afterTransactionsChanged } from './transactions-changed'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only; Access token handling is tested in api.test.ts).
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

type Rule = {
  id: number
  textContains: string | null
  bankType: string | null
  direction: 'in' | 'out' | null
  minCents: number | null
  maxCents: number | null
  categoryId: number | null
  categoryName: string | null
  categoryRemoved: boolean
  transfer: boolean
}
type Row = { id: number; description: string; categoryId: number | null; categoryName: string | null; categorySource: string | null }
type Preview = { matches: number; samples: { id: number; date: string; description: string; amountCents: number }[] }

const rules = async (who: Who = 'member'): Promise<Rule[]> => (await call('/api/rules', { who })).json()
const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id
const list = async (query = ''): Promise<{ total: number; transactions: Row[] }> => (await call(`/api/transactions${query}`)).json()
const rowFor = async (description: string) => (await list('?limit=200')).transactions.find((t) => t.description === description)!
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, type, before, after FROM change_log ORDER BY id').all()).results
const preview = async (body: unknown, who: Who = 'admin') => call('/api/rules/preview', { who, method: 'POST', body })

/** Saves a Rule and returns its ID. `body` needs a target: `categoryId` or `transfer: true`. */
async function addRule(body: Record<string, unknown>) {
  const res = await call('/api/rules', { method: 'POST', body })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return ((await res.json()) as { id: number }).id
}

let accountId = 0
let uniqueId = 0
type Made = { description: string; memo?: string; type?: string; cents?: number; date?: string }

/** Adds a made-up Transaction straight to the database, so the Rules have never seen it. Returns its ID. */
async function history(t: Made) {
  const { meta } = await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, bank_type, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(accountId, t.date ?? '2026-10-01', t.cents ?? -1000, t.description, t.memo ?? '', t.type ?? 'EFTPOS', 'import')
    .run()
  return meta.last_row_id
}

/** Imports made-up Transactions through the real Import route, which applies the Rules to the rows it adds. */
async function importRows(rows: Made[]) {
  const res = await call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account: { number: '99-9999-9999999-99' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows: rows.map((t) => ({ date: t.date ?? '2026-10-05', uniqueId: `RULE${++uniqueId}`, tranType: t.type ?? 'EFTPOS', chequeNumber: null, payee: t.description, bankMemo: t.memo ?? '', amountCents: t.cents ?? -1000 })),
    },
  })
  expect(res.status).toBe(200)
}

type CategoryRecord = { id: number; name: string }
let starters: CategoryRecord[] = []
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

beforeEach(async () => {
  await env.DB.batch(['transactions', 'rules', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  // Back to the starter list as migrated, so no test depends on what an earlier one added, renamed or removed.
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(c.id, c.name)))
  accountId = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example') RETURNING id").first<{ id: number }>())!.id
  uniqueId = 0
})

describe('adding a Rule', () => {
  it('lets the Admin add one, puts it last in priority, and logs it', async () => {
    const groceries = await categoryId('Groceries')
    const res = await call('/api/rules', { method: 'POST', body: { textContains: '  Woolworths ', bankType: 'EFTPOS', direction: 'out', minCents: 1000, maxCents: 20000, categoryId: groceries } })

    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const second = await addRule({ textContains: 'fuel', categoryId: await categoryId('Fuel') })
    expect(await rules()).toEqual([
      { id, textContains: 'Woolworths', bankType: 'EFTPOS', direction: 'out', minCents: 1000, maxCents: 20000, categoryId: groceries, categoryName: 'Groceries', categoryRemoved: false, transfer: false },
      { id: second, textContains: 'fuel', bankType: null, direction: null, minCents: null, maxCents: null, categoryId: await categoryId('Fuel'), categoryName: 'Fuel', categoryRemoved: false, transfer: false },
    ])
    const [entry] = await changeLog()
    expect(entry).toMatchObject({
      summary: 'Added a Rule: text contains "Woolworths" and type is EFTPOS and money out and amount from $10.00 to $200.00, category Groceries',
      actor: 'admin@example.com',
      type: 'rule',
      before: null,
    })
    expect(JSON.parse(entry!.after as string)).toEqual({ textContains: 'Woolworths', transactionType: 'EFTPOS', moneyDirection: 'Money out', amountFrom: '$10.00', amountTo: '$200.00', category: 'Groceries', transfer: false })
  })

  it('lets a Rule mark Transfers instead of choosing a Category', async () => {
    const id = await addRule({ textContains: 'ROUND UP', transfer: true })

    expect(await rules()).toEqual([
      { id, textContains: 'ROUND UP', bankType: null, direction: null, minCents: null, maxCents: null, categoryId: null, categoryName: null, categoryRemoved: false, transfer: true },
    ])
    expect(await changeLog()).toMatchObject([{ summary: 'Added a Rule: text contains "ROUND UP", marked as a Transfer', type: 'rule' }])
  })

  it('takes a lone amount limit or a lone direction as a criterion', async () => {
    const groceries = await categoryId('Groceries')
    await addRule({ minCents: 500, categoryId: groceries })
    await addRule({ maxCents: 0, categoryId: groceries })
    await addRule({ direction: 'in', categoryId: groceries })
    expect((await rules()).map((r) => [r.minCents, r.maxCents, r.direction])).toEqual([[500, null, null], [null, 0, null], [null, null, 'in']])
  })

  describe('refuses a bad request, naming only the field, writing nothing and logging nothing', () => {
    const cases: [string, string, (groceries: number) => Record<string, unknown>][] = [
      ['no criteria at all', 'criteria', (g) => ({ categoryId: g })],
      ['only blank text', 'textContains', (g) => ({ textContains: '   ', categoryId: g })],
      ['null criteria', 'criteria', (g) => ({ textContains: null, bankType: null, direction: null, minCents: null, maxCents: null, categoryId: g })],
      ['text over 100 characters', 'textContains', (g) => ({ textContains: 'x'.repeat(101), categoryId: g })],
      ['text that is not text', 'textContains', (g) => ({ textContains: 5, categoryId: g })],
      ['a type over 40 characters', 'bankType', (g) => ({ bankType: 'x'.repeat(41), categoryId: g })],
      ['a direction that is not in or out', 'direction', (g) => ({ direction: 'sideways', textContains: 'a', categoryId: g })],
      ['a negative minimum', 'minCents', (g) => ({ minCents: -1, categoryId: g })],
      ['a minimum that is a fraction', 'minCents', (g) => ({ minCents: 10.5, categoryId: g })],
      ['a minimum over the largest amount', 'minCents', (g) => ({ minCents: 100_000_000_001, categoryId: g })],
      ['a maximum that is text', 'maxCents', (g) => ({ maxCents: '5', categoryId: g })],
      ['a maximum below the minimum', 'maxCents', (g) => ({ minCents: 2000, maxCents: 1999, categoryId: g })],
      ['neither a Category nor Transfer', 'categoryId', () => ({ textContains: 'a' })],
      ['a Category and Transfer together', 'categoryId', (g) => ({ textContains: 'a', categoryId: g, transfer: true })],
      ['a Category that is not a number', 'categoryId', () => ({ textContains: 'a', categoryId: 'Groceries' })],
      ['a Category that is zero', 'categoryId', () => ({ textContains: 'a', categoryId: 0 })],
      ['a Category that is not there', 'categoryId', () => ({ textContains: 'a', categoryId: 999999 })],
      ['a Transfer flag that is not true or false', 'transfer', () => ({ textContains: 'a', transfer: 'yes' })],
    ]

    it.each(cases)('%s', async (_why, field, body) => {
      const res = await call('/api/rules', { method: 'POST', body: body(await categoryId('Groceries')) })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
      expect(await rules()).toEqual([])
      expect(await changeLog()).toEqual([])
    })

    it('including a Category that has been removed', async () => {
      const gone = (await env.DB.prepare("INSERT INTO categories (name, removed_at) VALUES ('Test Gone', '2026-10-01T00:00:00.000Z') RETURNING id").first<{ id: number }>())!.id
      const res = await call('/api/rules', { method: 'POST', body: { textContains: 'a', categoryId: gone } })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'categoryId' })
      expect(await rules()).toEqual([])
    })

    it('without echoing what was typed', async () => {
      const res = await call('/api/rules', { method: 'POST', body: { textContains: 'SECRET-'.repeat(20), categoryId: await categoryId('Groceries') } })
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('SECRET')
    })
  })

  it('takes exactly the largest text, type and amount, and refuses a hundred and first Rule', async () => {
    const groceries = await categoryId('Groceries')
    await addRule({ textContains: 'x'.repeat(100), bankType: 'y'.repeat(40), maxCents: 100_000_000_000, categoryId: groceries })

    await env.DB.batch(Array.from({ length: MAX_RULES - 1 }, (_, i) => env.DB.prepare('INSERT INTO rules (position, text_contains, category_id) VALUES (?, ?, ?)').bind(i + 2, `filler ${i}`, groceries)))
    const res = await call('/api/rules', { method: 'POST', body: { textContains: 'one too many', categoryId: groceries } })

    expect(res.status).toBe(409)
    expect(await res.text()).not.toContain('one too many')
    expect((await rules()).length).toBe(MAX_RULES)
  })
})

describe('changing a Rule', () => {
  it('replaces its criteria and target, keeps its place in the order, and logs before and after', async () => {
    const first = await addRule({ textContains: 'wool', categoryId: await categoryId('Groceries') })
    const second = await addRule({ textContains: 'bp', categoryId: await categoryId('Fuel') })
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call(`/api/rules/${first}`, { method: 'PUT', body: { textContains: 'woolworths', direction: 'out', transfer: true } })

    expect(res.status).toBe(200)
    expect((await rules()).map((r) => r.id)).toEqual([first, second])
    expect((await rules())[0]).toMatchObject({ textContains: 'woolworths', direction: 'out', categoryId: null, transfer: true })
    const [entry] = await changeLog()
    expect(entry).toMatchObject({ summary: 'Changed a Rule: text contains "woolworths" and money out, marked as a Transfer', type: 'rule', actor: 'admin@example.com' })
    expect(JSON.parse(entry!.before as string)).toMatchObject({ textContains: 'wool', category: 'Groceries', transfer: false })
    expect(JSON.parse(entry!.after as string)).toMatchObject({ textContains: 'woolworths', moneyDirection: 'Money out', category: null, transfer: true })
  })

  it('changes nothing, and logs nothing, when it is saved as it is', async () => {
    const id = await addRule({ textContains: 'wool', categoryId: await categoryId('Groceries') })
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call(`/api/rules/${id}`, { method: 'PUT', body: { textContains: ' wool ', categoryId: await categoryId('Groceries') } })

    expect(res.status).toBe(200)
    expect(await changeLog()).toEqual([])
  })

  it('refuses a bad request, naming only the field', async () => {
    const id = await addRule({ textContains: 'wool', categoryId: await categoryId('Groceries') })
    const before = await rules()
    await env.DB.prepare('DELETE FROM change_log').run()

    for (const [body, field] of [
      [{ categoryId: await categoryId('Groceries') }, 'criteria'],
      [{ textContains: 'a', minCents: 5, maxCents: 4, categoryId: await categoryId('Groceries') }, 'maxCents'],
      [{ textContains: 'a', categoryId: 999999 }, 'categoryId'],
      [{ textContains: 'a' }, 'categoryId'],
    ] as const) {
      const res = await call(`/api/rules/${id}`, { method: 'PUT', body })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
    }
    expect(await rules()).toEqual(before)
    expect(await changeLog()).toEqual([])
  })

  it.each(['999999', 'abc', '1.5'])('answers 404 for a Rule that is not there (%s)', async (id) => {
    const res = await call(`/api/rules/${id}`, { method: 'PUT', body: { textContains: 'a', categoryId: await categoryId('Groceries') } })
    expect(res.status).toBe(404)
  })
})

describe('removing a Rule', () => {
  it('takes it out of the list and the order, and logs it', async () => {
    const [a, b, c] = [
      await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') }),
      await addRule({ textContains: 'b', categoryId: await categoryId('Fuel') }),
      await addRule({ textContains: 'c', categoryId: await categoryId('Tax') }),
    ]
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call(`/api/rules/${b}`, { method: 'DELETE', body: {} })

    expect(res.status).toBe(200)
    expect((await rules()).map((r) => r.id)).toEqual([a, c])
    const [entry] = await changeLog()
    expect(entry).toMatchObject({ summary: 'Removed a Rule: text contains "b", category Fuel', type: 'rule', after: null })
    expect(JSON.parse(entry!.before as string)).toMatchObject({ textContains: 'b', category: 'Fuel' })
    // The row is kept (Transactions it categorised still point at it), but it is gone as far as the API is concerned.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM rules WHERE id = ?').bind(b).first<{ n: number }>())!.n).toBe(1)
  })

  it('stops it applying to new Transactions', async () => {
    const id = await addRule({ textContains: 'EXAMPLE WOOL', categoryId: await categoryId('Groceries') })
    await call(`/api/rules/${id}`, { method: 'DELETE', body: {} })

    await importRows([{ description: 'EXAMPLE WOOL 1' }])

    expect(await rowFor('EXAMPLE WOOL 1')).toMatchObject({ categoryId: null, categorySource: null })
  })

  it('answers 404 for a Rule already removed, or never there', async () => {
    const id = await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') })
    await call(`/api/rules/${id}`, { method: 'DELETE', body: {} })

    expect((await call(`/api/rules/${id}`, { method: 'DELETE', body: {} })).status).toBe(404)
    expect((await call('/api/rules/999999', { method: 'DELETE', body: {} })).status).toBe(404)
    expect((await call(`/api/rules/${id}`, { method: 'PUT', body: { textContains: 'a', transfer: true } })).status).toBe(404)
  })
})

describe('the priority order', () => {
  it('can be changed by the Admin, and is logged with the order before and after', async () => {
    const [a, b, c] = [
      await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') }),
      await addRule({ textContains: 'b', categoryId: await categoryId('Fuel') }),
      await addRule({ textContains: 'c', categoryId: await categoryId('Tax') }),
    ]
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call('/api/rules/order', { method: 'PUT', body: { ids: [c, a, b] } })

    expect(res.status).toBe(200)
    expect((await rules()).map((r) => r.id)).toEqual([c, a, b])
    const [entry] = await changeLog()
    expect(entry).toMatchObject({ summary: 'Changed the order of Rules', type: 'rule', actor: 'admin@example.com' })
    expect(JSON.parse(entry!.before as string)).toEqual({ order: ['text contains "a", category Groceries', 'text contains "b", category Fuel', 'text contains "c", category Tax'] })
    expect(JSON.parse(entry!.after as string)).toEqual({ order: ['text contains "c", category Tax', 'text contains "a", category Groceries', 'text contains "b", category Fuel'] })
  })

  it('gives a new Rule the last place, even after others were removed or moved', async () => {
    const [a, b] = [await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') }), await addRule({ textContains: 'b', categoryId: await categoryId('Fuel') })]
    await call('/api/rules/order', { method: 'PUT', body: { ids: [b, a] } })
    await call(`/api/rules/${b}`, { method: 'DELETE', body: {} })

    const c = await addRule({ textContains: 'c', categoryId: await categoryId('Tax') })

    expect((await rules()).map((r) => r.id)).toEqual([a, c])
  })

  it('changes nothing, and logs nothing, when it stays as it is', async () => {
    const [a, b] = [await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') }), await addRule({ textContains: 'b', categoryId: await categoryId('Fuel') })]
    await env.DB.prepare('DELETE FROM change_log').run()

    expect((await call('/api/rules/order', { method: 'PUT', body: { ids: [a, b] } })).status).toBe(200)
    expect(await changeLog()).toEqual([])
  })

  it('refuses a list that is not exactly the Rules in use, so a stale page cannot drop or revive one', async () => {
    const [a, b] = [await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') }), await addRule({ textContains: 'b', categoryId: await categoryId('Fuel') })]
    const gone = await addRule({ textContains: 'gone', categoryId: await categoryId('Tax') })
    await call(`/api/rules/${gone}`, { method: 'DELETE', body: {} })
    await env.DB.prepare('DELETE FROM change_log').run()

    for (const ids of [[a], [a, b, 999999], [a, a], [b, a, gone], [], 'a,b']) {
      const res = await call('/api/rules/order', { method: 'PUT', body: { ids } })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'ids' })
    }
    expect((await rules()).map((r) => r.id)).toEqual([a, b])
    expect(await changeLog()).toEqual([])
  })

  it('names the place in the list of an ID that is not a whole number above zero', async () => {
    const [a, b] = [await addRule({ textContains: 'a', categoryId: await categoryId('Groceries') }), await addRule({ textContains: 'b', categoryId: await categoryId('Fuel') })]
    for (const [ids, field] of [[[a, 'b'], 'ids.1'], [[0, b], 'ids.0'], [[a, 1.5], 'ids.1']] as const) {
      const res = await call('/api/rules/order', { method: 'PUT', body: { ids } })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
    }
  })

  it('decides which Rule wins when two match: the one higher in the order', async () => {
    const fuel = await categoryId('Fuel')
    const groceries = await categoryId('Groceries')
    const general = await addRule({ textContains: 'EXAMPLE MART', categoryId: groceries })
    const specific = await addRule({ textContains: 'EXAMPLE MART FUEL', categoryId: fuel })
    await importRows([{ description: 'EXAMPLE MART FUEL 1' }])
    // The general Rule is first, so it wins even though the specific one matches better.
    expect(await rowFor('EXAMPLE MART FUEL 1')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })

    await call('/api/rules/order', { method: 'PUT', body: { ids: [specific, general] } })
    await importRows([{ description: 'EXAMPLE MART FUEL 2' }, { description: 'EXAMPLE MART 3' }])

    expect(await rowFor('EXAMPLE MART FUEL 2')).toMatchObject({ categoryName: 'Fuel', categorySource: 'rule' })
    expect(await rowFor('EXAMPLE MART 3')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
    // What was saved on the first Transaction stays as it was: moving a Rule applies to new Transactions only.
    expect(await rowFor('EXAMPLE MART FUEL 1')).toMatchObject({ categoryName: 'Groceries' })
  })
})

describe('what a Rule matches', () => {
  /** How many of the Transactions on file a Rule with these criteria matches. */
  const matches = async (criteria: Record<string, unknown>) => {
    const res = await preview(criteria)
    expect(res.status).toBe(200)
    return ((await res.json()) as Preview).matches
  }

  beforeEach(async () => {
    await history({ description: 'EXAMPLE WOOLWORTHS METRO', memo: 'Card 1234', type: 'EFTPOS', cents: -4550 })
    await history({ description: 'Example Pak n Save', memo: 'Shopping for woolen goods', type: 'EFTPOS', cents: -12000 })
    await history({ description: 'EXAMPLE EMPLOYER', memo: 'Pay', type: 'DIRECT CREDIT', cents: 250000 })
    await history({ description: 'EXAMPLE REFUND', memo: '', type: 'EFTPOS', cents: 4550 })
    await history({ description: '50% off_sale', memo: '', type: 'AUTO PAYMENT', cents: -500 })
  })

  describe('text', () => {
    it('is found anywhere in the description, ignoring capitals', async () => {
      expect(await matches({ textContains: 'woolworths' })).toBe(1)
      expect(await matches({ textContains: 'PAK N' })).toBe(1)
      expect(await matches({ textContains: 'EXAMPLE' })).toBe(4)
    })

    it('is also found in the bank memo', async () => {
      expect(await matches({ textContains: 'woolen' })).toBe(1)
      expect(await matches({ textContains: 'card 1234' })).toBe(1)
    })

    it('takes % and _ as the characters they are, not as wildcards', async () => {
      expect(await matches({ textContains: '%' })).toBe(1)
      expect(await matches({ textContains: '_' })).toBe(1)
      expect(await matches({ textContains: '50% off_' })).toBe(1)
      expect(await matches({ textContains: 'e%l' })).toBe(0)
      expect(await matches({ textContains: 'woo_worths' })).toBe(0)
    })

    it('matches nothing that is not there', async () => {
      expect(await matches({ textContains: 'no such shop' })).toBe(0)
    })
  })

  describe('transaction type', () => {
    it('is the bank type exactly, ignoring capitals', async () => {
      expect(await matches({ bankType: 'eftpos' })).toBe(3)
      expect(await matches({ bankType: 'DIRECT CREDIT' })).toBe(1)
    })

    it('is not a part of it', async () => {
      expect(await matches({ bankType: 'EFT' })).toBe(0)
      expect(await matches({ bankType: 'CREDIT' })).toBe(0)
    })
  })

  describe('amount range', () => {
    it('is the size of the amount, whether money went in or out, and includes both ends', async () => {
      expect(await matches({ minCents: 4550 })).toBe(4) // 45.50 out, 120.00 out, 2,500.00 in, 45.50 in
      expect(await matches({ minCents: 4551 })).toBe(2)
      expect(await matches({ maxCents: 4550 })).toBe(3) // 45.50 out, 45.50 in, 5.00 out
      expect(await matches({ maxCents: 4549 })).toBe(1)
      expect(await matches({ minCents: 4550, maxCents: 12000 })).toBe(3)
      expect(await matches({ minCents: 12000, maxCents: 12000 })).toBe(1)
    })

    it('can be limited to money in or money out', async () => {
      expect(await matches({ direction: 'in' })).toBe(2)
      expect(await matches({ direction: 'out' })).toBe(3)
      expect(await matches({ direction: 'out', minCents: 4550, maxCents: 4550 })).toBe(1)
      expect(await matches({ direction: 'in', minCents: 4550, maxCents: 4550 })).toBe(1)
    })

    it('treats a maximum of zero as matching only $0.00 Transactions', async () => {
      expect(await matches({ maxCents: 0 })).toBe(0)
      await history({ description: 'EXAMPLE NOTHING', cents: 0 })
      expect(await matches({ maxCents: 0 })).toBe(1)
      expect(await matches({ direction: 'in' })).toBe(2) // a $0.00 Transaction is neither money in nor money out
      expect(await matches({ direction: 'out' })).toBe(3)
    })
  })

  it('needs every criterion to match', async () => {
    expect(await matches({ textContains: 'example', bankType: 'EFTPOS', direction: 'in' })).toBe(1)
    expect(await matches({ textContains: 'example', bankType: 'EFTPOS', direction: 'in', minCents: 5000 })).toBe(0)
    expect(await matches({ textContains: 'woolworths', bankType: 'DIRECT CREDIT' })).toBe(0)
  })

  it('ignores Rules already saved, the Override on a Transaction and its Category: it counts what the criteria match', async () => {
    await addRule({ textContains: 'woolworths', categoryId: await categoryId('Groceries') })
    const t = await history({ description: 'EXAMPLE WOOLWORTHS NORTH' })
    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: await categoryId('Fuel') } })

    expect(await matches({ textContains: 'woolworths' })).toBe(2)
  })
})

describe('the preview', () => {
  const dated = (n: number) => `2026-09-${String(n).padStart(2, '0')}`

  it('counts the matching Transactions and shows the newest few, without saving anything', async () => {
    for (let n = 1; n <= 8; n++) await history({ description: `EXAMPLE SHOP ${n}`, date: dated(n), cents: -100 * n })
    await history({ description: 'EXAMPLE PHARMACY', date: dated(20) })

    const res = await preview({ textContains: 'example shop' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Preview
    expect(body.matches).toBe(8)
    expect(body.samples).toEqual([8, 7, 6, 5, 4].map((n) => ({ id: expect.any(Number), date: dated(n), description: `EXAMPLE SHOP ${n}`, amountCents: -100 * n })))
    expect(await rules()).toEqual([])
    expect(await changeLog()).toEqual([])
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE rule_id IS NOT NULL').first<{ n: number }>())!.n).toBe(0)
  })

  it('shows no samples when nothing matches', async () => {
    await history({ description: 'EXAMPLE SHOP' })
    expect(await (await preview({ textContains: 'zzz' })).json()).toEqual({ matches: 0, samples: [] })
  })

  it('needs no target: it asks only how many a set of criteria would match', async () => {
    await history({ description: 'EXAMPLE SHOP' })
    expect(await (await preview({ textContains: 'example' })).json()).toMatchObject({ matches: 1 })
  })

  it('refuses criteria that would match everything, or are malformed, naming only the field', async () => {
    for (const [body, field] of [
      [{}, 'criteria'],
      [{ textContains: '  ' }, 'textContains'],
      [{ textContains: 'a', direction: 'up' }, 'direction'],
      [{ minCents: 10, maxCents: 5 }, 'maxCents'],
      [{ minCents: -5 }, 'minCents'],
    ] as const) {
      const res = await preview(body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
    }
  })

  it('is for the Admin: a Member is refused, and nothing is read or written', async () => {
    await history({ description: 'EXAMPLE SHOP' })
    const res = await preview({ textContains: 'example' }, 'member')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Read-only' })
  })
})

describe('new Transactions', () => {
  it('get the first matching Rule when an Import adds them, and show it as the source of their Category', async () => {
    const groceries = await categoryId('Groceries')
    await addRule({ textContains: 'EXAMPLE SUPER', categoryId: groceries })

    await importRows([{ description: 'EXAMPLE SUPER 1' }, { description: 'EXAMPLE OTHER' }])

    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryId: groceries, categoryName: 'Groceries', categorySource: 'rule' })
    expect(await rowFor('EXAMPLE OTHER')).toMatchObject({ categoryId: null, categoryName: null, categorySource: null })
    expect((await list('?uncategorised=true')).transactions.map((t) => t.description)).toEqual(['EXAMPLE OTHER'])
  })

  it('are matched on every criterion, in the real Import path', async () => {
    const fuel = await categoryId('Fuel')
    await addRule({ textContains: 'EXAMPLE FUEL', bankType: 'EFTPOS', direction: 'out', minCents: 2000, maxCents: 20000, categoryId: fuel })

    await importRows([
      { description: 'EXAMPLE FUEL yes', cents: -5000 },
      { description: 'EXAMPLE FUEL small', cents: -1999 },
      { description: 'EXAMPLE FUEL large', cents: -20001 },
      { description: 'EXAMPLE FUEL refund', cents: 5000 },
      { description: 'EXAMPLE FUEL wrong type', cents: -5000, type: 'AUTO PAYMENT' },
      { description: 'EXAMPLE OTHER', cents: -5000 },
    ])

    const got = Object.fromEntries((await list('?limit=200')).transactions.map((t) => [t.description, t.categoryName]))
    expect(got).toEqual({
      'EXAMPLE FUEL yes': 'Fuel',
      'EXAMPLE FUEL small': null,
      'EXAMPLE FUEL large': null,
      'EXAMPLE FUEL refund': null,
      'EXAMPLE FUEL wrong type': null,
      'EXAMPLE OTHER': null,
    })
  })

  it('are only the ones the Import added: history on file is not touched by a Rule being saved or by a later Import', async () => {
    const old = await history({ description: 'EXAMPLE SUPER old' })
    await addRule({ textContains: 'EXAMPLE SUPER', categoryId: await categoryId('Groceries') })
    expect(await rowFor('EXAMPLE SUPER old')).toMatchObject({ categoryName: null })

    await importRows([{ description: 'EXAMPLE SUPER new' }])

    expect(await rowFor('EXAMPLE SUPER new')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
    expect(await rowFor('EXAMPLE SUPER old')).toMatchObject({ categoryName: null, categorySource: null })
    expect(await env.DB.prepare('SELECT rule_id, rule_category, rule_transfer FROM transactions WHERE id = ?').bind(old).first()).toEqual({ rule_id: null, rule_category: null, rule_transfer: null })
  })

  it('are left as they are when a repeated Import adds nothing', async () => {
    await importRows([{ description: 'EXAMPLE SUPER 1' }])
    await addRule({ textContains: 'EXAMPLE SUPER', categoryId: await categoryId('Groceries') })

    const res = await call('/api/imports/chunks', {
      method: 'POST',
      body: {
        account: { number: '99-9999-9999999-99' },
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
        rows: [{ date: '2026-10-05', uniqueId: 'RULE1', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SUPER 1', bankMemo: '', amountCents: -1000 }],
      },
    })

    expect(await res.json()).toMatchObject({ added: 0, duplicates: 1 })
    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryName: null })
  })

  it('can be marked as Transfers by a Rule, which stores the flag for Transfer pairing and gives them no Category', async () => {
    await addRule({ textContains: 'ROUND UP', transfer: true })

    await importRows([{ description: 'EXAMPLE ROUND UP 1' }, { description: 'EXAMPLE OTHER' }])

    const flagged = await env.DB.prepare('SELECT description, rule_transfer, rule_category FROM transactions ORDER BY id').all()
    expect(flagged.results).toEqual([
      { description: 'EXAMPLE ROUND UP 1', rule_transfer: 1, rule_category: null },
      { description: 'EXAMPLE OTHER', rule_transfer: null, rule_category: null },
    ])
    expect(await rowFor('EXAMPLE ROUND UP 1')).toMatchObject({ categoryId: null })
  })

  it('are taken by a Transfer Rule that matches, and go on to the Rule below when it does not', async () => {
    const groceries = await categoryId('Groceries')
    await addRule({ textContains: 'EXAMPLE X', direction: 'out', transfer: true })
    await addRule({ textContains: 'EXAMPLE X', categoryId: groceries })

    await importRows([{ description: 'EXAMPLE X out', cents: -100 }, { description: 'EXAMPLE X in', cents: 100 }])

    expect(await rowFor('EXAMPLE X in')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
    expect(await rowFor('EXAMPLE X out')).toMatchObject({ categoryName: null })
    const flags = await env.DB.prepare('SELECT description, rule_transfer FROM transactions ORDER BY id').all()
    expect(flags.results).toEqual([
      { description: 'EXAMPLE X out', rule_transfer: 1 },
      { description: 'EXAMPLE X in', rule_transfer: null },
    ])
  })
})

describe('the hook that runs after Transactions change', () => {
  it('applies Rules to the Account\'s Transactions after the given ID, and to no others', async () => {
    const groceries = await categoryId('Groceries')
    await addRule({ textContains: 'EXAMPLE', categoryId: groceries })
    const other = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-98', 'Other') RETURNING id").first<{ id: number }>())!.id
    const before = await history({ description: 'EXAMPLE before' })
    const mine = await history({ description: 'EXAMPLE mine' })
    await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, source) VALUES (?, ?, ?, ?, ?)').bind(other, '2026-10-01', -100, 'EXAMPLE other account', 'import').run()

    await afterTransactionsChanged(env.DB, { accountId, afterId: before })

    const stored = await env.DB.prepare('SELECT description, rule_category FROM transactions ORDER BY id').all()
    expect(stored.results).toEqual([
      { description: 'EXAMPLE before', rule_category: null },
      { description: 'EXAMPLE mine', rule_category: groceries },
      { description: 'EXAMPLE other account', rule_category: null },
    ])
    expect(mine).toBeGreaterThan(before)
  })

  it('applies nothing when told no Transactions were added', async () => {
    await addRule({ textContains: 'EXAMPLE', categoryId: await categoryId('Groceries') })
    await history({ description: 'EXAMPLE one' })

    await afterTransactionsChanged(env.DB, { accountId })

    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE rule_id IS NOT NULL').first<{ n: number }>())!.n).toBe(0)
  })

  it('never touches an Override, a Note or a Transaction\'s other columns, only the Rule result', async () => {
    const groceries = await categoryId('Groceries')
    const fuel = await categoryId('Fuel')
    await addRule({ textContains: 'EXAMPLE', categoryId: groceries })
    const t = await history({ description: 'EXAMPLE one', memo: 'm', type: 'EFTPOS', cents: -1234 })
    await env.DB.prepare("UPDATE transactions SET override_category = ?, note = 'keep me' WHERE id = ?").bind(fuel, t).run()
    const snapshot = async () => env.DB.prepare('SELECT id, account_id, date, amount_cents, description, bank_memo, bank_type, override_category, note FROM transactions WHERE id = ?').bind(t).first()
    const was = await snapshot()

    await afterTransactionsChanged(env.DB, { accountId, afterId: 0 })

    expect(await snapshot()).toEqual(was)
    expect(await env.DB.prepare('SELECT rule_category FROM transactions WHERE id = ?').bind(t).first()).toEqual({ rule_category: groceries })
  })
})

describe('the Category a Transaction ends up with', () => {
  it('is its Override when it has one, even though a Rule also matches, and the Rule when the Override is taken off', async () => {
    const groceries = await categoryId('Groceries')
    const fuel = await categoryId('Fuel')
    await addRule({ textContains: 'EXAMPLE SUPER', categoryId: groceries })
    await importRows([{ description: 'EXAMPLE SUPER 1' }])
    const t = (await rowFor('EXAMPLE SUPER 1')).id
    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })

    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: fuel } })
    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryName: 'Fuel', categorySource: 'override' })

    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: null } })
    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
  })

  it('keeps an Override through further Imports, Rule changes and Rule removal', async () => {
    const groceries = await categoryId('Groceries')
    const fuel = await categoryId('Fuel')
    const rule = await addRule({ textContains: 'EXAMPLE SUPER', categoryId: groceries })
    await importRows([{ description: 'EXAMPLE SUPER 1' }])
    const t = (await rowFor('EXAMPLE SUPER 1')).id
    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: fuel } })

    await importRows([{ description: 'EXAMPLE SUPER 2' }])
    await call(`/api/rules/${rule}`, { method: 'PUT', body: { textContains: 'EXAMPLE', categoryId: await categoryId('Tax') } })
    await importRows([{ description: 'EXAMPLE SUPER 3' }])
    await call(`/api/rules/${rule}`, { method: 'DELETE', body: {} })

    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryName: 'Fuel', categorySource: 'override' })
    expect((await env.DB.prepare('SELECT override_category FROM transactions WHERE id = ?').bind(t).first<{ override_category: number }>())!.override_category).toBe(fuel)
  })

  it('is Uncategorised when the Rule\'s Category is removed, and the Rule is flagged', async () => {
    const care = (await (await call('/api/categories', { method: 'POST', body: { name: 'Test Care Fees' } })).json()) as { id: number }
    await addRule({ textContains: 'EXAMPLE CARE', categoryId: care.id })
    await importRows([{ description: 'EXAMPLE CARE 1' }])
    expect(await rowFor('EXAMPLE CARE 1')).toMatchObject({ categoryName: 'Test Care Fees', categorySource: 'rule' })

    await call(`/api/categories/${care.id}`, { method: 'DELETE', body: {} })

    expect(await rowFor('EXAMPLE CARE 1')).toMatchObject({ categoryId: null, categoryName: null, categorySource: null })
    expect((await list('?uncategorised=true')).transactions.map((t) => t.description)).toEqual(['EXAMPLE CARE 1'])
    expect(await rules()).toMatchObject([{ categoryId: care.id, categoryName: 'Test Care Fees', categoryRemoved: true }])
  })

  it('is decided by the next Rule that matches when a Rule above it has a removed Category', async () => {
    const groceries = await categoryId('Groceries')
    const care = (await (await call('/api/categories', { method: 'POST', body: { name: 'Test Care Fees' } })).json()) as { id: number }
    await addRule({ textContains: 'EXAMPLE', categoryId: care.id })
    await addRule({ textContains: 'EXAMPLE', categoryId: groceries })
    await call(`/api/categories/${care.id}`, { method: 'DELETE', body: {} })

    await importRows([{ description: 'EXAMPLE CARE 1' }])

    expect(await rowFor('EXAMPLE CARE 1')).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
  })

  it('moves a Rule\'s Category to its new name when the Category is renamed', async () => {
    const groceries = await categoryId('Groceries')
    await addRule({ textContains: 'EXAMPLE SUPER', categoryId: groceries })
    await importRows([{ description: 'EXAMPLE SUPER 1' }])

    await call(`/api/categories/${groceries}`, { method: 'PATCH', body: { name: 'Food shopping' } })

    expect(await rowFor('EXAMPLE SUPER 1')).toMatchObject({ categoryName: 'Food shopping' })
    expect((await rules())[0]).toMatchObject({ categoryName: 'Food shopping' })
  })
})

describe('a Member', () => {
  it('can read the Rules', async () => {
    const id = await addRule({ textContains: 'wool', categoryId: await categoryId('Groceries') })
    const res = await call('/api/rules', { who: 'member' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Rule[]).map((r) => r.id)).toEqual([id])
  })

  it('is refused the Rules when not signed in', async () => {
    expect((await exports.default.fetch(new Request('https://app.test/api/rules'))).status).toBe(401)
  })

  describe('cannot change anything', () => {
    // Each case is refused with 403 and leaves the Rules, the Transactions and the Change Log exactly as they were.
    // Take the Admin guard out of worker/app.ts and every one of these changes something, so every one of these fails.
    const attempts: [string, (ids: { rule: number; other: number; category: number }) => { method: string; path: string; body: unknown }][] = [
      ['add a Rule', ({ category }) => ({ method: 'POST', path: '/api/rules', body: { textContains: 'sneaky', categoryId: category } })],
      ['change a Rule', ({ rule }) => ({ method: 'PUT', path: `/api/rules/${rule}`, body: { textContains: 'sneaky', transfer: true } })],
      ['remove a Rule', ({ rule }) => ({ method: 'DELETE', path: `/api/rules/${rule}`, body: {} })],
      ['reorder Rules', ({ rule, other }) => ({ method: 'PUT', path: '/api/rules/order', body: { ids: [other, rule] } })],
    ]

    it.each(attempts)('to %s', async (_what, request) => {
      const ids = {
        rule: await addRule({ textContains: 'wool', categoryId: await categoryId('Groceries') }),
        other: await addRule({ textContains: 'bp', categoryId: await categoryId('Fuel') }),
        category: await categoryId('Groceries'),
      }
      await history({ description: 'EXAMPLE one' })
      const snapshot = async () => ({
        rules: (await env.DB.prepare('SELECT * FROM rules ORDER BY id').all()).results,
        transactions: (await env.DB.prepare('SELECT * FROM transactions ORDER BY id').all()).results,
        changeLog: await changeLog(),
      })
      const before = await snapshot()
      const { method, path, body } = request(ids)

      const res = await call(path, { who: 'member', method, body })

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Read-only' })
      expect(await snapshot()).toEqual(before)
    })
  })
})
