import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Seam 1: searching, filtering, sorting and paging the Transactions, and opening one, through the Worker's exported
// handler as the local-development Admin or a read-only Member (the dev identity cookie is honoured on localhost only).
// Override and Note writes are in categories.test.ts.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, who: Who = 'member') {
  return exports.default.fetch(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }))
}

type Row = { id: number; accountId: number; accountName: string; date: string; description: string; amountCents: number; categoryId: number | null; categoryName: string | null; categorySource: string | null; note: string | null }
type Page = { total: number | null; transactions: Row[] }

const search = async (query = '', who: Who = 'member'): Promise<Page> => {
  const res = await call(`/api/transactions${query}`, who)
  expect(res.status, query).toBe(200)
  return res.json()
}
const descriptions = async (query = '') => (await search(query)).transactions.map((t) => t.description)
const refusal = async (query: string) => {
  const res = await call(`/api/transactions${query}`)
  return { status: res.status, body: await res.json() }
}

type Added = { date?: string; amountCents?: number; description?: string; bankMemo?: string; note?: string | null; overrideCategory?: number | null; accountId?: number }
let savings = 0
let cheque = 0
let n = 0
/** Adds a made-up Transaction and returns its ID. Dated 1 October 2026 unless `date` says otherwise. */
async function add(t: Added = {}) {
  n += 1
  const { meta } = await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, source, note, override_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(t.accountId ?? savings, t.date ?? '2026-10-01', t.amountCents ?? -1000, t.description ?? `EXAMPLE SHOP ${n}`, t.bankMemo ?? '', 'import', t.note ?? null, t.overrideCategory ?? null)
    .run()
  return meta.last_row_id
}

