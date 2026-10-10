import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { PAIR, UNPAIR_PARTNERS, pairTransfersStatement, unpairPartnersOfImportedStatement } from './transfers'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member
// (the dev identity cookie is honoured on localhost only). All the data is made up (bank 99).
// Transfers are paired inside the Import route, so every test imports files the way the Admin does.
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
const NEXT_DAY = '2026-10-06'

let serial = 0
/** A made-up row; each gets a bank unique ID of its own, so rows that look identical are still different rows. */
const row = (date: string, amountCents: number, payee = 'EXAMPLE TRANSFER', uniqueId = `U${++serial}`) => ({ date, uniqueId, tranType: 'TFR', chequeNumber: null, payee, bankMemo: '', amountCents })
/** `count` rows that are the same in everything the bank shows, apart from the unique ID. */
const repeat = (count: number, date: string, amountCents: number, payee = 'EXAMPLE TRANSFER') => Array.from({ length: count }, () => row(date, amountCents, payee))

type Extra = { index?: number; count?: number; replace?: boolean; ledger?: [string, number] }
const sendChunk = (account: Account, rows: unknown[], extra: Extra = {}) =>
  call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account,
      chunk: { index: extra.index ?? 0, count: extra.count ?? 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: extra.ledger?.[1] ?? 0, date: extra.ledger?.[0] ?? '2026-10-31' } },
      rows,
      ...(extra.replace ? { replace: true } : {}),
    },
  })
/** Imports a file (one chunk unless told) and expects it to be accepted. */
async function importInto(account: Account, rows: unknown[], extra: Extra = {}) {
  const res = await sendChunk(account, rows, extra)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}

type Listed = {
  id: number
  accountName: string
  date: string
  description: string
  amountCents: number
  categoryName: string | null
  transfer: 'pair' | 'rule' | null
  transferAccountName: string | null
}
const list = async (query = '', who: Who = 'admin') => ((await (await call(`/api/transactions?limit=200${query}`, { who })).json()) as { total: number | null; transactions: Listed[] })
const described = async (query = '') => (await list(query)).transactions

/** Which unique IDs are paired with which, each pair once, as `[lower row, higher row]` and sorted. Read from the database: the API names no row's partner by its bank ID. */
const pairs = async () =>
  (
    await env.DB.prepare('SELECT a.bank_unique_id AS a, b.bank_unique_id AS b FROM transactions a JOIN transactions b ON b.id = a.transfer_of WHERE a.id < b.id ORDER BY a.id').all<{ a: string; b: string }>()
  ).results.map((p) => [p.a, p.b])
