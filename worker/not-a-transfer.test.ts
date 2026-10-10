import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { APPLY_HELD, HOLD_REMOVED, MARK_APPLIED } from './carry-over'
import worker from './index'
import { WRITES_PER_CARRIED, WRITES_PER_MARK_REMOVED, WRITES_PER_OVERRIDE_REMOVED } from './import-rows'
import { PAIR_ONE, clearHeldNotTransferStatement, clearNotTransferStatement, markNotTransferStatement, pairOneStatement, pairTransfersStatement } from './transfers'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only). All the data is made up (bank 99).
// "Not a Transfer" (ticket 37) puts right a pairing that is wrong: both halves stop being a Transfer, and nothing pairs them
// until the Admin treats them as a Transfer again. The pairs are made by an Import (worker/transfers.ts), so every test imports files.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

/**
 * The same as `call` as the Admin, through a database that runs `before` just before the request's batch, to stand for another request
 * landing between the handler's read and its write. Calls `worker.fetch` directly because the test changes the Worker's env.
 */
async function callWhileInterrupted(path: string, method: string, before: () => Promise<unknown>) {
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => (await before(), target.batch(statements))
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const ctx = createExecutionContext()
  const request = new Request(`${origin}${path}`, { method, headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })
  const res = await worker.fetch!(request as never, { ...env, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

const EVERYDAY = { number: '99-9999-9999999-01', name: 'Everyday' }
const SAVINGS = { number: '99-9999-9999999-02', name: 'Savings' }
const BILLS = { number: '99-9999-9999999-03', name: 'Bills' }
type Account = typeof EVERYDAY

const DAY = '2026-10-05'

let serial = 0
/** A made-up row; each gets a bank unique ID of its own, so rows that look identical are still different rows. */
const row = (date: string, amountCents: number, payee = 'EXAMPLE TRANSFER', uniqueId = `U${++serial}`) => ({ date, uniqueId, tranType: 'TFR', chequeNumber: null, payee, bankMemo: '', amountCents })

const sendChunk = (account: Account, rows: unknown[], extra: { replace?: boolean; index?: number; count?: number } = {}) =>
  call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account,
      chunk: { index: extra.index ?? 0, count: extra.count ?? 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows,
      ...(extra.replace ? { replace: true } : {}),
    },
  })
async function importInto(account: Account, rows: unknown[], extra: { replace?: boolean; index?: number; count?: number } = {}) {
  const res = await sendChunk(account, rows, extra)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  return (await res.json()) as { lostTransactions: { description: string; notTransfer: boolean }[]; paired: number; carried: number; stillWaiting: number | null }
}
/** How many marks the Accounts are holding for a replace that has not finished. */
const heldMarks = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM carry_over WHERE not_transfer_with IS NOT NULL').first<{ n: number }>())!.n

type Listed = {
  id: number
  accountName: string
  description: string
  amountCents: number
  categoryName: string | null
  categorySource: string | null
  transfer: 'pair' | 'rule' | null
  transferAccountName: string | null
  canMarkNotTransfer: boolean
  notTransfer: boolean
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
const accountIdOf = async (name: string) => (await env.DB.prepare('SELECT id FROM accounts WHERE name = ?').bind(name).first<{ id: number }>())!.id
/** The mark as stored: a number both halves of a marked pair share, null while the Transaction is not marked. */
const marker = async (uniqueId: string) => (await env.DB.prepare('SELECT not_transfer_with AS marker FROM transactions WHERE bank_unique_id = ?').bind(uniqueId).first<{ marker: number | null }>())!.marker

type Detail = {
  id: number
  transfer: 'pair' | 'rule' | null
  notTransfer: boolean
  canMarkNotTransfer: boolean
  transferAccountName: string | null
  transferTransactionId: number | null
  categoryName: string | null
}
const detail = async (uniqueId: string, who: Who = 'admin') => (await (await call(`/api/transactions/${await idOf(uniqueId)}`, { who })).json()) as Detail

const notTransfer = async (uniqueId: string, who: Who = 'admin') => call(`/api/transactions/${await idOf(uniqueId)}/not-transfer`, { who, method: 'POST', body: {} })
const treatAsTransferAgain = async (uniqueId: string, who: Who = 'admin') => call(`/api/transactions/${await idOf(uniqueId)}/not-transfer`, { who, method: 'DELETE', body: {} })

const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id
const transferRule = async (textContains: string) => expect((await call('/api/rules', { method: 'POST', body: { textContains, transfer: true } })).status).toBe(201)
const override = async (uniqueId: string, categoryId: number) => expect((await call(`/api/transactions/${await idOf(uniqueId)}/override`, { method: 'PUT', body: { categoryId } })).status).toBe(200)

type LogEntry = { type: string | null; summary: string; before: string | null; after: string | null; actor: string }
const log = async (query: string) => ((await (await call(`/api/change-log${query}`, { who: 'member' })).json()) as { entries: LogEntry[] }).entries
const transferLog = () => log('?type=transfer')

/** A wrongly paired $50.00 out of Everyday and in to Savings, the same day. */
async function wrongPair() {
  await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT')])
  await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])
  expect(await pairs()).toEqual([['OUT', 'IN']])
}

