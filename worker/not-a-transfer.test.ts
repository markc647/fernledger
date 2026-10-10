import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { PAIR_ONE, clearNotTransferStatement, markNotTransferStatement, pairOneStatement, pairTransfersStatement } from './transfers'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only). All the data is made up (bank 99).
// "Not a Transfer" (ticket 37) undoes a wrong pairing: both halves stop being a Transfer, and nothing pairs them again
// until the Admin treats them as a Transfer again. The pairs are made by an Import (worker/transfers.ts), so every test imports files.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

const EVERYDAY = { number: '99-9999-9999999-01', name: 'Everyday' }
const SAVINGS = { number: '99-9999-9999999-02', name: 'Savings' }
const BILLS = { number: '99-9999-9999999-03', name: 'Bills' }
type Account = typeof EVERYDAY

const DAY = '2026-10-05'

let serial = 0
/** A made-up row; each gets a bank unique ID of its own, so rows that look identical are still different rows. */
const row = (date: string, amountCents: number, payee = 'EXAMPLE TRANSFER', uniqueId = `U${++serial}`) => ({ date, uniqueId, tranType: 'TFR', chequeNumber: null, payee, bankMemo: '', amountCents })

const sendChunk = (account: Account, rows: unknown[], extra: { replace?: boolean } = {}) =>
  call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account,
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows,
      ...(extra.replace ? { replace: true } : {}),
    },
  })
async function importInto(account: Account, rows: unknown[], extra: { replace?: boolean } = {}) {
  const res = await sendChunk(account, rows, extra)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}

type Listed = {
  id: number
  accountName: string
  description: string
  amountCents: number
  categoryName: string | null
  categorySource: string | null
  transfer: 'pair' | 'rule' | null
  transferAccountName: string | null
}
const list = async (query = '', who: Who = 'admin') => (await (await call(`/api/transactions?limit=200${query}`, { who })).json()) as { total: number | null; transactions: Listed[] }
const described = async (query = '') => (await list(query)).transactions
const byDescription = async (description: string) => (await described()).find((t) => t.description === description)!

/** Which unique IDs are paired with which, each pair once, as `[lower row, higher row]`. Read from the database: the API names no row's partner by its bank ID. */
const pairs = async () =>
  (await env.DB.prepare('SELECT a.bank_unique_id AS a, b.bank_unique_id AS b FROM transactions a JOIN transactions b ON b.id = a.transfer_of WHERE a.id < b.id ORDER BY a.id').all<{ a: string; b: string }>()).results.map(
    (p) => [p.a, p.b],
  )
/** The bank IDs of the Transactions that are not paired, in alphabetical order. */
const unpaired = async () => (await env.DB.prepare('SELECT bank_unique_id AS uid FROM transactions WHERE transfer_of IS NULL ORDER BY uid').all<{ uid: string }>()).results.map((r) => r.uid)
const idOf = async (uniqueId: string) => (await env.DB.prepare('SELECT id FROM transactions WHERE bank_unique_id = ?').bind(uniqueId).first<{ id: number }>())!.id
/** The marker as stored: the ID of the Transaction it was marked together with, its own ID when it was marked alone, null while it is not marked. */
const marker = async (uniqueId: string) => (await env.DB.prepare('SELECT not_transfer_with AS marker FROM transactions WHERE bank_unique_id = ?').bind(uniqueId).first<{ marker: number | null }>())!.marker

type Detail = { id: number; transfer: 'pair' | 'rule' | null; notTransfer: boolean; transferAccountName: string | null; transferTransactionId: number | null; categoryName: string | null }
const detail = async (uniqueId: string, who: Who = 'admin') => (await (await call(`/api/transactions/${await idOf(uniqueId)}`, { who })).json()) as Detail