const unpaired = async () => (await env.DB.prepare('SELECT bank_unique_id AS id FROM transactions WHERE transfer_of IS NULL ORDER BY id').all<{ id: string }>()).results.map((r) => r.id)
/** Every pointer is answered by the other half, in the other Account, for the opposite amount on the same day. The invariant that makes a pair a pair. */
async function expectWholePairs() {
  const broken = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions a
     WHERE a.transfer_of IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM transactions b WHERE b.id = a.transfer_of AND b.transfer_of = a.id AND b.account_id <> a.account_id AND b.date = a.date AND b.amount_cents = -a.amount_cents AND a.amount_cents <> 0)`,
  ).first<{ n: number }>()
  expect(broken!.n).toBe(0)
}

const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id
const transferRule = async (textContains: string) => {
  const res = await call('/api/rules', { method: 'POST', body: { textContains, transfer: true } })
  expect(res.status).toBe(201)
}
const idOf = async (uniqueId: string) => (await env.DB.prepare('SELECT id FROM transactions WHERE bank_unique_id = ?').bind(uniqueId).first<{ id: number }>())!.id
const override = async (uniqueId: string, categoryId: number | null) => {
  const res = await call(`/api/transactions/${await idOf(uniqueId)}/override`, { method: 'PUT', body: { categoryId } })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  serial = 0
  await env.DB.batch(['balance_checks', 'transactions', 'rules', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
})

describe('pairing Transactions as Transfers', () => {
  it('pairs money out of one Account with the same amount in to another on the same day, and says where it went and came from', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'TFR TO SAVINGS', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'TFR FROM EVERYDAY', 'IN')])

    expect(await described()).toEqual([
      expect.objectContaining({ accountName: 'Savings', amountCents: 5000, transfer: 'pair', transferAccountName: 'Everyday' }),
      expect.objectContaining({ accountName: 'Everyday', amountCents: -5000, transfer: 'pair', transferAccountName: 'Savings' }),
    ])
    expect(await pairs()).toEqual([['OUT', 'IN']])
    await expectWholePairs()
  })

  it('pairs them whichever Account is imported last, and when both halves arrive in one file each', async () => {
    await importInto(SAVINGS, [row(DAY, 5000, 'x', 'IN')])
    await importInto(EVERYDAY, [row(DAY, -5000, 'y', 'OUT')])
    expect(await pairs()).toEqual([['IN', 'OUT']])

    await importInto(BILLS, [row(NEXT_DAY, -700, 'a', 'B-OUT'), row(NEXT_DAY, 300, 'b', 'B-IN')])
    await importInto(EVERYDAY, [row(NEXT_DAY, 700, 'c', 'E-IN')])
    expect(await pairs()).toEqual([['IN', 'OUT'], ['B-OUT', 'E-IN']])
  })

  it('goes by date and amount, not by what the bank calls them', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'TFR TO SAVINGS', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'SOMETHING ELSE ENTIRELY', 'IN')])

    expect(await pairs()).toEqual([['OUT', 'IN']])
  })

  it.each([
    ['a different date', row(NEXT_DAY, 5000, 'x', 'IN')],
    ['a different amount', row(DAY, 5001, 'x', 'IN')],
    ['the same amount in the same direction', row(DAY, -5000, 'x', 'IN')],
  ])('does not pair with %s', async (_name, other) => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'x', 'OUT')])
    await importInto(SAVINGS, [other])

    expect(await pairs()).toEqual([])
    expect((await described()).map((t) => t.transfer)).toEqual([null, null])
  })

  it('never pairs two Transactions of the same Account, in one file or across files', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'x', 'OUT'), row(DAY, 5000, 'y', 'IN')])
    await importInto(EVERYDAY, [row(DAY, 5000, 'z', 'LATER-IN')])

    expect(await pairs()).toEqual([])
    expect((await described()).every((t) => t.transfer === null)).toBe(true)
  })

  it('never pairs a Transaction of no money with another', async () => {
    await importInto(EVERYDAY, [row(DAY, 0, 'x', 'ZERO-A')])
    await importInto(SAVINGS, [row(DAY, 0, 'y', 'ZERO-B')])

    expect(await pairs()).toEqual([])
  })

  it('leaves the pairs it has made alone when more is imported later', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'x', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'y', 'IN')])
    await importInto(BILLS, [row(DAY, 5000, 'z', 'EXTRA-IN')])

    // The extra $50.00 in has no spare $50.00 out to pair with.
    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(await unpaired()).toEqual(['EXTRA-IN'])
  })

  it('does not pair again when the same file is imported twice', async () => {
    const out = [row(DAY, -5000, 'x', 'OUT')]
    const inn = [row(DAY, 5000, 'y', 'IN')]
    await importInto(EVERYDAY, out)
    await importInto(SAVINGS, inn)
    await importInto(EVERYDAY, out)
    await importInto(SAVINGS, inn)

    expect(await pairs()).toEqual([['OUT', 'IN']])
    await expectWholePairs()
  })

  it('does not pair a Transaction dated on or after the Cutover Date, because an Import never keeps it', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'x', 'OUT')])
    const res = await call('/api/imports/chunks', {
      method: 'POST',
      body: {
        account: SAVINGS,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
        rows: [row(DAY, 5000, 'y', 'IN')],
        cutoverDate: DAY,
      },
    })
    expect(res.status).toBe(200)

    expect(await pairs()).toEqual([])
  })
})

describe('identical Transactions on the same day (round-ups and repeat payments)', () => {
  it('pairs three identical amounts out with three identical amounts in, one to one', async () => {
    await importInto(EVERYDAY, repeat(3, DAY, -5000))
    await importInto(SAVINGS, repeat(3, DAY, 5000))

    expect(await pairs()).toHaveLength(3)
    expect(await unpaired()).toEqual([])
    // One to one: no Transaction is in two pairs, and each answers the other.
    const partners = (await env.DB.prepare('SELECT transfer_of FROM transactions').all<{ transfer_of: number }>()).results.map((r) => r.transfer_of)
    expect(new Set(partners).size).toBe(6)
    await expectWholePairs()
  })

  it('pairs them the same way whichever side is imported first', async () => {
    await importInto(SAVINGS, repeat(3, DAY, 5000))
    await importInto(EVERYDAY, repeat(3, DAY, -5000))

    expect(await pairs()).toHaveLength(3)
    expect(await unpaired()).toEqual([])
    await expectWholePairs()
  })

  it('pairs two of three when only two come in, and leaves the third out as spending', async () => {
    await importInto(EVERYDAY, repeat(3, DAY, -5000))
    await importInto(SAVINGS, repeat(2, DAY, 5000))

    expect(await pairs()).toHaveLength(2)
    expect(await unpaired()).toHaveLength(1)
    const lone = (await described()).filter((t) => t.transfer === null)
    expect(lone).toEqual([expect.objectContaining({ accountName: 'Everyday', amountCents: -5000 })])
    await expectWholePairs()
  })

  it('pairs the one that was left out when its other half turns up in a later Import', async () => {
    await importInto(EVERYDAY, repeat(3, DAY, -5000))
    await importInto(SAVINGS, repeat(2, DAY, 5000))
    await importInto(SAVINGS, [row(DAY, 5000)])

    expect(await pairs()).toHaveLength(3)
    expect(await unpaired()).toEqual([])
    await expectWholePairs()
  })

  it('pairs repeats on one side with a single on the other only once', async () => {
    await importInto(EVERYDAY, repeat(1, DAY, -5000))
    await importInto(SAVINGS, repeat(4, DAY, 5000))

    expect(await pairs()).toHaveLength(1)
    expect(await unpaired()).toHaveLength(3)
  })

  it('pairs repeats separately for each amount and each day', async () => {
    await importInto(EVERYDAY, [...repeat(2, DAY, -5000), ...repeat(1, DAY, -2500), ...repeat(2, NEXT_DAY, -5000), row(DAY, -9999, 'x', 'LONE-OUT')])
    await importInto(SAVINGS, [...repeat(2, DAY, 2500), ...repeat(1, DAY, 5000), ...repeat(1, NEXT_DAY, 5000)])

    // $50.00 on the first day: 2 out, 1 in -> 1 pair. $25.00: 1 out, 2 in -> 1 pair. $50.00 on the second day: 2 out, 1 in -> 1 pair.
    expect(await pairs()).toHaveLength(3)
    const loose = (await described()).filter((t) => t.transfer === null)
    expect(loose.map((t) => [t.date, t.amountCents]).sort()).toEqual([
      [DAY, -9999],
      [DAY, -5000],
      [DAY, 2500],
      [NEXT_DAY, -5000],
    ].sort())
    await expectWholePairs()
  })

  it('pairs each with a different Account when the repeats are spread across several', async () => {
    await importInto(EVERYDAY, repeat(2, DAY, -5000))
    await importInto(SAVINGS, repeat(1, DAY, 5000))
    await importInto(BILLS, repeat(1, DAY, 5000))

    const found = await pairs()
    expect(found).toHaveLength(2)
    expect(new Set((await described()).filter((t) => t.amountCents > 0).map((t) => t.transferAccountName))).toEqual(new Set(['Everyday']))
    expect(new Set((await described()).filter((t) => t.amountCents < 0).map((t) => t.transferAccountName))).toEqual(new Set(['Savings', 'Bills']))
    await expectWholePairs()
  })

  it('pairs a repeat that is split across the chunks of a file, with the other half already imported', async () => {
    await importInto(SAVINGS, repeat(3, DAY, 5000))
    const out = repeat(3, DAY, -5000)
    await importInto(EVERYDAY, out.slice(0, 2), { index: 0, count: 2 })
    expect(await pairs()).toHaveLength(2)
    await importInto(EVERYDAY, out.slice(2), { index: 1, count: 2 })

    expect(await pairs()).toHaveLength(3)
    expect(await unpaired()).toEqual([])
    await expectWholePairs()
  })

  it('pairs a repeat that is split across the chunks of a file, with the other half imported between them', async () => {
    const out = repeat(3, DAY, -5000)
    await importInto(EVERYDAY, out.slice(0, 2), { index: 0, count: 2 })
    await importInto(SAVINGS, repeat(3, DAY, 5000))
    expect(await pairs()).toHaveLength(2)
    await importInto(EVERYDAY, out.slice(2), { index: 1, count: 2 })

    expect(await pairs()).toHaveLength(3)
    expect(await unpaired()).toEqual([])
    await expectWholePairs()
  })

  it('pairs both of two files that arrive in pieces, whichever piece comes first', async () => {
    const out = repeat(4, DAY, -1000)
    const inn = repeat(4, DAY, 1000)
    await importInto(EVERYDAY, out.slice(0, 1), { index: 0, count: 2 })
    await importInto(SAVINGS, inn.slice(0, 3), { index: 0, count: 2 })
    await importInto(EVERYDAY, out.slice(1), { index: 1, count: 2 })
    await importInto(SAVINGS, inn.slice(3), { index: 1, count: 2 })

    expect(await pairs()).toHaveLength(4)
    expect(await unpaired()).toEqual([])
    await expectWholePairs()
  })
})

describe('a Rule that marks Transfers, as a backstop', () => {
  it('makes a Transaction a Transfer even though it has no pair, so it is not spending', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND'), row(DAY, -1200, 'EXAMPLE SHOP', 'SHOP')])

    const rows = await described()
    expect(rows.find((t) => t.description === 'ROUND UP TO SAVINGS')).toMatchObject({ transfer: 'rule', transferAccountName: null })
    expect(rows.find((t) => t.description === 'EXAMPLE SHOP')).toMatchObject({ transfer: null })
    expect(await pairs()).toEqual([])
  })

  it('is a Transfer by pairing, not by the Rule, when it also finds its other half', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    await importInto(SAVINGS, [row(DAY, 50, 'CREDIT', 'CREDIT')])

    expect(await described()).toEqual([
      expect.objectContaining({ accountName: 'Savings', transfer: 'pair', transferAccountName: 'Everyday' }),
      expect.objectContaining({ accountName: 'Everyday', transfer: 'pair', transferAccountName: 'Savings' }),
    ])
  })

  it('does nothing without the Rule: the same Transaction is spending', async () => {
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])

    expect((await described())[0]).toMatchObject({ transfer: null })
  })

  it('does not apply once the Rule has been removed from the Transactions it has not been stored on', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND')])
    const rule = ((await (await call('/api/rules')).json()) as { id: number }[])[0]!
    await call(`/api/rules/${rule.id}`, { method: 'DELETE', body: {} })
    await importInto(EVERYDAY, [row(NEXT_DAY, -50, 'ROUND UP TO SAVINGS', 'ROUND2')])

    // The stored result stays as it was when it was stored (README: Rules); a new Transaction never gets it.
    const rows = await described()
    expect(rows.find((t) => t.date === DAY)).toMatchObject({ transfer: 'rule' })
    expect(rows.find((t) => t.date === NEXT_DAY)).toMatchObject({ transfer: null })
  })
})

describe('what is left out of spending', () => {
  /** Two paired halves, one marked by a Rule, and two that are spending: a payment to someone else's account and a purchase. */
  async function household() {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [
      row(DAY, -5000, 'TFR TO SAVINGS', 'OUT'),
      row(DAY, -50, 'ROUND UP', 'ROUND'),
      row(DAY, -12_000, 'PAYMENT TO A FRIEND', 'FRIEND'),
      row(DAY, -2000, 'EXAMPLE SHOP', 'SHOP'),
    ])
    await importInto(SAVINGS, [row(DAY, 5000, 'TFR FROM EVERYDAY', 'IN')])
  }

  it('keeps Transfers out of the Uncategorised list, and keeps payments to untracked accounts and purchases in it', async () => {
    await household()

    const uncategorised = await described('&uncategorised=true')

    expect(uncategorised.map((t) => t.description).sort()).toEqual(['EXAMPLE SHOP', 'PAYMENT TO A FRIEND'])
    expect((await list('&uncategorised=true&count=only')).total).toBe(2)
  })

  it('counts only spending when asked to leave Transfers out, and only Transfers when asked for them', async () => {
    await household()

    const spending = await list('&transfers=exclude')
    const transfers = await list('&transfers=only')

    expect(spending.transactions.map((t) => t.description).sort()).toEqual(['EXAMPLE SHOP', 'PAYMENT TO A FRIEND'])
    expect(spending.total).toBe(2)
    expect(transfers.transactions.map((t) => t.description).sort()).toEqual(['ROUND UP', 'TFR FROM EVERYDAY', 'TFR TO SAVINGS'])
    expect(transfers.total).toBe(3)
    expect((await list()).total).toBe(5)
  })

  it('shows a payment to an untracked account as spending: it has no pair, whatever its amount', async () => {
    await importInto(EVERYDAY, [row(DAY, -12_000, 'PAYMENT TO A FRIEND', 'FRIEND')])
    await importInto(SAVINGS, [row(DAY, 11_999, 'SOMETHING ELSE', 'NEAR-MISS')])

    expect(await described('&transfers=exclude')).toHaveLength(2)
    expect(await described('&transfers=only')).toEqual([])
  })

  it('keeps Transfers in the balances, because the money did move', async () => {
    // Everyday holds $1,000.00 at the end of 1 October; the Transfer on the 5th takes $50.00 out of it.
    await importInto(EVERYDAY, [row('2026-09-30', 100, 'x', 'OPENING')], { ledger: ['2026-10-01', 100_000] })
    await importInto(EVERYDAY, [row(DAY, -5000, 'TFR TO SAVINGS', 'OUT')], { ledger: ['2026-10-01', 100_000] })
    await importInto(SAVINGS, [row(DAY, 5000, 'TFR FROM EVERYDAY', 'IN')], { ledger: ['2026-10-01', 200_000] })

    const { accounts } = (await (await call('/api/balances')).json()) as { accounts: { accountName: string; balanceCents: number }[] }

    expect(await pairs()).toEqual([['OUT', 'IN']])
    expect(accounts.find((a) => a.accountName === 'Everyday')!.balanceCents).toBe(95_000)
    expect(accounts.find((a) => a.accountName === 'Savings')!.balanceCents).toBe(205_000)
  })

  it('refuses a transfers filter it does not know, naming the field', async () => {
    const res = await call('/api/transactions?transfers=maybe')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'transfers' })
  })
})

describe('an Override', () => {
  it('outranks a pairing on its own Transaction, which then counts as spending in its Category, while the other half stays a Transfer', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'TFR TO SAVINGS', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'TFR FROM EVERYDAY', 'IN')])
    await override('OUT', await categoryId('Gifts and donations'))

    const rows = await described()
    expect(rows.find((t) => t.amountCents < 0)).toMatchObject({ transfer: null, categoryName: 'Gifts and donations', transferAccountName: 'Savings' })
    expect(rows.find((t) => t.amountCents > 0)).toMatchObject({ transfer: 'pair', transferAccountName: 'Everyday' })
    expect((await described('&transfers=exclude')).map((t) => t.amountCents)).toEqual([-5000])
  })

  it('outranks a Rule that marks Transfers', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP', 'ROUND')])
    await override('ROUND', await categoryId('Gifts and donations'))

    expect((await described())[0]).toMatchObject({ transfer: null, categoryName: 'Gifts and donations' })
  })

  it('is a Transfer again once the Override is taken off', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP', 'ROUND')])
    await override('ROUND', await categoryId('Gifts and donations'))
    await override('ROUND', null)

    expect((await described())[0]).toMatchObject({ transfer: 'rule' })
  })

  it('does not count once its Category is removed, so the Transfer stands', async () => {
    const created = await call('/api/categories', { method: 'POST', body: { name: 'Example Override' } })
    const { id } = (await created.json()) as { id: number }
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP', 'ROUND')])
    await override('ROUND', id)
    expect((await described())[0]).toMatchObject({ transfer: null })

    expect((await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })).status).toBe(200)

    expect((await described())[0]).toMatchObject({ transfer: 'rule' })
  })

  it('keeps a Transfer out of the Uncategorised list only while it has no Category of its own', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])
    expect(await described('&uncategorised=true')).toEqual([])

    await override('OUT', await categoryId('Gifts and donations'))

    // It has a Category now, so it is not Uncategorised either; the other half is still a Transfer.
    expect(await described('&uncategorised=true')).toEqual([])
    expect(await described('&categoryId=' + (await categoryId('Gifts and donations')))).toHaveLength(1)
  })
})

describe("a Transaction's details", () => {
  it('say what it is paired with, and which Account the money went to or came from', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'TFR TO SAVINGS', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'TFR FROM EVERYDAY', 'IN')])

    const out = (await (await call(`/api/transactions/${await idOf('OUT')}`, { who: 'member' })).json()) as Record<string, unknown>

    expect(out).toMatchObject({ transfer: 'pair', transferAccountName: 'Savings', transferTransactionId: await idOf('IN') })
  })

  it('say a Rule marked it when nothing paired with it, and give no other Transaction', async () => {
    await transferRule('ROUND UP')
    await importInto(EVERYDAY, [row(DAY, -50, 'ROUND UP', 'ROUND')])

    const t = (await (await call(`/api/transactions/${await idOf('ROUND')}`)).json()) as Record<string, unknown>

    expect(t).toMatchObject({ transfer: 'rule', transferAccountName: null, transferTransactionId: null })
  })

  it('say nothing of Transfers for a purchase', async () => {
    await importInto(EVERYDAY, [row(DAY, -2000, 'EXAMPLE SHOP', 'SHOP')])

    const t = (await (await call(`/api/transactions/${await idOf('SHOP')}`)).json()) as Record<string, unknown>

    expect(t).toMatchObject({ transfer: null, transferAccountName: null, transferTransactionId: null })
  })

  it('still say where the other half is when an Override makes this one spending', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])
    await override('OUT', await categoryId('Gifts and donations'))

    const t = (await (await call(`/api/transactions/${await idOf('OUT')}`)).json()) as Record<string, unknown>

    expect(t).toMatchObject({ transfer: null, transferAccountName: 'Savings', transferTransactionId: await idOf('IN') })
  })
})

describe('replacing imported history', () => {
  const REPLACE = (rows: unknown[]) => sendChunk(EVERYDAY, rows, { replace: true })

  it('takes the Transfer status from the other half when its partner goes, and gives it back when the replacement has a match', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])

    // The new file has nothing to match the $50.00 in.
    expect((await REPLACE([row(NEXT_DAY, -100, 'x', 'ELSEWHERE')])).status).toBe(200)

    expect(await unpaired()).toEqual(['ELSEWHERE', 'IN'])
    expect((await described()).every((t) => t.transfer === null)).toBe(true)

    // A later replacement that does have its match pairs with it again.
    expect((await REPLACE([row(DAY, -5000, 'OUT AGAIN', 'OUT2')])).status).toBe(200)

    expect(await pairs()).toEqual([['IN', 'OUT2']])
    await expectWholePairs()
  })

  it('pairs the new rows with the other half in the same Import that removes the old ones', async () => {
    await importInto(EVERYDAY, repeat(2, DAY, -5000))
    await importInto(SAVINGS, repeat(2, DAY, 5000))

    expect((await REPLACE(repeat(2, DAY, -5000))).status).toBe(200)

    expect(await pairs()).toHaveLength(2)
    expect(await unpaired()).toEqual([])
    await expectWholePairs()
  })

  it('leaves the pairs of other Accounts alone', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])
    await importInto(BILLS, [row(DAY, -300, 'B-OUT', 'B-OUT')])
    await importInto(SAVINGS, [row(DAY, 300, 'B-IN', 'B-IN')])

    expect((await REPLACE([row(NEXT_DAY, -1, 'x', 'ELSEWHERE')])).status).toBe(200)

    expect(await pairs()).toEqual([['B-OUT', 'B-IN']])
    await expectWholePairs()
  })

  it('also lets go of the other halves when a large history is cleared in steps', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])
    const everyday = (await env.DB.prepare('SELECT id FROM accounts WHERE name = ?').bind('Everyday').first<{ id: number }>())!.id
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5200)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) SELECT ?1, '2020-01-01', -100, 'EXAMPLE', 'import', 'SEED' || i FROM n`,
    )
      .bind(everyday)
      .run()

    const res = await call('/api/imports/clear-history', { method: 'POST', body: { accountId: everyday } })

    expect(res.status).toBe(200)
    // The $50.00 out was the oldest row, so it went in the first 5,000.
    expect(await idOf('IN')).toBeGreaterThan(0)
    expect((await described()).find((t) => t.description === 'IN')).toMatchObject({ transfer: null, transferAccountName: null })
    await expectWholePairs()
  })
})

