import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only; Access token handling is tested in api.test.ts).
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

type Category = { id: number; name: string }
type Row = { id: number; categoryId: number | null; categoryName: string | null; categorySource: string | null; note: string | null; description: string }

const categories = async (who: Who = 'member'): Promise<Category[]> => (await call('/api/categories', { who })).json()
const idOf = async (name: string) => (await categories()).find((c) => c.name === name)!.id
const add = async (name: string) => ((await (await call('/api/categories', { method: 'POST', body: { name } })).json()) as Category).id
const list = async (query = ''): Promise<{ total: number; transactions: Row[] }> => (await call(`/api/transactions${query}`)).json()
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, type, before, after FROM change_log ORDER BY id').all()).results

let accountId = 0
/** Adds a made-up Transaction `n` and returns its ID. */
async function transaction(n: number) {
  const { meta } = await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, source) VALUES (?, ?, ?, ?, ?)')
    .bind(accountId, `2026-10-${String(n).padStart(2, '0')}`, -1000 * n, `EXAMPLE SHOP ${n}`, 'import')
    .run()
  return meta.last_row_id
}

type CategoryRecord = { id: number; name: string }
let starters: CategoryRecord[] = []
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

beforeEach(async () => {
  await env.DB.batch(['transactions', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  // Back to the starter list as migrated, so no test depends on what an earlier one added, renamed or removed.
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(c.id, c.name)))
  accountId = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example') RETURNING id").first<{ id: number }>())!.id
})

describe('the starter Categories', () => {
  it('are there from the first request, in plain NZ English, for a Member to read', async () => {
    const names = (await categories('member')).map((c) => c.name)
    expect(names).toHaveLength(22)
    expect(names).toEqual(expect.arrayContaining(['Groceries', 'Eating out', 'Rent or mortgage', 'NZ Super and benefits', 'Other income']))
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))
  })

  it('refuse someone who is not signed in', async () => {
    expect((await exports.default.fetch(new Request('https://app.test/api/categories'))).status).toBe(401)
  })
})

describe('adding a Category', () => {
  it('lets the Admin add one, and logs it', async () => {
    const res = await call('/api/categories', { method: 'POST', body: { name: '  Care Fees ' } })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: expect.any(Number), name: 'Care Fees' })
    expect((await categories()).map((c) => c.name)).toContain('Care Fees')
    expect(await changeLog()).toEqual([{ summary: 'Added Category Care Fees', actor: 'admin@example.com', type: 'category', before: null, after: '{"name":"Care Fees"}' }])
  })

  it('refuses a name that is in use, ignoring case, and writes nothing', async () => {
    const res = await call('/api/categories', { method: 'POST', body: { name: 'groceries' } })

    expect(res.status).toBe(409)
    expect(await res.text()).not.toContain('groceries')
    expect((await categories()).filter((c) => c.name.toLowerCase() === 'groceries')).toHaveLength(1)
    expect(await changeLog()).toEqual([])
  })

  it.each([
    ['blank', ''],
    ['only spaces', '   '],
    ['over 40 characters', 'x'.repeat(41)],
    ['not text', 12],
    ['missing', undefined],
  ])('rejects a name that is %s, naming only the field', async (_why, name) => {
    const before = await categories()
    const res = await call('/api/categories', { method: 'POST', body: name === undefined ? {} : { name } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'name' })
    expect(await categories()).toEqual(before)
    expect(await changeLog()).toEqual([])
  })

  it('does not echo a rejected name', async () => {
    const res = await call('/api/categories', { method: 'POST', body: { name: 'SECRET-'.repeat(10) } })
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('SECRET')
  })
})