const notTransfer = async (uniqueId: string, who: Who = 'admin') => call(`/api/transactions/${await idOf(uniqueId)}/not-transfer`, { who, method: 'POST', body: {} })
const treatAsTransferAgain = async (uniqueId: string, who: Who = 'admin') => call(`/api/transactions/${await idOf(uniqueId)}/not-transfer`, { who, method: 'DELETE', body: {} })

const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id
const transferRule = async (textContains: string) => expect((await call('/api/rules', { method: 'POST', body: { textContains, transfer: true } })).status).toBe(201)
const override = async (uniqueId: string, categoryId: number) => expect((await call(`/api/transactions/${await idOf(uniqueId)}/override`, { method: 'PUT', body: { categoryId } })).status).toBe(200)

type LogEntry = { type: string | null; summary: string; before: string | null; after: string | null; actor: string }
const transferLog = async () => ((await (await call('/api/change-log?type=transfer', { who: 'member' })).json()) as { entries: LogEntry[] }).entries

/** A wrongly paired $50.00 out of Everyday and in to Savings, the same day. */
async function wrongPair() {
  await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT')])
  await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])
  expect(await pairs()).toEqual([['OUT', 'IN']])
}

beforeEach(async () => {
  serial = 0
  await env.DB.batch(['balance_checks', 'transactions', 'rules', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
})

describe('marking a pairing as Not a Transfer', () => {
  it('unpairs both halves in one step, and each shows its own Category', async () => {
    const groceries = await categoryId('Groceries')
    expect((await call('/api/rules', { method: 'POST', body: { textContains: 'GROC', categoryId: groceries } })).status).toBe(201)
    await importInto(EVERYDAY, [row(DAY, -5000, 'GROC SHOP', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'CREDIT', 'IN')])
    expect(await byDescription('GROC SHOP')).toMatchObject({ transfer: 'pair', categoryName: null })

    const res = await notTransfer('OUT')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: true })
    expect(await pairs()).toEqual([])
    expect(await unpaired()).toEqual(['IN', 'OUT'])
    // Neither is a Transfer now: the one a Rule categorises is in that Category, and the other has none.
    expect(await byDescription('GROC SHOP')).toMatchObject({ transfer: null, transferAccountName: null, categoryName: 'Groceries', categorySource: 'rule' })
    expect(await byDescription('CREDIT')).toMatchObject({ transfer: null, transferAccountName: null, categoryName: null })
  })

  it('leaves both out of the Transfers and into spending, the Uncategorised list and the filters', async () => {
    await wrongPair()
    expect((await list('&transfers=only')).total).toBe(2)
    expect((await described('&uncategorised=true'))).toEqual([])

    await notTransfer('OUT')

    expect(await described('&transfers=only')).toEqual([])
    expect((await list('&transfers=exclude')).total).toBe(2)
    expect((await described('&uncategorised=true')).map((t) => t.description).sort()).toEqual(['EXAMPLE REFUND', 'EXAMPLE SHOP'])
  })

  it('is the same from either half', async () => {
    await wrongPair()

    expect((await notTransfer('IN')).status).toBe(200)

    expect(await pairs()).toEqual([])
    expect((await described()).map((t) => t.transfer)).toEqual([null, null])
  })

  it('marks each half with the other, so that treating it as a Transfer again can find both', async () => {
    await wrongPair()

    await notTransfer('OUT')

    expect(await marker('OUT')).toBe(await idOf('IN'))
    expect(await marker('IN')).toBe(await idOf('OUT'))
  })

  it("says in the details that the Admin marked it, and shows no matching Transaction", async () => {
    await wrongPair()
    expect(await detail('OUT')).toMatchObject({ notTransfer: false, transfer: 'pair' })

    await notTransfer('OUT')

    for (const uniqueId of ['OUT', 'IN']) {
      expect(await detail(uniqueId, 'member')).toMatchObject({ notTransfer: true, transfer: null, transferAccountName: null, transferTransactionId: null })
    }
  })

  it('is left out of the Transfers in the CSV file and the Report too, as in the list', async () => {
    await wrongPair()
    const dataLines = async (query: string) => ((await (await call(`/api/transactions/export.csv${query}`, { who: 'member' })).text()).match(/^\d{4}-\d{2}-\d{2},.*$/gm) ?? []).length
    const everyday = (await env.DB.prepare('SELECT id FROM accounts WHERE name = ?').bind('Everyday').first<{ id: number }>())!.id
    const reported = async () =>
      ((await (await call(`/api/reports/transactions?accountId=${everyday}&from=2026-10-01&to=2026-10-31`, { who: 'member' })).json()) as { transactions: { transfer: string | null }[] }).transactions.map((t) => t.transfer)
    expect(await dataLines('?transfers=only')).toBe(2)
    expect(await reported()).toEqual(['pair'])

    await notTransfer('OUT')

    expect(await dataLines('?transfers=only')).toBe(0)
    expect(await dataLines('?transfers=exclude')).toBe(2)
    expect(await reported()).toEqual([null])
  })

  it('leaves the other pairs and the Transactions of other Accounts alone', async () => {
    await wrongPair()
    await importInto(BILLS, [row(DAY, -300, 'B-OUT', 'B-OUT')])
    await importInto(SAVINGS, [row(DAY, 300, 'B-IN', 'B-IN')])

    await notTransfer('OUT')

    expect(await pairs()).toEqual([['B-OUT', 'B-IN']])
    expect(await marker('B-OUT')).toBeNull()
    expect(await marker('B-IN')).toBeNull()
  })

  it('writes one Change Log entry of type transfer, naming both Transactions, and no entry for a request it refuses', async () => {
    await wrongPair()

    await notTransfer('OUT')

    const entries = await transferLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'transfer', actor: 'admin@example.com' })
    expect(entries[0]!.summary).toContain(`Transaction ${await idOf('OUT')} (${DAY}, EXAMPLE SHOP)`)
    expect(entries[0]!.summary).toContain(`Transaction ${await idOf('IN')} (${DAY}, EXAMPLE REFUND)`)
    expect(entries[0]!.summary).toMatch(/as Not a Transfer$/)
    expect(JSON.parse(entries[0]!.before!)).toMatchObject({ notTransfer: false, pairedWith: await idOf('IN') })
    expect(JSON.parse(entries[0]!.after!)).toMatchObject({ notTransfer: true })
    // The Change Log lets Members filter by the new type.
    const types = ((await (await call('/api/change-log', { who: 'member' })).json()) as { types: { id: string; label: string }[] }).types
    expect(types).toContainEqual({ id: 'transfer', label: 'Transfer' })
  })

  it('does nothing and logs nothing when it is already marked', async () => {
    await wrongPair()
    await notTransfer('OUT')

    const again = await notTransfer('IN')

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ id: await idOf('IN'), notTransfer: true })
    expect(await transferLog()).toHaveLength(1)
  })

  it('refuses a Transaction that is not a Transfer, and changes nothing', async () => {
    await importInto(EVERYDAY, [row(DAY, -2000, 'EXAMPLE SHOP', 'SHOP')])

    const res = await notTransfer('SHOP')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This Transaction is not a Transfer' })
    expect(await marker('SHOP')).toBeNull()
    expect(await transferLog()).toEqual([])
  })

  it('says 404 for a Transaction that does not exist, and for an ID that is not a number', async () => {
    for (const method of ['POST', 'DELETE']) {
      for (const id of ['999999', 'abc', '1e3', '99999999999999999999']) {
        const res = await call(`/api/transactions/${id}/not-transfer`, { method, body: {} })
        expect(res.status, `${method} ${id}`).toBe(404)
      }
    }
    expect(await transferLog()).toEqual([])
  })

  it('works on the half an Override already made spending, which is how a wrong pairing was undone before', async () => {
    await wrongPair()
    await override('OUT', await categoryId('Gifts and donations'))
    expect(await byDescription('EXAMPLE REFUND')).toMatchObject({ transfer: 'pair' })

    // From the half that is still a Transfer.
    expect((await notTransfer('IN')).status).toBe(200)

    expect(await byDescription('EXAMPLE REFUND')).toMatchObject({ transfer: null, categoryName: null })
    // The Override stays: it is the Admin's own choice and nothing here takes it away.
    expect(await byDescription('EXAMPLE SHOP')).toMatchObject({ transfer: null, categoryName: 'Gifts and donations', categorySource: 'override' })
    expect(await pairs()).toEqual([])
  })

  it('works from the half an Override made spending, though the list calls it spending', async () => {
    await wrongPair()
    await override('OUT', await categoryId('Gifts and donations'))

    expect((await notTransfer('OUT')).status).toBe(200)

    expect(await pairs()).toEqual([])
    expect(await byDescription('EXAMPLE REFUND')).toMatchObject({ transfer: null })
    expect(await marker('IN')).toBe(await idOf('OUT'))
  })
})

