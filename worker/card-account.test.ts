import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

// Seam 1: requests through the Worker's exported handler. An Account whose bank prints no number gets a key of Fernledger's own
// (ADR 0017), which is what an Import of a card file is matched to, because the file itself names no account.
const origin = 'http://localhost:5173'
const savings = '99-9999-9999999-99'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

const addCard = (name: unknown, who: Who = 'admin') => call('/api/accounts', { who, method: 'POST', body: { name } })

type AccountJson = { id: number; name: string; accountNumber: string; cutoverDate: string | null }
const accounts = async (): Promise<AccountJson[]> => (await call('/api/accounts')).json()

/** A made-up row of a Kiwibank credit card export, as the card adapter produces it (src/lib/bank-csv/kiwibank-card.ts). */
const cardRow = (date: string, amountCents: number, occurrence = 1, card = '9999') => ({
  date,
  uniqueId: `${date}:${amountCents}:${card}:${occurrence}`,
  tranType: '',
  chequeNumber: null,
  payee: 'EXAMPLE CAFE TOWN',
  bankMemo: 'EXAMPLE CAFE TOWN',
  amountCents,
  cardSuffix: card,
})

/** A chunk of a card Import: the Account by its key, and a file that states no ledger balance, because a card export has none. */
const cardChunk = (key: string, rows: unknown[], extra: { cutoverDate?: string } = {}) => ({
  account: { number: key },
  chunk: { index: 0, count: 1 },
  file: { adapterId: 'kiwibank-card', rowCount: rows.length, skipped: 0, from: '2026-09-01', to: '2026-09-30' },
  rows,
  ...(extra.cutoverDate !== undefined ? { cutoverDate: extra.cutoverDate } : {}),
})

const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, after FROM change_log ORDER BY id').all<{ summary: string; actor: string; after: string | null }>()).results
const balancesOf = async (key: string) =>
  (
    await env.DB.prepare('SELECT b.as_of_date AS asOfDate, b.status FROM balance_checks b JOIN accounts a ON a.id = b.account_id WHERE a.account_number = ?').bind(key).all()
  ).results