describe('renaming a Category', () => {
  it('lets the Admin rename one, and logs before and after', async () => {
    const id = await idOf('Groceries')

    const res = await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: 'Food shopping' } })

    expect(res.status).toBe(200)
    expect((await categories()).find((c) => c.id === id)?.name).toBe('Food shopping')
    expect(await changeLog()).toEqual([
      { summary: 'Renamed Category Groceries to Food shopping', actor: 'admin@example.com', type: 'category', before: '{"name":"Groceries"}', after: '{"name":"Food shopping"}' },
    ])
  })

  it('allows a change of capitals alone', async () => {
    const id = await idOf('Eating out')
    expect((await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: 'EATING OUT' } })).status).toBe(200)
    expect((await categories()).find((c) => c.id === id)?.name).toBe('EATING OUT')
  })

  it('changes nothing, and logs nothing, when the name is the same', async () => {
    const id = await idOf('Groceries')
    expect((await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: 'Groceries' } })).status).toBe(200)
    expect(await changeLog()).toEqual([])
  })

  it('refuses a name another Category has', async () => {
    const id = await idOf('Groceries')
    const res = await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: 'fuel' } })

    expect(res.status).toBe(409)
    expect((await categories()).find((c) => c.id === id)?.name).toBe('Groceries')
    expect(await changeLog()).toEqual([])
  })

  it('rejects a bad name, naming only the field', async () => {
    const id = await idOf('Groceries')
    const res = await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: ' ' } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'name' })
    expect((await categories()).find((c) => c.id === id)?.name).toBe('Groceries')
  })

  it.each(['999999', 'abc', '1.5'])('answers 404 for a Category that is not there (%s)', async (id) => {
    expect((await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: 'Anything' } })).status).toBe(404)
  })
})