describe('a marked pairing is not made again', () => {
  it('when a later Import adds a Transaction that would have taken the first half of it', async () => {
    await wrongPair()
    await notTransfer('OUT')
    // Another $50.00 out and in. The marked $50.00 out is older, so without the marker it would be the one the new $50.00 in takes.
    await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP TWO', 'OUT2')])
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND TWO', 'IN2')])

    expect(await pairs()).toEqual([['OUT2', 'IN2']])
    expect(await unpaired()).toEqual(['IN', 'OUT'])
  })

  it('when the Account of one half is imported again, so the other half has a new Transaction to meet', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN-AGAIN')])
    await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT-AGAIN')])

    // The new $50.00 in finds the marked $50.00 out and leaves it; the new $50.00 out then takes the new $50.00 in.
    expect(await pairs()).toEqual([['IN-AGAIN', 'OUT-AGAIN']])
    expect(await unpaired()).toEqual(['IN', 'OUT'])
  })

  it('when the history of one Account is replaced with the same Transactions', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')], { replace: true })

    expect(await pairs()).toEqual([])
    expect((await described()).map((t) => t.transfer)).toEqual([null, null])
    // The marked half is still marked: it was not replaced, and nothing says it is a Transfer.
    expect(await marker('OUT')).not.toBeNull()
  })

  it('whichever half is replaced', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT')], { replace: true })

    expect(await pairs()).toEqual([])
    expect(await marker('IN')).not.toBeNull()
  })

  it('even when a run of the pairing covers the marked Transaction as one of the rows it was given to pair', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await importInto(BILLS, [row(DAY, 5000, 'EXAMPLE DEPOSIT', 'DEPOSIT')])
    expect(await pairs()).toEqual([])

    // The ID range starts before every row, as a run for the Account's whole history would.
    await pairTransfersStatement(env.DB, { accountNumber: EVERYDAY.number, afterId: 0 }).run()

    expect(await pairs()).toEqual([])
  })

  it('and pairing still pairs a Transaction that was never marked', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await importInto(BILLS, [row(DAY, -5000, 'EXAMPLE BILL', 'BILL')])

    // The Bills $50.00 out meets the $50.00 in that was marked: it does not pair with it.
    expect(await pairs()).toEqual([])
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE TOP-UP', 'TOP-UP')])

    expect(await pairs()).toEqual([['BILL', 'TOP-UP']])
  })
})