type CategoryRecord = { id: number; name: string }
let starters: CategoryRecord[] = []
const category = (name: string) => starters.find((c) => c.name === name)!.id
beforeAll(async () => {
  starters = (await env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY id').all<CategoryRecord>()).results
})

beforeEach(async () => {
  await env.DB.batch(['transactions', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.batch(starters.map((c) => env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(c.id, c.name)))
  savings = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example savings') RETURNING id").first<{ id: number }>())!.id
  cheque = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-98', 'Example cheque') RETURNING id").first<{ id: number }>())!.id
  n = 0
})

describe('with no filters', () => {
  it('lists every Transaction, newest first, with the total', async () => {
    const a = await add({ date: '2026-10-01' })
    const c = await add({ date: '2026-10-03' })
    const b = await add({ date: '2026-10-02' })

    const page = await search()

    expect(page.total).toBe(3)
    expect(page.transactions.map((t) => t.id)).toEqual([c, b, a])
    expect(page.transactions[0]).toMatchObject({ accountName: 'Example savings', categoryId: null, categoryName: null, categorySource: null, note: null })
  })

  it('breaks a tie on date by ID, newest first', async () => {
    const ids = [await add(), await add(), await add()]
    expect((await search()).transactions.map((t) => t.id)).toEqual([...ids].reverse())
  })
})

describe('filtering by Account', () => {
  it('keeps only that Account, and counts only that Account', async () => {
    const mine = await add({ accountId: savings })
    await add({ accountId: cheque })
    await add({ accountId: cheque })

    const page = await search(`?accountId=${savings}`)

    expect(page.total).toBe(1)
    expect(page.transactions.map((t) => t.id)).toEqual([mine])
    expect((await search(`?accountId=${cheque}`)).total).toBe(2)
  })

  it('finds nothing for an Account that does not exist', async () => {
    await add()
    expect(await search('?accountId=99999')).toEqual({ total: 0, transactions: [] })
  })

  it.each(['abc', '0', '-1', '1.5', '1234567890', ''])('rejects %j, naming only the field', async (value) => {
    expect(await refusal(`?accountId=${value}`)).toEqual({ status: 400, body: { error: 'Invalid request', field: 'accountId' } })
  })
})

describe('filtering by Category', () => {
  it('keeps those whose effective Category it is, and no others', async () => {
    const fuel = await add({ overrideCategory: category('Fuel') })
    await add({ overrideCategory: category('Groceries') })
    await add()

    const page = await search(`?categoryId=${category('Fuel')}`)

    expect(page.total).toBe(1)
    expect(page.transactions).toMatchObject([{ id: fuel, categoryName: 'Fuel', categorySource: 'override' }])
  })

  it('does not count a removed Category: its Transactions are Uncategorised', async () => {
    const gone = await add({ overrideCategory: category('Fuel') })
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-02T00:00:00.000Z' WHERE id = ?").bind(category('Fuel')).run()

    expect((await search(`?categoryId=${category('Fuel')}`)).total).toBe(0)
    expect((await search('?uncategorised=true')).transactions.map((t) => t.id)).toEqual([gone])
  })

  it('keeps only Uncategorised ones with uncategorised=true', async () => {
    await add({ overrideCategory: category('Fuel') })
    const none = await add()

    const page = await search('?uncategorised=true')

    expect(page).toMatchObject({ total: 1, transactions: [{ id: none, categoryName: null }] })
  })

  it('refuses a Category together with Uncategorised, since no Transaction is both', async () => {
    expect(await refusal(`?categoryId=${category('Fuel')}&uncategorised=true`)).toEqual({ status: 400, body: { error: 'Invalid request', field: 'categoryId' } })
  })

  it.each(['abc', '0', 'uncategorised'])('rejects categoryId %j, naming only the field', async (value) => {
    expect(await refusal(`?categoryId=${value}`)).toEqual({ status: 400, body: { error: 'Invalid request', field: 'categoryId' } })
  })
})

describe('filtering by date range', () => {
  beforeEach(async () => {
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-15', '2026-10-31', '2026-11-01']) await add({ date, description: `EXAMPLE ${date}` })
  })

  it('includes both ends', async () => {
    expect(await descriptions('?from=2026-10-01&to=2026-10-31')).toEqual(['EXAMPLE 2026-10-31', 'EXAMPLE 2026-10-15', 'EXAMPLE 2026-10-01'])
  })

  it('takes either end alone', async () => {
    expect(await descriptions('?from=2026-10-31')).toEqual(['EXAMPLE 2026-11-01', 'EXAMPLE 2026-10-31'])
    expect(await descriptions('?to=2026-10-01')).toEqual(['EXAMPLE 2026-10-01', 'EXAMPLE 2026-09-30'])
  })

  it('takes a single day', async () => {
    expect(await descriptions('?from=2026-10-15&to=2026-10-15')).toEqual(['EXAMPLE 2026-10-15'])
  })

  it('counts only what is in range', async () => {
    expect((await search('?from=2026-10-01&to=2026-10-31')).total).toBe(3)
  })

  it.each([
    ['from', '2026-02-30'], // not a real day
    ['from', '1999-12-31'], // before the years the app accepts
    ['to', '2101-01-01'], // after them
    ['to', 'yesterday'],
    ['from', '2026-1-5'],
  ])('rejects %s=%s, naming only the field', async (field, value) => {
    expect(await refusal(`?${field}=${value}`)).toEqual({ status: 400, body: { error: 'Invalid request', field } })
  })

  it('accepts the first and last days of the years the app accepts', async () => {
    expect((await call('/api/transactions?from=2000-01-01&to=2100-12-31')).status).toBe(200)
  })

  it('rejects a range that ends before it starts, naming the to field', async () => {
    expect(await refusal('?from=2026-10-09&to=2026-10-08')).toEqual({ status: 400, body: { error: 'Invalid request', field: 'to' } })
  })
})

describe('searching by text', () => {
  it('finds a match in the description, the bank memo or the Note, ignoring case', async () => {
    const payee = await add({ description: 'EXAMPLE CAFE TOWN' })
    const memo = await add({ description: 'EXAMPLE PAYEE', bankMemo: 'Monthly cafe subscription' })
    const note = await add({ description: 'EXAMPLE OTHER', note: 'Lunch at the Cafe with Sam' })
    await add({ description: 'EXAMPLE HARDWARE' })

    const found = (await search('?text=cAfE')).transactions.map((t) => t.id)

    expect(found.sort()).toEqual([payee, memo, note].sort())
    expect((await search('?text=cAfE')).total).toBe(3)
  })

  it('also finds what the bank supplied about the payment: reference, counterparty, particulars, code and card', async () => {
    const id = await add({ description: 'EXAMPLE PAYEE' })
    await env.DB.prepare(
      "UPDATE transactions SET bank_reference = 'CHQ 000123', bank_counterparty_account = '99-9999-9999999-97', bank_particulars = 'EXAMPLE RENT', bank_payment_code = 'EXAMPLE CODE X', bank_card_suffix = '4321' WHERE id = ?",
    )
      .bind(id)
      .run()
    await add({ description: 'EXAMPLE OTHER' })

    for (const text of ['chq 000123', '9999999-97', 'example rent', 'code x', '4321']) expect(await descriptions(`?text=${encodeURIComponent(text)}`), text).toEqual(['EXAMPLE PAYEE'])
  })

  it('finds a 100-character search in text with multibyte characters', async () => {
    // D1 refuses a LIKE pattern over 50 bytes, and this is 100 characters and 150 bytes. Matching must not depend on one.
    const long = `${'é'.repeat(50)}${'x'.repeat(50)}`
    await add({ description: `EXAMPLE ${'é'.repeat(50)}${'X'.repeat(50)} SHOP` })
    await add({ description: `EXAMPLE ${'é'.repeat(50)}${'x'.repeat(49)} SHOP` })

    expect(long).toHaveLength(100)
    const page = await search(`?text=${encodeURIComponent(long)}`)
    expect(page.total).toBe(1)
    expect(page.transactions.map((t) => t.description)).toEqual([`EXAMPLE ${'é'.repeat(50)}${'X'.repeat(50)} SHOP`])
  })

  it('matches inside a word, not only at the start', async () => {
    await add({ description: 'EXAMPLE SUPERMARKET' })
    expect(await descriptions('?text=permark')).toEqual(['EXAMPLE SUPERMARKET'])
  })

  it('treats % and _ as the characters they are, not as wildcards', async () => {
    await add({ description: '100% COTTON SHIRT' })
    await add({ description: 'EXAMPLE A_B SHOP' })
    await add({ description: 'EXAMPLE AXB SHOP' })
    await add({ description: 'PLAIN SHOP' })

    expect(await descriptions('?text=%25')).toEqual(['100% COTTON SHIRT'])
    expect(await descriptions('?text=A_B')).toEqual(['EXAMPLE A_B SHOP'])
    expect((await search('?text=%25')).total).toBe(1)
  })

  it('treats a backslash as the character it is', async () => {
    await add({ description: 'EXAMPLE A\\B SHOP' })
    await add({ description: 'EXAMPLE AB SHOP' })
    await add({ description: 'EXAMPLE A%B SHOP' })

    expect(await descriptions(`?text=${encodeURIComponent('A\\B')}`)).toEqual(['EXAMPLE A\\B SHOP'])
    expect(await descriptions(`?text=${encodeURIComponent('\\%')}`)).toEqual([])
  })

  it('treats SQL in the text as text', async () => {
    await add({ description: "O'NEILL'S EXAMPLE" })

    expect(await descriptions(`?text=${encodeURIComponent("'; DROP TABLE transactions; --")}`)).toEqual([])
    expect(await descriptions(`?text=${encodeURIComponent("O'NEILL")}`)).toEqual(["O'NEILL'S EXAMPLE"])
    expect((await search()).total).toBe(1)
  })

  it('ignores blank text and trims the rest', async () => {
    await add({ description: 'EXAMPLE CAFE' })
    await add({ description: 'EXAMPLE SHOP' })

    expect((await search('?text=')).total).toBe(2)
    expect((await search('?text=%20%20')).total).toBe(2)
    expect(await descriptions('?text=%20cafe%20')).toEqual(['EXAMPLE CAFE'])
  })

  it('accepts text of 100 characters and refuses more, without echoing it', async () => {
    expect((await call(`/api/transactions?text=${'x'.repeat(100)}`)).status).toBe(200)

    const res = await call(`/api/transactions?text=${'SECRET'.repeat(20)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'text' })
  })

  it('refuses the same field twice', async () => {
    expect(await refusal('?text=a&text=b')).toEqual({ status: 400, body: { error: 'Invalid request', field: 'text' } })
  })
})

describe('sorting', () => {
  let ids: Record<string, number>
  beforeEach(async () => {
    ids = {
      b: await add({ date: '2026-10-02', description: 'beta shop', amountCents: -500, accountId: cheque, overrideCategory: category('Groceries') }),
      a: await add({ date: '2026-10-03', description: 'Alpha shop', amountCents: -9000, accountId: savings, overrideCategory: category('Fuel') }),
      c: await add({ date: '2026-10-01', description: 'Charlie shop', amountCents: 2500, accountId: savings }),
    }
  })
  const order = async (query: string) => (await search(query)).transactions.map((t) => t.id)

  it('is newest first by default', async () => {
    expect(await order('')).toEqual([ids.a, ids.b, ids.c])
    expect(await order('?sort=date')).toEqual([ids.a, ids.b, ids.c])
    expect(await order('?sort=date&dir=asc')).toEqual([ids.c, ids.b, ids.a])
  })

  it('sorts by amount, money out first when ascending', async () => {
    expect(await order('?sort=amount&dir=asc')).toEqual([ids.a, ids.b, ids.c])
    expect(await order('?sort=amount&dir=desc')).toEqual([ids.c, ids.b, ids.a])
  })

  it('sorts by description, ignoring case, A to Z by default', async () => {
    expect(await order('?sort=description')).toEqual([ids.a, ids.b, ids.c])
    expect(await order('?sort=description&dir=desc')).toEqual([ids.c, ids.b, ids.a])
  })

  it('sorts by Account name, then newest first within an Account', async () => {
    // "Example cheque" before "Example savings"
    expect(await order('?sort=account')).toEqual([ids.b, ids.a, ids.c])
    expect(await order('?sort=account&dir=desc')).toEqual([ids.a, ids.c, ids.b])
  })

  it('sorts by effective Category, with Uncategorised last when ascending', async () => {
    expect(await order('?sort=category')).toEqual([ids.a, ids.b, ids.c]) // Fuel, Groceries, none
    expect(await order('?sort=category&dir=desc')).toEqual([ids.c, ids.b, ids.a])
  })

  it('applies to a filtered list', async () => {
    expect(await order(`?accountId=${savings}&sort=amount&dir=desc`)).toEqual([ids.c, ids.a])
  })

  it.each([
    ['a column that is not offered', 'sort=bank_memo', 'sort'],
    ['a table column behind an alias', 'sort=t.amount_cents', 'sort'],
    ['SQL', `sort=${encodeURIComponent('date; DROP TABLE transactions')}`, 'sort'],
    ['a direction in the column', `sort=${encodeURIComponent('date desc')}`, 'sort'],
    ['capitals', 'sort=Date', 'sort'],
    ['an empty column', 'sort=', 'sort'],
    ['a direction that is not one', 'sort=date&dir=sideways', 'dir'],
    ['SQL as the direction', `sort=date&dir=${encodeURIComponent('desc; DROP TABLE transactions')}`, 'dir'],
  ])('refuses %s, naming the field', async (_what, query, field) => {
    expect(await refusal(`?${query}`)).toEqual({ status: 400, body: { error: 'Invalid request', field } })
    expect((await search()).total).toBe(3)
  })
})

describe('paging', () => {
  it('returns 50 by default and at most 200 however many are asked for', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 205)
       INSERT INTO transactions (account_id, date, amount_cents, description, source) SELECT ?, '2026-10-01', -100, 'EXAMPLE ' || i, 'import' FROM seq`,
    )
      .bind(savings)
      .run()

    expect((await search()).transactions).toHaveLength(50)
    expect((await search('?limit=500')).transactions).toHaveLength(200)
    expect((await search('?limit=500')).total).toBe(205)
    expect((await search('?limit=0')).transactions).toHaveLength(1)
    expect((await search('?limit=200&offset=200')).transactions).toHaveLength(5)
  })

  it('walks the whole list in a stable order, showing each Transaction once, even when the sort key ties', async () => {
    const all = []
    for (let i = 0; i < 7; i += 1) all.push(await add({ description: 'EXAMPLE SAME', amountCents: -100 }))

    for (const sort of ['date', 'description', 'amount', 'account', 'category']) {
      const seen: number[] = []
      for (let offset = 0; offset < 7; offset += 3) seen.push(...(await search(`?sort=${sort}&limit=3&offset=${offset}`)).transactions.map((t) => t.id))
      expect(seen.sort((x, y) => x - y), sort).toEqual(all)
    }
  })

  it('gives an empty page past the end', async () => {
    await add()
    await add()
    expect(await search('?offset=10&count=true')).toEqual({ total: 2, transactions: [] })
  })

  it('pages a filtered list and counts only the filtered rows', async () => {
    for (let i = 1; i <= 5; i += 1) await add({ description: `EXAMPLE CAFE ${i}`, date: `2026-10-0${i}` })
    for (let i = 1; i <= 4; i += 1) await add({ description: `EXAMPLE OTHER ${i}` })

    const second = await search('?text=cafe&limit=2&offset=2&count=true')

    expect(second.total).toBe(5)
    expect(second.transactions.map((t) => t.description)).toEqual(['EXAMPLE CAFE 3', 'EXAMPLE CAFE 2'])
  })

  it.each([
    ['limit', 'lots'],
    ['limit', '-1'],
    ['offset', '1.5'],
    ['offset', '1234567890'],
  ])('rejects %s=%s, naming only the field', async (field, value) => {
    expect(await refusal(`?${field}=${value}`)).toEqual({ status: 400, body: { error: 'Invalid request', field } })
  })
})

describe('counting', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i += 1) await add({ description: `EXAMPLE CAFE ${i}` })
  })

  it('counts on the first page and leaves it out of later ones, which the page already has the total for', async () => {
    expect(await search('?limit=2')).toMatchObject({ total: 5, transactions: [{}, {}] })
    expect(await search('?limit=2&offset=2')).toMatchObject({ total: null, transactions: [{}, {}] })
  })

  it('leaves the count out when asked, whatever the page', async () => {
    expect(await search('?limit=2&count=false')).toMatchObject({ total: null, transactions: [{}, {}] })
  })

  it('counts a later page when asked', async () => {
    expect(await search('?limit=2&offset=4&count=true')).toMatchObject({ total: 5, transactions: [{}] })
  })

  it('counts alone, with no rows, when asked for only the count', async () => {
    expect(await search('?text=cafe&count=only')).toEqual({ total: 5, transactions: [] })
    expect(await search('?text=nothing&count=only')).toEqual({ total: 0, transactions: [] })
    expect(await search('?limit=2&offset=2&count=only')).toEqual({ total: 5, transactions: [] })
  })

  it('refuses any other count, naming only the field', async () => {
    expect(await refusal('?count=maybe')).toEqual({ status: 400, body: { error: 'Invalid request', field: 'count' } })
  })
})