describe('who can see Transfers', () => {
  it('lets a Member see them, and gives a Member no way to change a pairing', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])

    expect((await list('', 'member')).transactions.map((t) => t.transfer)).toEqual(['pair', 'pair'])
    expect((await sendMemberImport()).status).toBe(403)
    expect(await pairs()).toEqual([['OUT', 'IN']])
  })

  const sendMemberImport = () =>
    call('/api/imports/chunks', {
      who: 'member',
      method: 'POST',
      body: {
        account: BILLS,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
        rows: [row(DAY, 5000, 'x', 'SNEAKY')],
      },
    })
})

describe('the pairing statement', () => {
  it("pairs only the Account's unpaired rows, even when the ID range it is given also covers rows that are already paired", async () => {
    await importInto(EVERYDAY, repeat(2, DAY, -5000))
    await importInto(SAVINGS, repeat(1, DAY, 5000))
    // Another 50 dollars in, that has not been through an Import's pairing. The first 50 dollars out is already paired with the first 50 dollars in.
    const savings = (await env.DB.prepare('SELECT id FROM accounts WHERE name = ?').bind('Savings').first<{ id: number }>())!.id
    await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) VALUES (?, ?, 5000, 'EXAMPLE', 'import', 'LATE-IN')").bind(savings, DAY).run()

    await pairTransfersStatement(env.DB, { accountNumber: EVERYDAY.number, afterId: 0 }).run()

    // The second one out takes the new one in. The pair that was made is not touched.
    expect(await pairs()).toEqual([['U1', 'U3'], ['U2', 'LATE-IN']])
    await expectWholePairs()
  })
})