describe('a Rule that marks Transfers, once the Admin has said Not a Transfer', () => {
  it('no longer applies to a Transaction it marked and nothing paired', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND'), row(DAY, -1200, 'EXAMPLE SHOP', 'SHOP')])
    expect(await byDescription('ROUND UP TO SAVINGS')).toMatchObject({ transfer: 'rule' })

    const res = await notTransfer('ROUND')

    expect(res.status).toBe(200)
    expect(await byDescription('ROUND UP TO SAVINGS')).toMatchObject({ transfer: null, categoryName: null })
    expect(await described('&transfers=only')).toEqual([])
    expect((await described('&transfers=exclude')).map((t) => t.description).sort()).toEqual(['EXAMPLE SHOP', 'ROUND UP TO SAVINGS'])
    expect((await described('&uncategorised=true')).map((t) => t.description).sort()).toEqual(['EXAMPLE SHOP', 'ROUND UP TO SAVINGS'])
    expect(await detail('ROUND')).toMatchObject({ notTransfer: true, transfer: null })
    // Alone, so it holds its own ID.
    expect(await marker('ROUND')).toBe(await idOf('ROUND'))
  })

  it('still applies to a Transaction nobody marked, and to the new Transactions an Import adds', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP ONE', 'ROUND1')])
    await notTransfer('ROUND1')

    await importInto(EVERYDAY, [row(DAY, -60, 'ROUND UP TWO', 'ROUND2')])

    expect(await byDescription('ROUND UP ONE')).toMatchObject({ transfer: null })
    expect(await byDescription('ROUND UP TWO')).toMatchObject({ transfer: 'rule' })
  })

  it("does not make a paired half a Transfer when the Rule marks it too, since the marker outranks the Rule's flag", async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    await importInto(SAVINGS, [row(DAY, 50, 'CREDIT', 'CREDIT')])
    expect(await pairs()).toEqual([['ROUND', 'CREDIT']])

    await notTransfer('ROUND')

    // Unpairing alone would leave 'ROUND' a Transfer because of the Rule; the marker is what stops that.
    expect((await described()).map((t) => t.transfer)).toEqual([null, null])
    expect(await detail('ROUND')).toMatchObject({ transfer: null, notTransfer: true })
  })

  it('applies to it again once the Admin treats it as a Transfer again', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    await notTransfer('ROUND')

    const res = await treatAsTransferAgain('ROUND')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('ROUND'), notTransfer: false, paired: false })
    expect(await marker('ROUND')).toBeNull()
    expect(await byDescription('ROUND UP TO SAVINGS')).toMatchObject({ transfer: 'rule' })
  })

  it('keeps an Override above it, as it always was', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP', 'ROUND')])
    await override('ROUND', await categoryId('Gifts and donations'))

    // The Override already makes it spending, and the Rule still flags it, so the Admin may mark it all the same.
    expect((await notTransfer('ROUND')).status).toBe(200)
    expect(await byDescription('ROUND UP')).toMatchObject({ transfer: null, categoryName: 'Gifts and donations' })
  })
})