beforeEach(async () => {
  serial = 0
  await env.DB.batch(['balance_checks', 'carry_over', 'transactions', 'rules', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
})

describe('marking a pairing as Not a Transfer', () => {
  it('stops both halves being a Transfer in one step, and each shows its own Category', async () => {
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
    expect(await described('&uncategorised=true')).toEqual([])

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

  it('gives both halves the same mark, so that treating it as a Transfer again finds both', async () => {
    await wrongPair()

    await notTransfer('OUT')

    expect(await marker('OUT')).not.toBeNull()
    expect(await marker('IN')).toBe(await marker('OUT'))
  })

  it('tells the details and the list who can be marked: a Transfer can, and a marked or ordinary Transaction cannot', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT'), row(DAY, -2000, 'EXAMPLE CAFE', 'CAFE')])
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])
    expect(await detail('OUT')).toMatchObject({ notTransfer: false, canMarkNotTransfer: true, transfer: 'pair' })
    expect(await detail('CAFE')).toMatchObject({ notTransfer: false, canMarkNotTransfer: false })
    expect(await byDescription('EXAMPLE SHOP')).toMatchObject({ notTransfer: false, canMarkNotTransfer: true })

    await notTransfer('OUT')

    for (const uniqueId of ['OUT', 'IN']) {
      expect(await detail(uniqueId, 'member')).toMatchObject({ notTransfer: true, canMarkNotTransfer: false, transfer: null, transferAccountName: null, transferTransactionId: null })
    }
    expect(await byDescription('EXAMPLE REFUND')).toMatchObject({ notTransfer: true, canMarkNotTransfer: false })
  })

  it('is left out of the Transfers in the CSV file and the Report too, as in the list', async () => {
    await wrongPair()
    const dataLines = async (query: string) => ((await (await call(`/api/transactions/export.csv${query}`, { who: 'member' })).text()).match(/^\d{4}-\d{2}-\d{2},.*$/gm) ?? []).length
    const everyday = await accountIdOf('Everyday')
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

  it('writes one Change Log entry of type transfer that names both Transactions and both Accounts, in words', async () => {
    await wrongPair()

    await notTransfer('OUT')

    const entries = await transferLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'transfer', actor: 'admin@example.com' })
    expect(entries[0]!.summary).toBe(
      `Marked Transaction ${await idOf('OUT')} (${DAY}, EXAMPLE SHOP) in Everyday and its matching Transaction ${await idOf('IN')} (${DAY}, EXAMPLE REFUND) in Savings as Not a Transfer`,
    )
    // The page shows these fields as they are, so they are words: no Transaction numbers, no flags of the database's.
    expect(JSON.parse(entries[0]!.before!)).toEqual({ transfer: 'Transfer between Everyday and Savings' })
    expect(JSON.parse(entries[0]!.after!)).toEqual({ transfer: 'Not a Transfer' })
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

  it('says 404 for a Transaction that does not exist', async () => {
    for (const method of ['POST', 'DELETE']) {
      const res = await call('/api/transactions/999999/not-transfer', { method, body: {} })
      expect(res.status, method).toBe(404)
    }
    expect(await transferLog()).toEqual([])
  })

  it('reads the ID as the page does, so a number written another way is not the Transaction it would parse to', async () => {
    await wrongPair()
    const id = await idOf('OUT')

    // Each of these is the number of a Transaction that exists, to Number() (so '1e1' is Transaction 10), but is not an ID as written.
    for (const written of [`${id}.0`, `0${id}`, `+${id}`, `${id}e0`, `${id}%20`, `0x${id.toString(16)}`]) {
      for (const method of ['POST', 'DELETE']) {
        const res = await call(`/api/transactions/${written}/not-transfer`, { method, body: {} })
        expect(res.status, `${method} ${written}`).toBe(404)
      }
    }
    expect(await marker('OUT')).toBeNull()
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await transferLog()).toEqual([])
  })

  it('refuses a body that is not the empty object, naming the field, and changes nothing', async () => {
    await wrongPair()
    const id = await idOf('OUT')

    for (const body of [{ categoryId: 1 }, [], 'yes']) {
      for (const method of ['POST', 'DELETE']) {
        const res = await call(`/api/transactions/${id}/not-transfer`, { method, body })
        expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(400)
        expect(await res.json()).toEqual({ error: 'Invalid request', field: expect.any(String) })
      }
    }
    expect(await marker('OUT')).toBeNull()
    expect(await transferLog()).toEqual([])
  })

  it('writes no Change Log entry when the pairing moved on between reading it and writing, and says so', async () => {
    await wrongPair()

    // An Import replaced the matching Transaction's Account in that instant, which lets go of the pairing.
    const res = await callWhileInterrupted(`/api/transactions/${await idOf('OUT')}/not-transfer`, 'POST', () => env.DB.prepare('UPDATE transactions SET transfer_of = NULL').run())

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This Transaction has changed. Reload the page and try again' })
    expect(await marker('OUT')).toBeNull()
    expect(await transferLog()).toEqual([])
  })

  it('works on the half an Override already made spending, which is how a wrong pairing was put right before', async () => {
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

  it('works from the half an Override made spending, though the list already calls it spending', async () => {
    await wrongPair()
    await override('OUT', await categoryId('Gifts and donations'))
    expect(await byDescription('EXAMPLE SHOP')).toMatchObject({ transfer: null, canMarkNotTransfer: true })

    expect((await notTransfer('OUT')).status).toBe(200)

    expect(await pairs()).toEqual([])
    expect(await byDescription('EXAMPLE REFUND')).toMatchObject({ transfer: null })
    expect(await marker('IN')).toBe(await marker('OUT'))
  })
})

describe('a marked pairing is not made again', () => {
  it('when a later Import adds a Transaction that would have taken the first half of it', async () => {
    await wrongPair()
    await notTransfer('OUT')
    // Another $50.00 out and in. The marked $50.00 out is older, so without the mark it would be the one the new $50.00 in takes.
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
    expect(await byDescription('ROUND UP TO SAVINGS')).toMatchObject({ transfer: 'rule', canMarkNotTransfer: true })

    const res = await notTransfer('ROUND')

    expect(res.status).toBe(200)
    expect(await byDescription('ROUND UP TO SAVINGS')).toMatchObject({ transfer: null, categoryName: null })
    expect(await described('&transfers=only')).toEqual([])
    expect((await described('&transfers=exclude')).map((t) => t.description).sort()).toEqual(['EXAMPLE SHOP', 'ROUND UP TO SAVINGS'])
    expect((await described('&uncategorised=true')).map((t) => t.description).sort()).toEqual(['EXAMPLE SHOP', 'ROUND UP TO SAVINGS'])
    expect(await detail('ROUND')).toMatchObject({ notTransfer: true, transfer: null })
    expect(await marker('ROUND')).not.toBeNull()
    const entry = (await transferLog())[0]!
    expect(entry.summary).toBe(`Marked Transaction ${await idOf('ROUND')} (${DAY}, ROUND UP TO SAVINGS) in Everyday as Not a Transfer, so the Rule that marks it as a Transfer no longer applies to it`)
    expect(JSON.parse(entry.before!)).toEqual({ transfer: 'Marked by a Rule' })
  })

  it('still applies to a Transaction nobody marked, and to the new Transactions an Import adds', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP ONE', 'ROUND1')])
    await notTransfer('ROUND1')

    await importInto(EVERYDAY, [row(DAY, -60, 'ROUND UP TWO', 'ROUND2')])

    expect(await byDescription('ROUND UP ONE')).toMatchObject({ transfer: null })
    expect(await byDescription('ROUND UP TWO')).toMatchObject({ transfer: 'rule' })
  })

  it("does not make a paired half a Transfer when the Rule marks it too, since the mark outranks the Rule's flag", async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    await importInto(SAVINGS, [row(DAY, 50, 'CREDIT', 'CREDIT')])
    expect(await pairs()).toEqual([['ROUND', 'CREDIT']])

    await notTransfer('ROUND')

    // Letting go of the pairing alone would leave 'ROUND' a Transfer because of the Rule; the mark is what stops that.
    expect((await described()).map((t) => t.transfer)).toEqual([null, null])
    expect(await detail('ROUND')).toMatchObject({ transfer: null, notTransfer: true })
  })

  it('does not bring it back when the Rules are applied to every Transaction again, which writes the Rule\'s result and nothing else', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await transferRule('EXAMPLE SHOP')

    expect((await call('/api/rules/rerun', { method: 'POST', body: {} })).status).toBe(201)
    for (let i = 0; i < 20; i++) {
      const { job } = (await (await call('/api/rules/rerun/step', { method: 'POST', body: {} })).json()) as { job: { status: string } }
      if (job.status === 'done') break
    }

    // The Rule now flags the Transaction, as stored, and the mark still outranks it.
    expect(await env.DB.prepare('SELECT rule_transfer FROM transactions WHERE bank_unique_id = ?').bind('OUT').first()).toEqual({ rule_transfer: 1 })
    expect(await detail('OUT')).toMatchObject({ notTransfer: true, transfer: null })
    expect(await marker('OUT')).toBe(await marker('IN'))
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
  it('takes the mark off both halves, and pairs them again', async () => {
    await wrongPair()
    await notTransfer('OUT')

    const res = await treatAsTransferAgain('OUT')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: true })
    expect(await marker('OUT')).toBeNull()
    expect(await marker('IN')).toBeNull()
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect((await described()).map((t) => t.transfer)).toEqual(['pair', 'pair'])
    expect(await byDescription('EXAMPLE SHOP')).toMatchObject({ transferAccountName: 'Savings' })
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

  it('writes a Change Log entry of type transfer that says what came off, not that it is a Transfer again', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await treatAsTransferAgain('IN')

    const entries = await transferLog()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'transfer', actor: 'admin@example.com' })
    expect(entries[0]!.summary).toBe(`Took Not a Transfer off Transaction ${await idOf('IN')} (${DAY}, EXAMPLE REFUND) in Savings and Transaction ${await idOf('OUT')} (${DAY}, EXAMPLE SHOP) in Everyday`)
    expect(JSON.parse(entries[0]!.before!)).toEqual({ transfer: 'Not a Transfer' })
    expect(JSON.parse(entries[0]!.after!)).toEqual({ transfer: 'Can be a Transfer again' })
  })

  it('does nothing and logs nothing for a Transaction that is not marked', async () => {
    await wrongPair()

    const res = await treatAsTransferAgain('OUT')

    // It was a Transfer all along, and says so.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: true })
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await transferLog()).toEqual([])
  })

  it('writes one entry, not two, when another request has just done the same', async () => {
    await wrongPair()
    await notTransfer('OUT')

    // A second window treats it as a Transfer again in the instant between this request reading the marks and writing.
    const res = await callWhileInterrupted(`/api/transactions/${await idOf('OUT')}/not-transfer`, 'DELETE', () => treatAsTransferAgain('IN'))

    // The other window paired them, so that is what this one reports.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: true })
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await marker('OUT')).toBeNull()
    // The mark, and the one undo that did something.
    expect(await transferLog()).toHaveLength(2)
  })

  it('says it is not paired when the other window found nothing to pair it with', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    await notTransfer('ROUND')

    const res = await callWhileInterrupted(`/api/transactions/${await idOf('ROUND')}/not-transfer`, 'DELETE', () => treatAsTransferAgain('ROUND'))

    expect(await res.json()).toEqual({ id: await idOf('ROUND'), notTransfer: false, paired: false })
  })

  it('takes its own mark off when its matching Transaction was replaced by one the file does not hold, and pairs with what matches now', async () => {
    await wrongPair()
    await notTransfer('OUT')
    // The Savings history is replaced by a file without the $50.00 in the Admin looked at, which has a different one that matches instead.
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN-NEW')], { replace: true })
    expect(await pairs()).toEqual([])

    const res = await treatAsTransferAgain('OUT')

    expect(res.status).toBe(200)
    expect(await marker('OUT')).toBeNull()
    expect(await res.json()).toMatchObject({ paired: true })
    expect(await pairs()).toEqual([['OUT', 'IN-NEW']])
  })

  it('takes its own mark off and pairs with nothing when its matching Transaction has gone and nothing else matches', async () => {
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
    expect(await marker('FEE')).toBe(await marker('DEPOSIT'))
    expect(await marker('FEE')).not.toBe(await marker('IN'))
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

describe('replacing imported history keeps the Admin\'s Not a Transfer, as it does their Overrides and Notes', () => {
  const REPLACE = (account: Account, rows: unknown[]) => importInto(account, rows, { replace: true })
  const lastImport = async () => (await log('?type=import'))[0]!

  it('gives the mark to the Transaction that comes back when one side is replaced, so the wrong pair does not return', async () => {
    await wrongPair()
    await notTransfer('OUT')
    const mark = await marker('OUT')

    await REPLACE(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])

    expect(await pairs()).toEqual([])
    expect((await described()).map((t) => t.transfer)).toEqual([null, null])
    // The Transaction that came back is a new row, marked together with the half that stayed.
    expect(await marker('IN')).toBe(mark)
    expect(await detail('IN')).toMatchObject({ notTransfer: true, canMarkNotTransfer: false })
  })

  it('does the same from the other side', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await REPLACE(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT')])

    expect(await pairs()).toEqual([])
    expect(await marker('OUT')).not.toBeNull()
    expect(await marker('OUT')).toBe(await marker('IN'))
  })

  it('keeps both halves marked together when both sides are replaced, one after the other, and treating them as a Transfer again clears both', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await REPLACE(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])
    await REPLACE(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT')])

    expect(await pairs()).toEqual([])
    expect(await marker('OUT')).not.toBeNull()
    expect(await marker('OUT')).toBe(await marker('IN'))

    // Either of the new Transactions finds the other, though neither is the Transaction that was first marked.
    expect((await treatAsTransferAgain('IN')).status).toBe(200)
    expect(await marker('OUT')).toBeNull()
    expect(await marker('IN')).toBeNull()
    expect(await pairs()).toEqual([['IN', 'OUT']])
  })

  it('keeps a Transaction marked alone, where a Rule marked it and nothing was paired with it, marked alone', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND'), row(DAY, -1200, 'EXAMPLE SHOP', 'SHOP')])
    await notTransfer('ROUND')

    await REPLACE(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND'), row(DAY, -1200, 'EXAMPLE SHOP', 'SHOP')])

    // The Rules ran on the new Transaction and flagged it again, and the mark it was given still outranks that.
    expect(await detail('ROUND')).toMatchObject({ notTransfer: true, transfer: null })
    expect(await detail('SHOP')).toMatchObject({ notTransfer: false })
    expect(await marker('SHOP')).toBeNull()
    expect((await treatAsTransferAgain('ROUND')).status).toBe(200)
    expect(await byDescription('ROUND UP TO SAVINGS')).toMatchObject({ transfer: 'rule' })
  })

  it('gives the mark before the new rows are paired, so a Transaction that comes back marked is never paired in that Import', async () => {
    await wrongPair()
    await notTransfer('OUT')
    // The Everyday Import brings back the marked $50.00 out, and Savings holds an unmarked $50.00 in that it would pair with.
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE TOP-UP', 'TOP-UP')])
    expect(await pairs()).toEqual([])

    const imported = await importInto(EVERYDAY, [row(DAY, -5000, 'EXAMPLE SHOP', 'OUT')], { replace: true })

    expect(imported.paired).toBe(0)
    expect(await pairs()).toEqual([])
  })

  /** A replace of Savings that stops after its first part: the marked $50.00 in is removed and its mark held, and nothing of the file that holds it again is saved yet. */
  async function replaceStoppedAfterFirstPart() {
    const first = await sendChunk(SAVINGS, [row('2026-10-06', 1, 'EXAMPLE OTHER', 'ELSEWHERE')], { replace: true, index: 0, count: 2 })
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200)
    expect(await heldMarks()).toBe(1)
  }

  it('takes the mark off the half that is held too when the Admin treats the other half as a Transfer again, so the half that comes back is not marked', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await replaceStoppedAfterFirstPart()

    const res = await treatAsTransferAgain('OUT')

    // Nothing is there to pair with yet, and it says so, though it did take a mark off (the held one).
    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: false })
    expect(await heldMarks()).toBe(0)
    // The rest of the file is imported: the $50.00 in comes back as it was before the Admin said anything, and pairs with the $50.00 out again.
    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])
    expect(await marker('IN')).toBeNull()
    expect(await marker('OUT')).toBeNull()
    expect(await pairs()).toEqual([['OUT', 'IN']])
  })

  it('says it paired the half that stayed with a match from another Account, while it takes the mark off the half that is held', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await importInto(BILLS, [row(DAY, 5000, 'EXAMPLE DEPOSIT', 'DEPOSIT')])
    expect(await pairs()).toEqual([])
    await replaceStoppedAfterFirstPart()

    const res = await treatAsTransferAgain('OUT')

    expect(await res.json()).toEqual({ id: await idOf('OUT'), notTransfer: false, paired: true })
    expect(await pairs()).toEqual([['OUT', 'DEPOSIT']])
    expect(await heldMarks()).toBe(0)
  })

  it('does not give a mark made later the number of a half that is still held', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await replaceStoppedAfterFirstPart()
    expect(await (await treatAsTransferAgain('OUT')).json()).toMatchObject({ paired: false })
    // The $50.00 out finds another match in Bills, and the Admin says that one is wrong too. A new mark takes the lower ID of its two, here the $50.00 out's:
    // the number the held half was marked with.
    await importInto(BILLS, [row(DAY, 5000, 'EXAMPLE DEPOSIT', 'DEPOSIT')])
    expect(await pairs()).toEqual([['OUT', 'DEPOSIT']])
    await notTransfer('OUT')

    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])

    expect(await marker('IN')).toBeNull()
    expect(await marker('OUT')).not.toBeNull()
    expect(await marker('OUT')).toBe(await marker('DEPOSIT'))
    expect(await pairs()).toEqual([])
  })

  it('does not count a held mark as given to a Transaction that is paired already, and leaves it waiting', async () => {
    await wrongPair()
    await notTransfer('OUT')
    await replaceStoppedAfterFirstPart()
    // A Savings Transaction with the bank number of the held one turns up paired with another $50.00 out (made by hand: an Import would have given it the mark).
    const everyday = await accountIdOf('Everyday')
    const savings = await accountIdOf('Savings')
    const insert = env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) VALUES (?, ?, ?, 'EXAMPLE', 'import', ?) RETURNING id")
    const out2 = (await insert.bind(everyday, DAY, -5000, 'OUT2').first<{ id: number }>())!.id
    const in2 = (await insert.bind(savings, DAY, 5000, 'IN').first<{ id: number }>())!.id
    await env.DB.batch([env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(in2, out2), env.DB.prepare('UPDATE transactions SET transfer_of = ? WHERE id = ?').bind(out2, in2)])

    const imported = await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])

    expect(imported).toMatchObject({ carried: 0, stillWaiting: 1 })
    expect(await marker('IN')).toBeNull()
    expect(await pairs()).toEqual([['OUT2', 'IN']])
    expect((await lastImport()).summary).toContain('Overrides, Notes and Not a Transfer marks carried over for 0 Transactions, 1 still waiting')
    expect(await heldMarks()).toBe(1)
    expect(await (await call(`/api/imports/imported/${savings}`)).json()).toMatchObject({ carryOverWaiting: 1 })
  })

  it('says in the Change Log that the mark was carried over, with the Overrides and Notes', async () => {
    await wrongPair()
    await notTransfer('OUT')

    await REPLACE(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])

    expect((await lastImport()).summary).toContain('Overrides, Notes and Not a Transfer marks carried over for 1 Transaction, none lost')
  })

  it('drops the mark when no Transaction with the same bank number comes back, and says so in the Change Log and on the finished screen', async () => {
    await wrongPair()
    await notTransfer('OUT')

    const finished = await REPLACE(SAVINGS, [row('2026-10-06', 1, 'EXAMPLE OTHER', 'ELSEWHERE')])

    expect(finished.lostTransactions).toEqual([expect.objectContaining({ description: 'EXAMPLE REFUND', notTransfer: true })])
    const entry = await lastImport()
    expect(entry.summary).toContain('Overrides, Notes and Not a Transfer marks carried over for 0 Transactions, lost for 1 Transaction')
    expect(JSON.parse(entry.after!).lostTransactions).toEqual([expect.objectContaining({ description: 'EXAMPLE REFUND', notTransfer: true })])
    // The half that stayed is still marked, and the new Transaction is not.
    expect(await marker('OUT')).not.toBeNull()
    expect(await marker('ELSEWHERE')).toBeNull()
  })

  it('forecasts how many marks a replace would carry and lose, before the Admin confirms', async () => {
    await wrongPair()
    await notTransfer('OUT')
    const savings = await accountIdOf('Savings')
    const forecast = async (uniqueId: string) => (await call('/api/imports/carry-preview', { method: 'POST', body: { accountId: savings, rows: [{ uniqueId, amountCents: 5000 }] } })).json()

    expect(await forecast('IN')).toEqual({ waiting: 1, carries: 1, differing: 0 })
    expect(await forecast('ELSEWHERE')).toEqual({ waiting: 1, carries: 0, differing: 0 })
  })

  it('counts a marked Transaction among those a replace will carry over, and an unmarked pair among those it lets go of', async () => {
    await wrongPair()
    const savings = await accountIdOf('Savings')
    const counts = async () => (await (await call(`/api/imports/imported/${savings}`)).json()) as Record<string, number>
    expect(await counts()).toMatchObject({ imported: 1, withOwnWork: 0, paired: 1 })

    await notTransfer('OUT')

    expect(await counts()).toMatchObject({ imported: 1, withOwnWork: 1, paired: 0 })
  })

  it('gives the mark of a replace that stopped part way to the Import that finishes it', async () => {
    await wrongPair()
    await notTransfer('OUT')
    const savings = await accountIdOf('Savings')
    // Clearing the history in steps removes the Transactions and holds their marks; here the rows go and the hold is made by hand.
    await env.DB.prepare('DELETE FROM carry_over').run()
    await env.DB.prepare(HOLD_REMOVED).bind(savings, 5000).run()
    await env.DB.prepare('DELETE FROM transactions WHERE account_id = ?').bind(savings).run()

    await importInto(SAVINGS, [row(DAY, 5000, 'EXAMPLE REFUND', 'IN')])

    expect(await marker('IN')).toBe(await marker('OUT'))
    expect(await pairs()).toEqual([])
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

  it('lets a Member see that a Transaction is marked, and which of its Transfers are not', async () => {
    await wrongPair()
    await notTransfer('OUT')

    expect((await detail('IN', 'member')).notTransfer).toBe(true)
    expect((await list('&transfers=only', 'member')).total).toBe(0)
  })
})