describe('with several filters at once', () => {
  it('applies all of them together', async () => {
    const want = await add({ accountId: savings, date: '2026-10-10', description: 'EXAMPLE CAFE WANTED', overrideCategory: category('Eating out') })
    await add({ accountId: cheque, date: '2026-10-10', description: 'EXAMPLE CAFE WRONG ACCOUNT', overrideCategory: category('Eating out') })
    await add({ accountId: savings, date: '2026-09-10', description: 'EXAMPLE CAFE WRONG DATE', overrideCategory: category('Eating out') })
    await add({ accountId: savings, date: '2026-10-10', description: 'EXAMPLE CAFE WRONG CATEGORY', overrideCategory: category('Fuel') })
    await add({ accountId: savings, date: '2026-10-10', description: 'EXAMPLE HARDWARE WRONG TEXT', overrideCategory: category('Eating out') })

    const page = await search(`?accountId=${savings}&categoryId=${category('Eating out')}&from=2026-10-01&to=2026-10-31&text=cafe&sort=amount&dir=asc&limit=10&offset=0`)

    expect(page.total).toBe(1)
    expect(page.transactions.map((t) => t.id)).toEqual([want])
  })

  it('combines Uncategorised with the other filters', async () => {
    const want = await add({ accountId: savings, description: 'EXAMPLE CAFE' })
    await add({ accountId: savings, description: 'EXAMPLE CAFE', overrideCategory: category('Eating out') })
    await add({ accountId: cheque, description: 'EXAMPLE CAFE' })

    expect((await search(`?accountId=${savings}&uncategorised=true&text=cafe`)).transactions.map((t) => t.id)).toEqual([want])
  })
})

