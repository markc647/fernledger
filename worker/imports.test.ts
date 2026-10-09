import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import * as transactionsChanged from './transactions-changed'

const afterTransactionsChanged = vi.spyOn(transactionsChanged, 'afterTransactionsChanged')

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

const chunkBody = (rows: unknown[], extra: { number?: string; name?: string; index?: number; count?: number; skipped?: number; fileRows?: number } = {}) => ({
  account: { number: extra.number ?? savings, ...(extra.name ? { name: extra.name } : {}) },
  chunk: { index: extra.index ?? 0, count: extra.count ?? 1 },
  file: { adapterId: 'asb', rowCount: extra.fileRows ?? rows.length, skipped: extra.skipped ?? 0, from: '2026-10-01', to: '2026-10-31' },
  rows,
})

const sendChunk = (rows: unknown[], extra: Parameters<typeof chunkBody>[1] = {}, who: Who = 'admin') =>
  call('/api/imports/chunks', { who, method: 'POST', body: chunkBody(rows, extra) })

type TransactionsPage = { total: number; transactions: { date: string; description: string; bankType: string; amountCents: number; accountName: string }[] }
const transactions = async (query = ''): Promise<TransactionsPage> => (await call(`/api/transactions${query}`)).json()
const accounts = async (): Promise<{ id: number; name: string; accountNumber: string }[]> => (await call('/api/accounts')).json()
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, type, before, after FROM change_log ORDER BY id').all()).results

beforeEach(async () => {
  await env.DB.batch(['transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  afterTransactionsChanged.mockClear()
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
  it('takes a 1,200-row file as chunks of 500, 500 and 200, each with its own accurate Change Log entry', async () => {
    const ranges = [
      [1, 500],
      [501, 1000],
      [1001, 1200],
    ] as const
    const results = []
    for (const [index, [first, last]] of ranges.entries()) {
      const res = await sendChunk(rowsFrom(first, last), { index, count: 3, fileRows: 1200 })
      expect(res.status).toBe(200)
      results.push(await res.json())
    }

    expect(results).toMatchObject([{ added: 500 }, { added: 500 }, { added: 200 }])
    expect((await transactions()).total).toBe(1200)
    const log = await changeLog()
    expect(log.map((e) => e.summary)).toEqual([
      `Imported 500 rows into ${savings} (part 1 of 3)`,
      `Imported 500 rows into ${savings} (part 2 of 3)`,
      `Imported 200 rows into ${savings} (part 3 of 3)`,
    ])
    expect(log.map((e) => e.actor)).toEqual(Array(3).fill('admin@example.com'))
    expect(log.map((e) => JSON.parse(e.after as string))).toMatchObject([
      { part: 1, parts: 3, added: 500, duplicates: 0, fileRows: 1200, newAccount: true },
      { part: 2, parts: 3, added: 500, duplicates: 0, fileRows: 1200, newAccount: false },
      { part: 3, parts: 3, added: 200, duplicates: 0, fileRows: 1200, newAccount: false },
    ])
  })

  it('logs only what a stopped Import saved, not the whole file', async () => {
    await sendChunk(rowsFrom(1, 500), { index: 0, count: 3, fileRows: 1200 }) // the browser never sends parts 2 and 3

    const log = await changeLog()
    expect(log).toHaveLength(1)
    expect(log[0]!.summary).toBe(`Imported 500 rows into ${savings} (part 1 of 3)`)
    expect(JSON.parse(log[0]!.after as string)).toMatchObject({ part: 1, parts: 3, added: 500, fileRows: 1200 })
  })

  it('logs a resent chunk as 0 added and counts its duplicates', async () => {
    await sendChunk(rowsFrom(1, 3), { index: 0, count: 2 })
    await env.DB.prepare('DELETE FROM change_log').run()

    await sendChunk(rowsFrom(1, 3), { index: 0, count: 2 })

    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry!.summary).toBe(`Imported 0 rows into ${savings} (part 1 of 2)`)
    expect(JSON.parse(entry!.after as string)).toMatchObject({ added: 0, duplicates: 3, newAccount: false })
  })

  it('logs a later chunk that has no first chunk of its own, for an Account an earlier Import created', async () => {
    await sendChunk(rowsFrom(1, 2))
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await sendChunk(rowsFrom(2, 4), { index: 2, count: 3 })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: 2, duplicates: 1 })
    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry!.summary).toBe(`Imported 2 rows into ${savings} (part 3 of 3)`)
    expect(JSON.parse(entry!.after as string)).toMatchObject({ part: 3, parts: 3, added: 2, duplicates: 1, newAccount: false })
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
    expect(await changeLog()).toEqual([])
  })

  it('calls the after-Transactions-changed hook after every chunk', async () => {
    // Through the Worker's handler imported here: the spy above sees the calls the Worker makes.
    const viaHandler = async (rows: unknown[], index: number) => {
      const ctx = createExecutionContext()
      const request = new Request(`${origin}/api/imports/chunks`, {
        method: 'POST',
        headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunkBody(rows, { index, count: 3 })),
      })
      const res = await worker.fetch!(request as never, env, ctx)
      await waitOnExecutionContext(ctx)
      return (await res.json()) as { accountId: number }
    }
    const { accountId } = await viaHandler(rowsFrom(1, 2), 0)
    expect(afterTransactionsChanged).toHaveBeenCalledTimes(1)

    await viaHandler(rowsFrom(3, 4), 1)
    await viaHandler(rowsFrom(3, 4), 2) // adds nothing, but the chunk still committed

    expect(afterTransactionsChanged).toHaveBeenCalledTimes(3)
    expect(afterTransactionsChanged).toHaveBeenLastCalledWith(env.DB, { accountId })
  })

  it('stores the fields of a row, using the memo when the payee is empty', async () => {
    await sendChunk([row(1, { payee: '', bankMemo: 'BANK FEE', tranType: 'FEE' }), row(2, { chequeNumber: '000123' })])

    const page = await transactions()
    expect(page.transactions.find((t) => t.date === '2026-10-01')).toMatchObject({ description: 'BANK FEE', bankType: 'FEE' })
    const stored = await env.DB.prepare('SELECT bank_reference, source FROM transactions WHERE bank_unique_id = ?').bind('ID2').first()
    expect(stored).toEqual({ bank_reference: '000123', source: 'import' })
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
  it('records who imported, how many rows were added, and the file summary', async () => {
    await sendChunk(rowsFrom(1, 3), { skipped: 2, name: 'Mum savings' })

    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ actor: 'admin@example.com', type: 'import', summary: 'Imported 3 rows into Mum savings' })
    expect(JSON.parse(entry!.after as string)).toEqual({
      adapter: 'asb',
      part: 1,
      parts: 1,
      added: 3,
      duplicates: 0,
      fileRows: 3,
      skipped: 2,
      from: '2026-10-01',
      to: '2026-10-31',
      newAccount: true,
    })
  })

  it('counts duplicates, including a repeat inside the chunk', async () => {
    await sendChunk([row(1)])
    await env.DB.prepare('DELETE FROM change_log').run()

    await sendChunk([row(1), row(2), row(2), row(3)])

    const [entry] = await changeLog()
    expect(entry!.summary).toBe(`Imported 2 rows into ${savings}`)
    expect(JSON.parse(entry!.after as string)).toMatchObject({ added: 2, duplicates: 2 })
  })

  it('is not written when the request is refused', async () => {
    await sendChunk([row(1, { date: '2026-02-30' })])

    expect(await changeLog()).toEqual([])
  })
})