beforeEach(async () => {
  await env.DB.batch(['transactions', 'balance_checks', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
})

describe('POST /api/accounts', () => {
  it('adds an Account for a credit card, with a key of Fernledger’s own and the name the Admin typed', async () => {
    const res = await addCard('Example Visa')

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Example Visa', accountNumber: 'card-0001' })
    expect(await accounts()).toMatchObject([{ name: 'Example Visa', accountNumber: 'card-0001', cutoverDate: null }])
  })

  it('gives each one the next key, so two cards are two Accounts', async () => {
    await addCard('Example Visa')
    await addCard('Example Mastercard')

    expect((await accounts()).map((a) => a.accountNumber).sort()).toEqual(['card-0001', 'card-0002'])
  })

  // The key follows the highest held, not the count, so it is never one an Account already has.
  it('follows the highest key held, whatever else is there', async () => {
    await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('card-0007', 'Example old card'), (?, 'Example savings')").bind(savings).run()

    expect(await (await addCard('Example Visa')).json()).toMatchObject({ accountNumber: 'card-0008' })
  })

  it('records the change in the Change Log, naming the Account and not its key', async () => {
    await addCard('Example Visa')

    const [entry] = await changeLog()
    expect(entry!.summary).toBe('Added the credit card Account Example Visa')
    expect(entry!.actor).toBe('admin@example.com')
    expect(JSON.parse(entry!.after!)).toEqual({ name: 'Example Visa' })
  })

  it('refuses a Member, who can change nothing', async () => {
    const res = await addCard('Example Visa', 'member')

    expect(res.status).toBe(403)
    expect(await accounts()).toEqual([])
  })

  it('refuses a name that is empty or too long', async () => {
    expect((await addCard('   ')).status).toBe(400)
    expect((await addCard('x'.repeat(61))).status).toBe(400)
    expect((await addCard(42)).status).toBe(400)
    expect(await accounts()).toEqual([])
  })
})

describe('an Import into an Account whose bank prints no number', () => {
  it('saves the rows against the Account the Admin chose, with the card each was spent on', async () => {
    const { accountNumber: key } = (await (await addCard('Example Visa')).json()) as { accountNumber: string }

    const res = await call('/api/imports/chunks', { method: 'POST', body: cardChunk(key, [cardRow('2026-09-02', -450), cardRow('2026-09-02', -450, 2), cardRow('2026-09-03', -12995)]) })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: 3 })
    const stored = (
      await env.DB.prepare(
        'SELECT t.bank_unique_id AS id, t.bank_card_suffix AS card, t.bank_type AS type FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.account_number = ? ORDER BY t.bank_unique_id',
      )
        .bind(key)
        .all()
    ).results
    expect(stored).toEqual([
      { id: '2026-09-02:-450:9999:1', card: '9999', type: '' },
      { id: '2026-09-02:-450:9999:2', card: '9999', type: '' },
      { id: '2026-09-03:-12995:9999:1', card: '9999', type: '' },
    ])
  })

  // A card export states no balance, so there is nothing to record and nothing to check (ADR 0017).
  it('records no bank balance and reports no Balance Check, because the file states none', async () => {
    const { accountNumber: key } = (await (await addCard('Example Visa')).json()) as { accountNumber: string }

    const res = await call('/api/imports/chunks', { method: 'POST', body: cardChunk(key, [cardRow('2026-09-02', -450)]) })

    expect(await res.json()).toMatchObject({ balanceCheck: null })
    expect(await balancesOf(key)).toEqual([])
  })

  it('takes a Cutover Date for it like any other Account, so Sync can have a window', async () => {
    const { accountNumber: key } = (await (await addCard('Example Visa')).json()) as { accountNumber: string }

    await call('/api/imports/chunks', { method: 'POST', body: cardChunk(key, [cardRow('2026-09-02', -450)], { cutoverDate: '2026-10-01' }) })

    expect(await accounts()).toMatchObject([{ accountNumber: key, cutoverDate: '2026-10-01' }])
  })

  // An Import adds nothing twice (ADR 0003): the adapter's IDs are the same every time, so the same file again is all duplicates.
  it('adds nothing twice when the same file is imported again', async () => {
    const { accountNumber: key } = (await (await addCard('Example Visa')).json()) as { accountNumber: string }
    const rows = [cardRow('2026-09-02', -450), cardRow('2026-09-02', -450, 2)]
    await call('/api/imports/chunks', { method: 'POST', body: cardChunk(key, rows) })

    const again = await call('/api/imports/chunks', { method: 'POST', body: cardChunk(key, rows) })

    expect(await again.json()).toMatchObject({ added: 0, duplicates: 2 })
  })

  // Only the Accounts screen hands out a generated key (ADR 0017). An Import that names one for an Account that is not there
  // would create a key nothing allocated, under a name that is the key itself, which every Report and the CSV export then print.
  it('refuses to create an Account from a generated key, which is the Worker’s to hand out', async () => {
    const res = await call('/api/imports/chunks', { method: 'POST', body: cardChunk('card-0042', [cardRow('2026-09-02', -450)]) })

    expect(res.status).toBe(400)
    expect(await accounts()).toEqual([])
  })

  it('still creates an Account from the number a file carries', async () => {
    const res = await call('/api/imports/chunks', {
      method: 'POST',
      body: { ...cardChunk(savings, [cardRow('2026-09-02', -450)]), account: { number: savings, name: 'Example savings' } },
    })

    expect(res.status).toBe(200)
    expect(await accounts()).toMatchObject([{ name: 'Example savings', accountNumber: savings }])
  })

  it('refuses a key that is neither a bank number nor one Fernledger generates', async () => {
    for (const number of ['Visa', 'card-1', 'card-', '99-9999-9999999']) {
      expect((await call('/api/imports/chunks', { method: 'POST', body: cardChunk(number, [cardRow('2026-09-02', -450)]) })).status, number).toBe(400)
    }
    expect(await accounts()).toEqual([])
  })
})