describe('who can search', () => {
  it('lets a Member read the list and a single Transaction', async () => {
    const id = await add({ description: 'EXAMPLE CAFE' })
    expect(await descriptions('?text=cafe')).toEqual(['EXAMPLE CAFE'])
    expect((await call(`/api/transactions/${id}`, 'member')).status).toBe(200)
  })

  // Take the sign-in check out of worker/app.ts and each of these returns 200 with the data.
  it('refuses someone who is not signed in', async () => {
    const id = await add()
    for (const path of ['/api/transactions', '/api/transactions?text=example', `/api/transactions/${id}`]) {
      const res = await exports.default.fetch(new Request(`https://app.test${path}`))
      expect(res.status, path).toBe(401)
      expect(await res.text(), path).not.toContain('EXAMPLE')
    }
  })
})

describe('GET /api/transactions/:id', () => {
  it('returns the bank fields under bank-prefixed names, with the Category, Note and source', async () => {
    const id = await add({ date: '2026-10-08', amountCents: -2345, description: 'EXAMPLE CAFE TOWN', bankMemo: 'EFTPOS', note: 'Lunch with Sam', overrideCategory: category('Eating out') })
    await env.DB.prepare("UPDATE transactions SET bank_type = 'EFTPOS', bank_reference = 'CHQ 000123' WHERE id = ?").bind(id).run()

    const res = await call(`/api/transactions/${id}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id,
      accountId: savings,
      accountName: 'Example savings',
      date: '2026-10-08',
      amountCents: -2345,
      description: 'EXAMPLE CAFE TOWN',
      bankMemo: 'EFTPOS',
      bankType: 'EFTPOS',
      bankReference: 'CHQ 000123',
      bankCounterpartyAccount: null,
      bankCardSuffix: null,
      bankParticulars: null,
      bankPaymentCode: null,
      source: 'import',
      categoryId: category('Eating out'),
      categoryName: 'Eating out',
      categorySource: 'override',
      note: 'Lunch with Sam',
      transfer: null,
      transferAccountName: null,
      transferTransactionId: null,
      bankTime: null,
      firstSeenAt: null,
    })
  })

  it('returns what Sync supplied: the counterparty, card, particulars and code', async () => {
    const id = await add()
    await env.DB.prepare(
      "UPDATE transactions SET source = 'sync', bank_counterparty_account = '99-9999-9999999-97', bank_card_suffix = '1234', bank_particulars = 'EXAMPLE PART', bank_payment_code = 'EXAMPLE CODE', bank_reference = 'EXAMPLE REF' WHERE id = ?",
    )
      .bind(id)
      .run()

    expect(await (await call(`/api/transactions/${id}`)).json()).toMatchObject({
      source: 'sync',
      bankCounterpartyAccount: '99-9999-9999999-97',
      bankCardSuffix: '1234',
      bankParticulars: 'EXAMPLE PART',
      bankPaymentCode: 'EXAMPLE CODE',
      bankReference: 'EXAMPLE REF',
    })
  })

  it('returns the Bank Time only when the bank supplied one, and never from the raw date alone', async () => {
    const supplied = await add()
    const notSupplied = await add()
    const unknown = await add()
    const set = env.DB.prepare('UPDATE transactions SET akahu_date_raw = ?, has_bank_time = ?, akahu_first_seen_at = ? WHERE id = ?')
    await env.DB.batch([
      set.bind('2026-10-07T20:15:00.000Z', 1, '2026-10-08T06:00:00.000Z', supplied),
      set.bind('2026-10-07T11:00:00.000Z', 0, '2026-10-08T06:00:00.000Z', notSupplied), // midnight NZ: a date with no time
      set.bind('2026-10-07T11:00:00.000Z', null, null, unknown),
    ])

    expect(await (await call(`/api/transactions/${supplied}`)).json()).toMatchObject({ bankTime: '2026-10-07T20:15:00.000Z', firstSeenAt: '2026-10-08T06:00:00.000Z' })
    expect(await (await call(`/api/transactions/${notSupplied}`)).json()).toMatchObject({ bankTime: null, firstSeenAt: '2026-10-08T06:00:00.000Z' })
    expect(await (await call(`/api/transactions/${unknown}`)).json()).toMatchObject({ bankTime: null, firstSeenAt: null })
  })

  it('shows no Category for one that is Uncategorised', async () => {
    const id = await add()
    expect(await (await call(`/api/transactions/${id}`)).json()).toMatchObject({ categoryId: null, categoryName: null, categorySource: null })
  })

  it.each(['99999', '0', 'abc', '1.5', '-1', '1e3', '0x10', '12345678901234567890'])('answers 404 for the ID %j', async (id) => {
    await add()
    const res = await call(`/api/transactions/${id}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})
