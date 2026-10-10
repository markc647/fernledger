import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin (the dev identity cookie is
// honoured on localhost only). A route that takes an ID in its path acts on that ID as written, and on no other: `1e1` is
// 10 to Number(), so it must not reach the row with ID 10. The Transaction routes are in transactions.test.ts.
const origin = 'http://localhost:5173'

/** Ways of writing 10 that Number() reads as 10. `10%20` is decoded to '10 ' first, which Number() reads as 10 too. */
const WRITTEN_OTHER_WAYS = ['1e1', '10.0', '010', '+10', '0xa', '10e0', '10%20']

async function send(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { Cookie: 'fernledger_dev_as=admin' }
  if (body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
}

const rowsOf = async (sql: string) => (await env.DB.prepare(sql).all()).results

/** Each other way of writing 10 is refused with 404 by a write, which leaves the row as it was and writes no Change Log entry. */
async function refusesWritesOtherWay(method: string, path: (id: string) => string, body: unknown, rowSql: string) {
  const before = await rowsOf(rowSql)
  expect(before, 'the row with ID 10').toHaveLength(1)
  for (const written of WRITTEN_OTHER_WAYS) {
    const res = await send(method, path(written), body)
    expect(res.status, `${method} ${path(written)}`).toBe(404)
  }
  expect(await rowsOf(rowSql)).toEqual(before)
  expect(await rowsOf('SELECT id FROM change_log')).toEqual([])
}

/** Each other way of writing 10 is refused with 404 by a read. */
async function refusesReadsOtherWay(path: (id: string) => string) {
  for (const written of WRITTEN_OTHER_WAYS) {
    const res = await send('GET', path(written))
    expect(res.status, path(written)).toBe(404)
  }
}

beforeEach(async () => {
  await env.DB.batch(['transactions', 'rules', 'budgets', 'balance_checks', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  // Account 10 and Category 10 are the rows the routes are asked for by ID. A family that needs another row with ID 10 adds it in its own block.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, account_number, name) VALUES (10, '99-9999-9999999-99', 'Example savings')"),
    env.DB.prepare("INSERT INTO categories (id, name, kind) VALUES (10, 'EXAMPLE TEN', 'spending')"),
  ])
})

describe('the Account routes', () => {
  const account = 'SELECT name, cutover_date AS cutoverDate FROM accounts WHERE id = 10'

  it('rename Account 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('PATCH', (id) => `/api/accounts/${id}`, { name: 'EXAMPLE RENAMED' }, account)

    expect((await send('PATCH', '/api/accounts/10', { name: 'EXAMPLE RENAMED' })).status).toBe(200)
    expect(await rowsOf(account)).toEqual([{ name: 'EXAMPLE RENAMED', cutoverDate: null }])
  })

  it('set the Cutover Date of Account 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('PUT', (id) => `/api/accounts/${id}/cutover-date`, { cutoverDate: '2026-10-01' }, account)

    expect((await send('PUT', '/api/accounts/10/cutover-date', { cutoverDate: '2026-10-01' })).status).toBe(200)
    expect(await rowsOf(account)).toEqual([{ name: 'Example savings', cutoverDate: '2026-10-01' }])
  })
})

describe('the Category routes', () => {
  const category = 'SELECT name, kind, removed_at AS removedAt FROM categories WHERE id = 10'

  it('rename Category 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('PATCH', (id) => `/api/categories/${id}`, { name: 'EXAMPLE RENAMED' }, category)

    expect((await send('PATCH', '/api/categories/10', { name: 'EXAMPLE RENAMED' })).status).toBe(200)
    expect(await rowsOf(category)).toEqual([{ name: 'EXAMPLE RENAMED', kind: 'spending', removedAt: null }])
  })

  it('change the kind of Category 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('PUT', (id) => `/api/categories/${id}/kind`, { kind: 'income' }, category)

    expect((await send('PUT', '/api/categories/10/kind', { kind: 'income' })).status).toBe(200)
    expect(await rowsOf(category)).toEqual([{ name: 'EXAMPLE TEN', kind: 'income', removedAt: null }])
  })

  it('remove Category 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('DELETE', (id) => `/api/categories/${id}`, {}, category)

    expect((await send('DELETE', '/api/categories/10', {})).status).toBe(200)
    expect(await rowsOf(category)).toEqual([{ name: 'EXAMPLE TEN', kind: 'spending', removedAt: expect.any(String) }])
  })
})

describe('the Budget route', () => {
  const budget = 'SELECT effective_from_month AS effectiveFrom, amount_cents AS amountCents FROM budgets WHERE category_id = 10 ORDER BY effective_from_month'

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO budgets (category_id, effective_from_month, amount_cents) VALUES (10, '2026-09', 4000)").run()
  })

  it('sets the Budget of Category 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('PUT', (id) => `/api/budgets/${id}`, { effectiveFrom: '2026-10', amountCents: 5000 }, budget)

    expect((await send('PUT', '/api/budgets/10', { effectiveFrom: '2026-10', amountCents: 5000 })).status).toBe(200)
    expect(await rowsOf(budget)).toEqual([
      { effectiveFrom: '2026-09', amountCents: 4000 },
      { effectiveFrom: '2026-10', amountCents: 5000 },
    ])
  })
})

describe('the Rule routes', () => {
  const rule = 'SELECT text_contains AS textContains, category_id AS categoryId, removed_at AS removedAt FROM rules WHERE id = 10'

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO rules (id, position, text_contains, category_id) VALUES (10, 1, 'EXAMPLE', 10)").run()
  })

  it('change Rule 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('PUT', (id) => `/api/rules/${id}`, { textContains: 'EXAMPLE RENAMED', categoryId: 10 }, rule)

    expect((await send('PUT', '/api/rules/10', { textContains: 'EXAMPLE RENAMED', categoryId: 10 })).status).toBe(200)
    expect(await rowsOf(rule)).toEqual([{ textContains: 'EXAMPLE RENAMED', categoryId: 10, removedAt: null }])
  })

  it('remove Rule 10 for 10 as written, and for no other way', async () => {
    await refusesWritesOtherWay('DELETE', (id) => `/api/rules/${id}`, {}, rule)

    expect((await send('DELETE', '/api/rules/10', {})).status).toBe(200)
    expect(await rowsOf(rule)).toEqual([{ textContains: 'EXAMPLE', categoryId: 10, removedAt: expect.any(String) }])
  })
})

describe('the read routes', () => {
  it('read the balance history of Account 10 for 10 as written, and for no other way', async () => {
    await refusesReadsOtherWay((id) => `/api/balances/${id}/history`)

    expect((await send('GET', '/api/balances/10/history')).status).toBe(200)
  })

  it('count the imported rows of Account 10 for 10 as written, and for no other way', async () => {
    await refusesReadsOtherWay((id) => `/api/imports/imported/${id}`)

    expect((await send('GET', '/api/imports/imported/10')).status).toBe(200)
  })
})