describe('account numbers', () => {
  it('treats a three-digit suffix with a leading zero as the same Account', async () => {
    await sendChunk([row(1)], { number: '99-9999-9999999-099' })
    await sendChunk([row(2)], { number: savings })

    expect(await accounts()).toMatchObject([{ accountNumber: savings }])
    expect((await transactions()).total).toBe(2)
  })

  it('keeps a suffix that really has three digits', async () => {
    await sendChunk([row(1)], { number: '99-9999-9999999-100' })

    expect(await accounts()).toMatchObject([{ accountNumber: '99-9999-9999999-100' }])
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
      { actor: 'admin@example.com', type: 'account', summary: `Renamed Account ${savings} to Mum savings`, before: `{"name":"${savings}"}`, after: '{"name":"Mum savings"}' },
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
    ['a unique ID that is too long', { rows: [row(1, { uniqueId: 'x'.repeat(65) })] }, 'rows.0.uniqueId'],
    ['a transaction type that is too long', { rows: [row(1, { tranType: 'x'.repeat(41) })] }, 'rows.0.tranType'],
    ['a cheque number that is too long', { rows: [row(1, { chequeNumber: 'x'.repeat(41) })] }, 'rows.0.chequeNumber'],
    ['a memo that is too long', { rows: [row(1, { bankMemo: 'x'.repeat(201) })] }, 'rows.0.bankMemo'],
    ['a chunk index past the count', { chunk: { index: 2, count: 2 } }, 'chunk.index'],
    ['more chunks than one Import may have', { chunk: { index: 0, count: 21 } }, 'chunk.count'],
    ['a file start date that is not a real day', { file: { ...chunkBody([row(1)]).file, from: '2026-02-30' } }, 'file.from'],
    ['a file end date that is not a real day', { file: { ...chunkBody([row(1)]).file, to: '2026-13-01' } }, 'file.to'],
  ])('refuses %s, naming the field', async (_name, change, field) => {
    const res = await call('/api/imports/chunks', { method: 'POST', body: { ...chunkBody([row(1)]), ...change } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
    expect(await accounts()).toEqual([])
  })
})