describe('treating a marked pairing as a Transfer again', () => {
  it('clears the marker on both halves, and pairs them again', async () => {
    await wrongPair()
    await notTransfer('OUT')

    const res = await treatAsTransferAgain('OUT')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: true })
    expect(await marker('OUT')).toBeNull()
    expect(await marker('IN')).toBeNull()
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect((await described()).map((t) => t.transfer)).toEqual(['pair', 'pair'])
    expect((await described()).find((t) => t.description === 'EXAMPLE SHOP')).toMatchObject({ transferAccountName: 'Savings' })
  })

  it('is the same from the other half', async () => {
    await wrongPair()
    await notTransfer('OUT')

    expect((await treatAsTransferAgain('IN')).status).toBe(200)

    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await marker('OUT')).toBeNull()
  })

  it('makes each a whole pair, and leaves the pairs of other Accounts as they were', async () => {
    await wrongPair()
    await importInto(BILLS, [row(DAY, -300, 'B-OUT', 'B-OUT')])
    await importInto(SAVINGS, [row(DAY, 300, 'B-IN', 'B-IN')])
    await notTransfer('OUT')

    await treatAsTransferAgain('OUT')

    expect(await pairs()).toEqual([['OUT', 'IN'], ['B-OUT', 'B-IN']])
    const broken = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions a WHERE a.transfer_of IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM transactions b WHERE b.id = a.transfer_of AND b.transfer_of = a.id AND b.account_id <> a.account_id AND b.date = a.date AND b.amount_cents = -a.amount_cents)`,
    ).first<{ n: number }>()
    expect(broken!.n).toBe(0)
  })

  it('writes a Change Log entry of type transfer', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await treatAsTransferAgain('IN')

    const entries = await transferLog()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'transfer', actor: 'admin@example.com' })
    expect(entries[0]!.summary).toMatch(/as a Transfer again/)
    expect(entries[0]!.summary).toContain(`Transaction ${await idOf('IN')} (${DAY}, EXAMPLE REFUND)`)
    expect(entries[0]!.summary).toContain(`Transaction ${await idOf('OUT')} (${DAY}, EXAMPLE SHOP)`)
    expect(JSON.parse(entries[0]!.before!)).toMatchObject({ notTransfer: true })
    expect(JSON.parse(entries[0]!.after!)).toMatchObject({ notTransfer: false })
  })

  it('does nothing and logs nothing for a Transaction that is not marked', async () => {
    await wrongPair()

    const res = await treatAsTransferAgain('OUT')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: false })
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await transferLog()).toEqual([])
  })

  it('clears its own marker when its matching Transaction has been replaced since, and pairs with what matches now', async () => {
    await wrongPair()
    await notTransfer('OUT')
    // The Savings history is replaced: the $50.00 in the Admin looked at is gone, and the new one that matches is a different Transaction.
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN-NEW')], { replace: true })
    expect(await pairs()).toEqual([])

    const res = await treatAsTransferAgain('OUT')

    expect(res.status).toBe(200)
    expect(await marker('OUT')).toBeNull()
    expect(await res.json()).toMatchObject({ paired: true })
    expect(await pairs()).toEqual([['OUT', 'IN-NEW']])
  })

  it('clears its own marker and pairs with nothing when its matching Transaction has gone and nothing else matches', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await importInto(SAVINGS, [row('2026-10-06', 1, 'EXAMPLE OTHER', 'ELSEWHERE')], { replace: true })

    const res = await treatAsTransferAgain('OUT')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: false })
    expect(await marker('OUT')).toBeNull()
    expect(await pairs()).toEqual([])
  })

  it('does not pair it with a Transaction that has been marked since', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await importInto(BILLS, [row(DAY, 5000, 'EXAMPLE DEPOSIT', 'DEPOSIT')])
    await importInto(SAVINGS, [row(DAY, -5000, 'EXAMPLE FEE', 'FEE')])
    // The new $50.00 out of Savings pairs with the $50.00 in to Bills, and the Admin says that one is wrong too.
    expect(await pairs()).toEqual([['DEPOSIT', 'FEE']])
    await notTransfer('FEE')

    await treatAsTransferAgain('OUT')

    // OUT goes back to the $50.00 in it was marked with, not to the marked pair.
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await marker('FEE')).not.toBeNull()
    expect(await marker('DEPOSIT')).not.toBeNull()
  })

  it('pairs a Transaction that was marked alone with a match that arrived while it was marked', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    await notTransfer('ROUND')
    await importInto(SAVINGS, [row(DAY, 50, 'CREDIT', 'CREDIT')])
    expect(await pairs()).toEqual([])

    const res = await treatAsTransferAgain('ROUND')

    expect(await res.json()).toMatchObject({ paired: true })
    expect(await pairs()).toEqual([['ROUND', 'CREDIT']])
  })
})

describe('who can mark a pairing', () => {
  it('refuses a Member, for marking and for treating it as a Transfer again, and changes nothing', async () => {
    await wrongPair()

    const marking = await notTransfer('OUT', 'member')
    expect(marking.status).toBe(403)
    expect(await marking.json()).toEqual({ error: 'Read-only' })
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await marker('OUT')).toBeNull()

    await notTransfer('OUT')
    const undoing = await treatAsTransferAgain('OUT', 'member')
    expect(undoing.status).toBe(403)
    expect(await undoing.json()).toEqual({ error: 'Read-only' })
    expect(await marker('OUT')).not.toBeNull()
    expect(await pairs()).toEqual([])
    expect(await transferLog()).toHaveLength(1)
  })

  it('refuses a request from another site, and one without a JSON body, before it reaches the handler', async () => {
    await wrongPair()
    const id = await idOf('OUT')
    const headers = { Cookie: 'fernledger_dev_as=admin' }

    const crossSite = await exports.default.fetch(new Request(`${origin}/api/transactions/${id}/not-transfer`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' }))
    const notJson = await exports.default.fetch(new Request(`${origin}/api/transactions/${id}/not-transfer`, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' }))

    expect(crossSite.status).toBe(403)
    expect(notJson.status).toBe(415)
    expect(await pairs()).toEqual([['OUT', 'IN']])
  })

  it('lets a Member see that a Transaction is marked, and which of its Transfers are not', async () => {
    await wrongPair()
    await notTransfer('OUT')

    expect((await detail('IN', 'member')).notTransfer).toBe(true)
    expect((await list('&transfers=only', 'member')).total).toBe(0)
  })
})

describe('what marking and undoing read and write (ADR 0004: free plan limits)', () => {
  const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail)
  const accountId = async (name: string) => (await env.DB.prepare('SELECT id FROM accounts WHERE name = ?').bind(name).first<{ id: number }>())!.id
  /** `count` made-up Transactions of the Account on 700 dates from 2020: old history that none of this should have to read. */
  const seedHistory = (id: number, count: number) =>
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) SELECT ?1, date('2020-01-01', '+' || (i % 700) || ' days'), -1000, 'EXAMPLE', 'import', 'OLD' || i FROM n`,
    )
      .bind(id, count)
      .run()

  it('reads and writes only the two halves, however long the history is', async () => {
    await wrongPair()
    await Promise.all([seedHistory(await accountId('Everyday'), 3000), seedHistory(await accountId('Savings'), 3000)])
    const out = await idOf('OUT')
    const inn = await idOf('IN')

    const mark = (await markNotTransferStatement(env.DB, { id: out, matchingId: inn }).run()).meta
    const clear = (await clearNotTransferStatement(env.DB, { id: out, matchingId: inn }).run()).meta
    const repair = (await pairOneStatement(env.DB, { id: out, prefer: inn }).run()).meta
    const repairOther = (await pairOneStatement(env.DB, { id: inn, prefer: out }).run()).meta

    expect(mark.changes).toBe(2)
    expect(mark.rows_read).toBeLessThanOrEqual(8)
    // Each half is written with its entry in the Transfer index (row and entry).
    expect(mark.rows_written).toBeLessThanOrEqual(4)
    expect(clear.changes).toBe(2)
    expect(clear.rows_read).toBeLessThanOrEqual(8)
    expect(clear.rows_written).toBeLessThanOrEqual(4)
    // Looking for a match reads the Transactions of that one day, not the 6,000 of other days.
    expect(repair.changes).toBe(2)
    expect(repair.rows_read).toBeLessThanOrEqual(30)
    expect(repair.rows_written).toBeLessThanOrEqual(4)
    // The other half finds itself paired already.
    expect(repairOther.changes).toBe(0)
    expect(repairOther.rows_written).toBe(0)
    expect(repairOther.rows_read).toBeLessThanOrEqual(10)
  })

  it('finds a match through the date index, never by scanning the Transactions', async () => {
    const reads = (await plan(PAIR_ONE, 1, 2)).filter((detail) => /^(SCAN|SEARCH) (a|o|transactions)\b/.test(detail))

    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toMatch(/USING (INTEGER PRIMARY KEY|INDEX transactions_date)/)
  })
})