describe('removing a Category', () => {
  it('lets the Admin remove one, says how many Overrides it held, and logs it', async () => {
    const id = await add('Test Care Fees')
    const [a, b] = [await transaction(1), await transaction(2)]
    await call(`/api/transactions/${a}/override`, { method: 'PUT', body: { categoryId: id } })
    await call(`/api/transactions/${b}/override`, { method: 'PUT', body: { categoryId: id } })
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, name: 'Test Care Fees', overrides: 2 })
    expect((await categories()).map((c) => c.name)).not.toContain('Test Care Fees')
    expect(await changeLog()).toEqual([
      { summary: 'Removed Category Test Care Fees', actor: 'admin@example.com', type: 'category', before: '{"name":"Test Care Fees","overrides":2}', after: null },
    ])
  })

  it('turns the Transactions that had it as their Override into Uncategorised', async () => {
    const id = await add('Test Care Fees')
    const [held, other, none] = [await transaction(1), await transaction(2), await transaction(3)]
    const groceries = await idOf('Groceries')
    await call(`/api/transactions/${held}/override`, { method: 'PUT', body: { categoryId: id } })
    await call(`/api/transactions/${other}/override`, { method: 'PUT', body: { categoryId: groceries } })
    expect((await list('?uncategorised=true')).transactions.map((t) => t.id)).toEqual([none])

    await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })

    const uncategorised = await list('?uncategorised=true')
    expect(uncategorised.transactions.map((t) => t.id)).toEqual([none, held])
    expect(uncategorised.total).toBe(2)
    const now = (await list()).transactions
    expect(now.find((t) => t.id === held)).toMatchObject({ categoryId: null, categoryName: null, categorySource: null })
    expect(now.find((t) => t.id === other)).toMatchObject({ categoryId: groceries, categoryName: 'Groceries', categorySource: 'override' })
  })

  it('leaves the Transactions as they are however many there are, so it is one write and stays inside the free plan', async () => {
    const id = await add('Test Big')
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category) SELECT ?, '2026-10-01', -100, 'EXAMPLE ' || i, 'import', ? FROM n`,
    )
      .bind(accountId, id)
      .run()

    const res = await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })

    expect(await res.json()).toMatchObject({ overrides: 300 })
    expect((await list('?uncategorised=true')).total).toBe(300)
    // Not rewritten: they still point at the removed Category, which is simply ignored.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE override_category = ?').bind(id).first<{ n: number }>())!.n).toBe(300)
  })

  it('lets the name be used again, without bringing the old Overrides back', async () => {
    const id = await add('Test Care Fees')
    const t = await transaction(1)
    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: id } })
    await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })

    const again = await add('Test Care Fees')

    expect(again).not.toBe(id)
    expect((await list()).transactions[0]).toMatchObject({ categoryId: null })
  })

  it('answers 404 for a Category already removed, or never there', async () => {
    const id = await add('Test Care Fees')
    await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })
    expect((await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })).status).toBe(404)
    expect((await call('/api/categories/999999', { method: 'DELETE', body: {} })).status).toBe(404)
    expect((await call(`/api/categories/${id}`, { method: 'PATCH', body: { name: 'Back' } })).status).toBe(404)
  })

  it('removes a starter Category the same way', async () => {
    const id = await idOf('Tax')
    expect((await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })).status).toBe(200)
    expect((await categories()).map((c) => c.name)).not.toContain('Tax')
  })
})

describe('an Override', () => {
  it('is set by the Admin on any Transaction, shows as its Category, and is logged with before and after', async () => {
    const t = await transaction(1)
    const groceries = await idOf('Groceries')
    const fuel = await idOf('Fuel')

    const res = await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: groceries } })
    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: fuel } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: t, categoryId: groceries })
    expect((await list()).transactions[0]).toMatchObject({ categoryId: fuel, categoryName: 'Fuel', categorySource: 'override' })
    expect(await changeLog()).toEqual([
      {
        summary: `Set Override on Transaction ${t} (2026-10-01, EXAMPLE SHOP 1) to Groceries`,
        actor: 'admin@example.com',
        type: 'transaction',
        before: '{"override":null}',
        after: '{"override":"Groceries"}',
      },
      {
        summary: `Set Override on Transaction ${t} (2026-10-01, EXAMPLE SHOP 1) to Fuel`,
        actor: 'admin@example.com',
        type: 'transaction',
        before: '{"override":"Groceries"}',
        after: '{"override":"Fuel"}',
      },
    ])
  })

  it('is taken off with null, and the Transaction is Uncategorised again', async () => {
    const t = await transaction(1)
    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: await idOf('Groceries') } })

    const res = await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: null } })

    expect(await res.json()).toEqual({ id: t, categoryId: null })
    expect((await list()).transactions[0]).toMatchObject({ categoryId: null, categorySource: null })
    expect((await changeLog()).at(-1)).toMatchObject({ summary: `Cleared Override on Transaction ${t} (2026-10-01, EXAMPLE SHOP 1)`, before: '{"override":"Groceries"}', after: '{"override":null}' })
  })

  it('logs nothing when it is already so', async () => {
    const t = await transaction(1)
    expect((await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: null } })).status).toBe(200)
    expect(await changeLog()).toEqual([])
  })

  it('is refused for a Category that is removed or not there, naming only the field', async () => {
    const t = await transaction(1)
    const gone = await add('Test Gone')
    await call(`/api/categories/${gone}`, { method: 'DELETE', body: {} })
    await env.DB.prepare('DELETE FROM change_log').run()

    for (const categoryId of [gone, 999999]) {
      const res = await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId } })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'categoryId' })
    }
    expect((await list()).transactions[0]).toMatchObject({ categoryId: null })
    expect(await changeLog()).toEqual([])
  })

  it.each([
    ['text', 'Groceries'],
    ['a fraction', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['missing', undefined],
  ])('is refused when the Category is %s, naming only the field', async (_why, categoryId) => {
    const t = await transaction(1)
    const res = await call(`/api/transactions/${t}/override`, { method: 'PUT', body: categoryId === undefined ? {} : { categoryId } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'categoryId' })
    expect(await changeLog()).toEqual([])
  })

  it.each(['999999', 'abc'])('answers 404 for a Transaction that is not there (%s)', async (id) => {
    expect((await call(`/api/transactions/${id}/override`, { method: 'PUT', body: { categoryId: null } })).status).toBe(404)
  })
})

describe('a Note', () => {
  it('is set by the Admin on any Transaction, trimmed, and logged with before and after', async () => {
    const t = await transaction(1)

    const res = await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: '  hearing aid — receipt in folder ' } })
    await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: 'hearing aid, receipt in the blue folder' } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: t, note: 'hearing aid — receipt in folder' })
    expect((await list()).transactions[0]).toMatchObject({ note: 'hearing aid, receipt in the blue folder' })
    expect(await changeLog()).toEqual([
      {
        summary: `Added a Note to Transaction ${t} (2026-10-01, EXAMPLE SHOP 1)`,
        actor: 'admin@example.com',
        type: 'transaction',
        before: '{"note":null}',
        after: '{"note":"hearing aid — receipt in folder"}',
      },
      {
        summary: `Changed the Note on Transaction ${t} (2026-10-01, EXAMPLE SHOP 1)`,
        actor: 'admin@example.com',
        type: 'transaction',
        before: '{"note":"hearing aid — receipt in folder"}',
        after: '{"note":"hearing aid, receipt in the blue folder"}',
      },
    ])
  })

  it('is taken off by a blank one', async () => {
    const t = await transaction(1)
    await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: 'Receipt in folder' } })

    const res = await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: '   ' } })

    expect(await res.json()).toEqual({ id: t, note: null })
    expect((await list()).transactions[0]).toMatchObject({ note: null })
    expect((await changeLog()).at(-1)).toMatchObject({ summary: `Removed the Note from Transaction ${t} (2026-10-01, EXAMPLE SHOP 1)`, after: '{"note":null}' })
  })

  it('logs nothing when it is already so', async () => {
    const t = await transaction(1)
    expect((await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: '' } })).status).toBe(200)
    expect(await changeLog()).toEqual([])
  })

  it.each([
    ['over 500 characters', 'x'.repeat(501)],
    ['not text', 5],
    ['missing', undefined],
  ])('is refused when it is %s, naming only the field', async (_why, note) => {
    const t = await transaction(1)
    const res = await call(`/api/transactions/${t}/note`, { method: 'PUT', body: note === undefined ? {} : { note } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'note' })
    expect((await list()).transactions[0]).toMatchObject({ note: null })
    expect(await changeLog()).toEqual([])
  })

  it('takes exactly 500 characters', async () => {
    const t = await transaction(1)
    expect((await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: 'x'.repeat(500) } })).status).toBe(200)
  })

  it('answers 404 for a Transaction that is not there', async () => {
    expect((await call('/api/transactions/999999/note', { method: 'PUT', body: { note: 'x' } })).status).toBe(404)
  })
})

describe('the Uncategorised list', () => {
  it('holds the Transactions with no effective Category, newest first, with a total', async () => {
    const [a, b, c] = [await transaction(1), await transaction(2), await transaction(3)]
    await call(`/api/transactions/${b}/override`, { method: 'PUT', body: { categoryId: await idOf('Fuel') } })

    const uncategorised = await list('?uncategorised=true')

    expect(uncategorised.transactions.map((t) => t.id)).toEqual([c, a])
    expect(uncategorised.total).toBe(2)
    expect((await list()).total).toBe(3)
  })

  it('pages like the full list', async () => {
    for (const n of [1, 2, 3]) await transaction(n)
    const page = await list('?uncategorised=true&limit=2&offset=2')
    expect(page.total).toBe(3)
    expect(page.transactions).toHaveLength(1)
  })

  it('rejects any value but true, naming only the field', async () => {
    const res = await call('/api/transactions?uncategorised=false')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'uncategorised' })
  })
})

describe('a Member', () => {
  it('can read Categories, Overrides and Notes', async () => {
    const t = await transaction(1)
    await call(`/api/transactions/${t}/override`, { method: 'PUT', body: { categoryId: await idOf('Fuel') } })
    await call(`/api/transactions/${t}/note`, { method: 'PUT', body: { note: 'Receipt in folder' } })

    const res = await call('/api/transactions', { who: 'member' })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { transactions: Row[] }).transactions[0]).toMatchObject({ categoryName: 'Fuel', categorySource: 'override', note: 'Receipt in folder' })
  })

  describe('cannot change anything', () => {
    // Each case is refused with 403 and leaves the data and the Change Log exactly as they were. Take the Admin guard
    // out of worker/app.ts and every one of these changes something, so every one of these fails.
    const attempts: [string, string, (ids: { category: number; transaction: number }) => { method: string; path: string; body: unknown }][] = [
      ['add a Category', 'POST', () => ({ method: 'POST', path: '/api/categories', body: { name: 'Test Sneaky' } })],
      ['rename a Category', 'PATCH', ({ category }) => ({ method: 'PATCH', path: `/api/categories/${category}`, body: { name: 'Test Sneaky' } })],
      ['remove a Category', 'DELETE', ({ category }) => ({ method: 'DELETE', path: `/api/categories/${category}`, body: {} })],
      ['set an Override', 'PUT', ({ category, transaction }) => ({ method: 'PUT', path: `/api/transactions/${transaction}/override`, body: { categoryId: category } })],
      ['set a Note', 'PUT', ({ transaction }) => ({ method: 'PUT', path: `/api/transactions/${transaction}/note`, body: { note: 'Test sneaky' } })],
    ]

    it.each(attempts)('to %s', async (_what, _method, request) => {
      const ids = { category: await idOf('Groceries'), transaction: await transaction(1) }
      const snapshot = async () => ({
        categories: (await env.DB.prepare('SELECT id, name, removed_at FROM categories ORDER BY id').all()).results,
        transactions: (await env.DB.prepare('SELECT id, override_category, note FROM transactions ORDER BY id').all()).results,
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