describe('what pairing reads and writes (ADR 0004: free plan limits)', () => {
  const CHUNK = 500
  const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail)

  /** `count` made-up Transactions of the Account spread over 700 dates from the first of January 2020: old history that a new chunk must not have to read. */
  const seedHistory = (accountId: number, count: number) =>
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) SELECT ?1, date('2020-01-01', '+' || (i % 700) || ' days'), -1000, 'EXAMPLE', 'import', 'OLD' || i FROM n`,
    )
      .bind(accountId, count)
      .run()
  const accountId = async (name: string) => (await env.DB.prepare('SELECT id FROM accounts WHERE name = ?').bind(name).first<{ id: number }>())!.id
  const lastId = async () => (await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM transactions').first<{ id: number }>())!.id

  /** The reads of pairing a chunk of CHUNK rows of Everyday, all on one day, when both Accounts already hold `older` rows on other days. */
  async function pairingReads(older: number) {
    await env.DB.batch(['transactions', 'accounts'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
    await importInto(EVERYDAY, [row('2026-09-01', -1, 'x', 'FIRST')])
    await importInto(SAVINGS, [row('2026-09-01', 1, 'x', 'SECOND')])
    // Old history in the chunk's own Account too, which the ID range keeps out of the chunk's rows.
    if (older > 0) await Promise.all([seedHistory(await accountId('Savings'), older), seedHistory(await accountId('Everyday'), older)])
    const afterId = await lastId()
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) SELECT ?1, '2026-10-05', -1000, 'EXAMPLE', 'import', 'NEW' || i FROM n`,
    )
      .bind(await accountId('Everyday'), CHUNK)
      .run()
    const { meta } = await pairTransfersStatement(env.DB, { accountNumber: EVERYDAY.number, afterId }).run()
    return meta
  }

  it("reads the chunk's own rows and the other Accounts' rows on the chunk's dates, never their history on other days", async () => {
    const fresh = await pairingReads(0)
    const old = await pairingReads(6000)

    // Reading 6,000 older rows would add thousands of reads to every chunk.
    expect(old.rows_read).toBeLessThanOrEqual(fresh.rows_read + 100)
    // The chunk's rows are read a handful of times each (scanned, numbered, looked up for the join), not once per row of the history.
    expect(fresh.rows_read).toBeLessThanOrEqual(CHUNK * 8)
    // Nothing to pair with, so nothing is written.
    expect(old.rows_written).toBe(0)
  })

  it('reads the other Accounts on the date index, and the chunk as an ID range', async () => {
    const reads = (await plan(PAIR, 0, EVERYDAY.number)).filter((detail) => /^(SCAN|SEARCH) (t|transactions)\b/.test(detail))

    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toMatch(/USING (INTEGER PRIMARY KEY|INDEX transactions_date)/)
  })

  it('writes only the pairs it makes, and nothing for a chunk that makes none', async () => {
    await importInto(EVERYDAY, [row(DAY, -5000, 'OUT', 'OUT')])
    await importInto(SAVINGS, [row(DAY, 5000, 'IN', 'IN')])
    await env.DB.prepare('UPDATE transactions SET transfer_of = NULL').run()

    const { meta } = await pairTransfersStatement(env.DB, { accountNumber: SAVINGS.number, afterId: 0 }).run()
    const again = await pairTransfersStatement(env.DB, { accountNumber: SAVINGS.number, afterId: 0 }).run()

    // Each half is written once, with its entry in the Transfer index. The second run finds both paired already.
    expect(meta.changes).toBe(2)
    expect(meta.rows_written).toBeLessThanOrEqual(4)
    expect(again.meta.changes).toBe(0)
    expect(again.meta.rows_written).toBe(0)
  })

  it('lets go of partners by the Transfer index, not by reading every Transaction', async () => {
    const reads = (await plan(UNPAIR_PARTNERS, 1, 5000)).filter((detail) => /^(SCAN|SEARCH) transactions\b/.test(detail))

    expect(reads.join('\n')).toMatch(/USING (COVERING )?INDEX transactions_transfer_of/)
    expect(reads.some((detail) => detail.startsWith('SCAN transactions') && !/INDEX/.test(detail))).toBe(false)
  })

  it('releases only the other halves of the rows being removed, not the rows themselves', async () => {
    await importInto(EVERYDAY, repeat(3, DAY, -5000))
    await importInto(SAVINGS, repeat(3, DAY, 5000))
    const everyday = await accountId('Everyday')

    const { meta } = await unpairPartnersOfImportedStatement(env.DB, { accountId: everyday, limit: 5000 }).run()

    // Three partners are written. The removed rows are about to go, so they are not touched: they still point at their halves.
    expect(meta.changes).toBe(3)
    expect(meta.rows_written).toBeLessThanOrEqual(6)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND transfer_of IS NOT NULL').bind(everyday).first<{ n: number }>())!.n).toBe(3)
  })

  it('releases the partners of only the first rows by ID, the same ones the removal takes', async () => {
    await importInto(EVERYDAY, repeat(3, DAY, -5000))
    await importInto(SAVINGS, repeat(3, DAY, 5000))
    const everyday = await accountId('Everyday')

    const { meta } = await unpairPartnersOfImportedStatement(env.DB, { accountId: everyday, limit: 2 }).run()

    expect(meta.changes).toBe(2)
  })
})
