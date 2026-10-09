import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from './index'
import { transactionsChangedHooks, type TransactionsChange } from './transactions-changed'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only; Access token handling is tested in api.test.ts).
const origin = 'http://localhost:5173'
const savings = '99-9999-9999999-99'
const current = '99-9999-9999999-98'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}`, ...opts.headers }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

/** A made-up ASB row. Row `n` falls on day 1-28 of Oct 2026 (wrapping) and has its own bank unique ID. */
const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  date: `2026-10-${String(((n - 1) % 28) + 1).padStart(2, '0')}`,
  uniqueId: `ID${n}`,
  tranType: 'EFTPOS',
  chequeNumber: null,
  payee: `EXAMPLE SHOP ${n}`,
  bankMemo: 'EFTPOS',
  amountCents: -1000 * n,
  ...overrides,
})
const rowsFrom = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => row(first + i))

const chunkBody = (rows: unknown[], extra: { number?: string; name?: string; index?: number; count?: number; skipped?: number } = {}) => ({
  account: { number: extra.number ?? savings, ...(extra.name ? { name: extra.name } : {}) },
  chunk: { index: extra.index ?? 0, count: extra.count ?? 1 },
  file: { adapterId: 'asb', rowCount: rows.length, skipped: extra.skipped ?? 0, from: '2026-10-01', to: '2026-10-31' },
  rows,
})

const sendChunk = (rows: unknown[], extra: Parameters<typeof chunkBody>[1] = {}, who: Who = 'admin') =>
  call('/api/imports/chunks', { who, method: 'POST', body: chunkBody(rows, extra) })

type TransactionsPage = { total: number; transactions: { date: string; description: string; type: string; amountCents: number; accountName: string }[] }
const transactions = async (query = ''): Promise<TransactionsPage> => (await call(`/api/transactions${query}`)).json()
const accounts = async (): Promise<{ id: number; name: string; accountNumber: string }[]> => (await call('/api/accounts')).json()
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, before, after FROM change_log ORDER BY id').all()).results

beforeEach(async () => {
  await env.DB.batch(['transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  transactionsChangedHooks.length = 0
})

describe('POST /api/imports/chunks', () => {
  it('creates the Account from the file header and adds the rows, newest first in the list', async () => {
    const res = await sendChunk([row(1), row(2), row(3)])

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: 3, duplicates: 0 })
    expect(await accounts()).toMatchObject([{ name: savings, accountNumber: savings }])
    const page = await transactions()
    expect(page.total).toBe(3)
    expect(page.transactions.map((t) => t.date)).toEqual(['2026-10-03', '2026-10-02', '2026-10-01'])
    expect(page.transactions[0]).toMatchObject({ description: 'EXAMPLE SHOP 3', amountCents: -3000, accountName: savings })
  })
})

describe('re-importing', () => {
  it('skips rows the Account already holds, by the bank unique ID', async () => {
    await sendChunk([row(1), row(2), row(3)])

    const again = await sendChunk([row(1), row(2), row(3)])

    expect(await again.json()).toMatchObject({ added: 0, duplicates: 3 })
    expect((await transactions()).total).toBe(3)
  })

  it('adds only the new rows of an overlapping file', async () => {
    await sendChunk(rowsFrom(1, 3))

    const overlap = await sendChunk(rowsFrom(2, 5))

    expect(await overlap.json()).toMatchObject({ added: 2, duplicates: 2 })
    expect((await transactions()).total).toBe(5)
  })

  it('treats the same bank unique ID in another Account as a different Transaction', async () => {
    await sendChunk([row(1)])
    const other = await sendChunk([row(1)], { number: current })

    expect(await other.json()).toMatchObject({ added: 1, duplicates: 0 })
    expect((await transactions()).total).toBe(2)
    expect(await accounts()).toHaveLength(2)
  })

  it('counts a unique ID repeated within one chunk as a duplicate', async () => {
    const res = await sendChunk([row(1), row(1)])
    expect(await res.json()).toMatchObject({ added: 1, duplicates: 1 })
  })

  it('matches an existing Account by number and keeps its name', async () => {
    await sendChunk([row(1)], { name: 'Mum savings' })

    await sendChunk([row(2)], { name: 'Another name' })

    expect(await accounts()).toMatchObject([{ name: 'Mum savings', accountNumber: savings }])
  })
})

describe('chunked Imports', () => {
  it('takes a 1,200-row file as chunks of 500, 500 and 200, with one Change Log entry for the Import', async () => {
    const ranges = [
      [1, 500],
      [501, 1000],
      [1001, 1200],
    ] as const
    const results = []
    for (const [index, [first, last]] of ranges.entries()) {
      const res = await sendChunk(rowsFrom(first, last), { index, count: 3 })
      expect(res.status).toBe(200)
      results.push(await res.json())
    }

    expect(results).toMatchObject([{ added: 500 }, { added: 500 }, { added: 200 }])
    expect((await transactions()).total).toBe(1200)
    expect(await changeLog()).toMatchObject([{ actor: 'admin@example.com', summary: expect.stringContaining('Imported 500 rows') }])
  })

  it('refuses a chunk over 500 rows and writes nothing', async () => {
    const res = await sendChunk(rowsFrom(1, 501))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'rows' })
    expect(await accounts()).toEqual([])
    expect(await changeLog()).toEqual([])
  })

  it('can resend a chunk without duplicating its rows', async () => {
    await sendChunk(rowsFrom(1, 500), { index: 0, count: 2 })

    const retry = await sendChunk(rowsFrom(1, 500), { index: 0, count: 2 })

    expect(await retry.json()).toMatchObject({ added: 0, duplicates: 500 })
    expect((await transactions()).total).toBe(500)
  })

  it('refuses a later chunk for an Account the first chunk never created', async () => {
    const res = await sendChunk([row(1)], { index: 1, count: 2 })

    expect(res.status).toBe(409)
    expect(await accounts()).toEqual([])
  })

  it('calls the after-Transactions-changed hook once, after the last chunk', async () => {
    // Through the Worker's handler imported here, so the hook registered below is the one the Worker calls.
    const changes: TransactionsChange[] = []
    transactionsChangedHooks.push(async (_db, change) => void changes.push(change))
    const viaHandler = async (rows: unknown[], index: number) => {
      const ctx = createExecutionContext()
      const request = new Request(`${origin}/api/imports/chunks`, {
        method: 'POST',
        headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunkBody(rows, { index, count: 2 })),
      })
      const res = await worker.fetch!(request as never, env, ctx)
      await waitOnExecutionContext(ctx)
      return (await res.json()) as { accountId: number }
    }
    await viaHandler(rowsFrom(1, 2), 0)
    expect(changes).toEqual([])

    const { accountId } = await viaHandler(rowsFrom(3, 4), 1)

    expect(changes).toEqual([{ accountId }])
  })

  it('stores the fields of a row, using the memo when the payee is empty', async () => {
    await sendChunk([row(1, { payee: '', bankMemo: 'BANK FEE', tranType: 'FEE' }), row(2, { chequeNumber: '000123' })])

    const page = await transactions()
    expect(page.transactions.find((t) => t.date === '2026-10-01')).toMatchObject({ description: 'BANK FEE', type: 'FEE' })
    const stored = await env.DB.prepare('SELECT reference, source FROM transactions WHERE bank_unique_id = ?').bind('ID2').first()
    expect(stored).toEqual({ reference: '000123', source: 'import' })
  })
})

describe('who may import', () => {
  it('refuses a Member, and writes nothing', async () => {
    const res = await sendChunk([row(1)], {}, 'member')

    expect(res.status).toBe(403)
    expect(await accounts()).toEqual([])
    expect((await transactions()).total).toBe(0)
    expect(await changeLog()).toEqual([])
  })

  it('lets a Member read the Accounts and Transactions', async () => {
    await sendChunk([row(1)])

    const list = await call('/api/transactions', { who: 'member' })
    const names = await call('/api/accounts', { who: 'member' })

    expect(list.status).toBe(200)
    expect(names.status).toBe(200)
    expect(((await list.json()) as TransactionsPage).total).toBe(1)
  })
})

describe('the Change Log entry for an Import', () => {
  it('records who imported, how many rows, and the file summary', async () => {
    await sendChunk(rowsFrom(1, 3), { skipped: 2, name: 'Mum savings' })

    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ actor: 'admin@example.com', summary: 'Imported 3 rows into Mum savings' })
    expect(JSON.parse(entry!.after as string)).toEqual({ adapter: 'asb', rows: 3, skipped: 2, from: '2026-10-01', to: '2026-10-31', chunks: 1, newAccount: true })
  })

  it('is not written when the request is refused', async () => {
    await sendChunk([row(1, { date: '2026-02-30' })])

    expect(await changeLog()).toEqual([])
  })
})

describe('PATCH /api/accounts/:id', () => {
  const rename = (id: number, name: unknown, who: Who = 'admin') => call(`/api/accounts/${id}`, { who, method: 'PATCH', body: { name } })
  const firstAccountId = async () => (await accounts())[0]!.id

  it('lets the Admin rename an Account, and logs the change with the old and new name', async () => {
    await sendChunk([row(1)])
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await rename(await firstAccountId(), '  Mum savings ')

    expect(res.status).toBe(200)
    expect(await accounts()).toMatchObject([{ name: 'Mum savings', accountNumber: savings }])
    expect(await changeLog()).toMatchObject([
      { actor: 'admin@example.com', summary: `Renamed account ${savings} to Mum savings`, before: `{"name":"${savings}"}`, after: '{"name":"Mum savings"}' },
    ])
  })

  it('shows the new name on the Account’s Transactions', async () => {
    await sendChunk([row(1)])
    await rename(await firstAccountId(), 'Mum savings')

    expect((await transactions()).transactions[0]).toMatchObject({ accountName: 'Mum savings' })
  })

  it('refuses a Member, and changes nothing', async () => {
    await sendChunk([row(1)])
    const id = await firstAccountId()

    expect((await rename(id, 'Nope', 'member')).status).toBe(403)

    expect(await accounts()).toMatchObject([{ name: savings }])
  })

  it('answers 404 for an Account that does not exist, with no Change Log entry', async () => {
    expect((await rename(9999, 'Nope')).status).toBe(404)
    expect(await changeLog()).toEqual([])
  })

  it.each([[''], ['   '], ['x'.repeat(61)], [42]])('refuses the name %j', async (name) => {
    await sendChunk([row(1)])

    const res = await rename(await firstAccountId(), name)

    expect(res.status).toBe(400)
    expect(await accounts()).toMatchObject([{ name: savings }])
  })
})

describe('GET /api/transactions paging', () => {
  it('returns a page at a time, newest first, with the total', async () => {
    await sendChunk(rowsFrom(1, 28))

    const first = await transactions('?limit=10')
    const second = await transactions('?limit=10&offset=10')

    expect(first.total).toBe(28)
    expect(first.transactions.map((t) => t.date)).toEqual(Array.from({ length: 10 }, (_, i) => `2026-10-${28 - i}`))
    expect(second.transactions[0]!.date).toBe('2026-10-18')
    expect(second.transactions).toHaveLength(10)
  })

  it('refuses a limit that is not a number', async () => {
    expect((await call('/api/transactions?limit=lots')).status).toBe(400)
  })
})

describe('validating a chunk', () => {
  it.each([
    ['an account number that is not one', { account: { number: '1234' } }, 'account.number'],
    ['no rows', { rows: [] }, 'rows'],
    ['a row date that is not a real day', { rows: [row(1, { date: '2026-02-30' })] }, 'rows.0.date'],
    ['a row with no unique ID', { rows: [row(1, { uniqueId: '' })] }, 'rows.0.uniqueId'],
    ['a fractional amount', { rows: [row(1, { amountCents: 12.5 })] }, 'rows.0.amountCents'],
    ['a 29 February in a year without one', { rows: [row(1, { date: '2026-02-29' })] }, 'rows.0.date'],
    ['a payee that is too long', { rows: [row(1), row(2, { payee: 'x'.repeat(201) })] }, 'rows.1.payee'],
    ['a cheque number that is not text', { rows: [row(1, { chequeNumber: 123 })] }, 'rows.0.chequeNumber'],
    ['a row that is not an object', { rows: [row(1), null] }, 'rows.1'],
    ['a missing rows list', { rows: undefined }, 'rows'],
  ])('refuses %s, naming the field', async (_name, change, field) => {
    const res = await call('/api/imports/chunks', { method: 'POST', body: { ...chunkBody([row(1)]), ...change } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
    expect(await accounts()).toEqual([])
  })
})