describe('what marking, undoing and carrying read and write (ADR 0004: free plan limits)', () => {
  const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail)
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
    await Promise.all([seedHistory(await accountIdOf('Everyday'), 3000), seedHistory(await accountIdOf('Savings'), 3000)])
    const out = await idOf('OUT')
    const inn = await idOf('IN')

    const mark = (await markNotTransferStatement(env.DB, { id: out, matchingId: inn }).run()).meta
    const token = (await marker('OUT'))!
    const repair = (await pairOneStatement(env.DB, { id: out, prefer: inn, token }).run()).meta
    const repairOther = (await pairOneStatement(env.DB, { id: inn, prefer: out, token }).run()).meta
    const clear = (await clearNotTransferStatement(env.DB, { token }).run()).meta

    // Each half is written with its entry in the Transfer index (which loses it) and the one for the mark (which gains it).
    expect(mark.changes).toBe(2)
    expect(mark.rows_read).toBeLessThanOrEqual(8)
    expect(mark.rows_written).toBeLessThanOrEqual(6)
    // Looking for a match reads the Transactions of that one day, not the 6,000 of other days.
    expect(repair.changes).toBe(2)
    expect(repair.rows_read).toBeLessThanOrEqual(30)
    expect(repair.rows_written).toBeLessThanOrEqual(4)
    // The other half finds itself paired already.
    expect(repairOther.changes).toBe(0)
    expect(repairOther.rows_written).toBe(0)
    expect(repairOther.rows_read).toBeLessThanOrEqual(10)
    // The mark is found by its index, not by reading the Transactions.
    expect(clear.changes).toBe(2)
    expect(clear.rows_read).toBeLessThanOrEqual(8)
    expect(clear.rows_written).toBeLessThanOrEqual(6)
  })

  it('finds a match through the date index, and the marked pair through the mark index, never by scanning the Transactions', async () => {
    const reads = (await plan(PAIR_ONE, 1, 2, 3)).filter((detail) => /^(SCAN|SEARCH) (a|o|transactions)\b/.test(detail))

    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toMatch(/USING (INTEGER PRIMARY KEY|INDEX transactions_date)/)
    const clear = (await plan('UPDATE transactions SET not_transfer_with = NULL WHERE not_transfer_with = ?1', 1)).join('\n')
    expect(clear).toMatch(/USING (COVERING )?INDEX transactions_not_transfer_with/)
  })

  // Holding writes the row and its key; giving writes the row and an entry in each index the Override and the mark are in; marking it given writes the row.
  // Clearing deletes the row and its key, which D1 bills as 2 (the local runtime reports a deleted row as 1). Removing the row it came from takes its entries out
  // of the Override index and the mark index, which the local runtime does not report either: they are there, and partial, so only a row that has one pays.
  const CLEARING = 2
  it.each([
    ['a Note alone', { override: false, note: true, mark: false }, 6],
    ['an Override alone', { override: true, note: false, mark: false }, 8],
    ['a mark alone', { override: false, note: false, mark: true }, 8],
    ['an Override, a Note and a mark: WRITES_PER_CARRIED', { override: true, note: true, mark: true }, WRITES_PER_CARRIED],
  ])('carrying %s costs the writes the figures say', async (_name, has, expected) => {
    await wrongPair()
    const savings = await accountIdOf('Savings')
    const id = (
      await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) VALUES (?, '2026-09-01', -100, 'EXAMPLE', 'import', 'X') RETURNING id").bind(savings).first<{ id: number }>()
    )!.id
    await env.DB.prepare('UPDATE transactions SET override_category = ?, note = ?, not_transfer_with = ? WHERE id = ?')
      .bind(has.override ? await categoryId('Groceries') : null, has.note ? 'n' : null, has.mark ? id : null, id)
      .run()
    const rows = JSON.stringify([{ uniqueId: 'X' }])

    const hold = (await env.DB.prepare(HOLD_REMOVED).bind(savings, 5000).run()).meta
    await env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run()
    await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) VALUES (?, '2026-09-01', -100, 'EXAMPLE', 'import', 'X')").bind(savings).run()
    const give = (await env.DB.prepare(APPLY_HELD).bind(savings, rows).run()).meta
    const marked = (await env.DB.prepare(MARK_APPLIED).bind(savings, rows).run()).meta

    const removal = (has.override ? WRITES_PER_OVERRIDE_REMOVED : 0) + (has.mark ? WRITES_PER_MARK_REMOVED : 0)
    expect(hold.rows_written + give.rows_written + marked.rows_written + CLEARING + removal).toBe(expected)
  })

  it('has the two indexes a removed Override and a removed mark are taken out of, and no others a Note is in', async () => {
    const index = async (name: string) => (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").bind(name).first<{ sql: string }>())!.sql
    expect(await index('transactions_override_category')).toMatch(/WHERE override_category IS NOT NULL/)
    expect(await index('transactions_not_transfer_with')).toMatch(/WHERE not_transfer_with IS NOT NULL/)
    const onNote = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions' AND sql LIKE '%note%'").first<{ n: number }>())!.n
    expect(onNote).toBe(0)
  })

  it('takes the mark off what is held by reading the held rows, which are none except while a replace is unfinished', async () => {
    const none = (await clearHeldNotTransferStatement(env.DB, { token: 123 }).run()).meta
    const account = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-77', 'Held') RETURNING id").first<{ id: number }>())!.id
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO carry_over (account_id, bank_unique_id, note, not_transfer_with, date, amount_cents, description) SELECT ?, 'HELD' || i, 'n', i, '2026-09-01', -100, 'EXAMPLE' FROM n`,
    )
      .bind(account)
      .run()
    const held = (await clearHeldNotTransferStatement(env.DB, { token: 123 }).run()).meta

    expect(none.rows_read).toBeLessThanOrEqual(1)
    expect(held.rows_read).toBeLessThanOrEqual(310)
    expect(held.changes).toBe(1)
    expect(await heldMarks()).toBe(299)
  })

  it('costs a replace nothing more to hold a mark than to hold a Note, and nothing more to give it', async () => {
    await wrongPair()
    const everyday = await accountIdOf('Everyday')
    await seedHistory(everyday, 3000)
    const hold = async () => (await env.DB.prepare(HOLD_REMOVED).bind(everyday, 5000).run()).meta

    const none = await hold()
    await env.DB.prepare('DELETE FROM carry_over').run()
    await notTransfer('OUT')
    const marked = await hold()
    const give = (await env.DB.prepare(APPLY_HELD).bind(everyday, JSON.stringify([{ uniqueId: 'OUT' }])).run()).meta

    // Holding one more row writes it and its key, as for a Note, and reads nothing the unmarked slice did not.
    expect(none.changes).toBe(0)
    expect(marked.changes).toBe(1)
    expect(marked.rows_written - none.rows_written).toBeLessThanOrEqual(2)
    expect(marked.rows_read - none.rows_read).toBeLessThanOrEqual(10)
    // Giving it to the Transaction that came back is one row, the one it is written to, and its entry in the mark index when it is new.
    expect(give.changes).toBe(1)
    expect(give.rows_read).toBeLessThanOrEqual(60)
    expect(give.rows_written).toBeLessThanOrEqual(3)
  })
})
