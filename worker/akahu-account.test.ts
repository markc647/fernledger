import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'
import { akahuAccount } from './akahu'
import worker from './index'
import { toDetails } from './akahu-details'

// Seam 1 for what Akahu sends about one account (ticket 42): the shape that reads it, what Sync makes of it, and the two routes that
// carry it, the Admin's picker (which must still work with the wider shape) and the Accounts list (which must not carry the logo URL).
// Every ID, name and URL is made up.

/** Akahu's answer for one account in full, as seen on the test site (#30), with made-up values. */
const full = () => ({
  _id: 'acc_example000000000000001',
  connection: { _id: 'conn_example0000000000001', name: 'Example Bank', logo: 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001', connection_type: 'official' },
  name: 'EXAMPLE EVERYDAY',
  formatted_account: '99-9999-9999999-01',
  status: 'ACTIVE',
  type: 'CHECKING',
  attributes: ['PAYMENT_TO', 'PAYMENT_FROM', 'TRANSACTIONS'],
  balance: { currency: 'NZD', current: 707.17, available: 700.1 },
  refreshed: { balance: '2026-10-21T02:46:00.000Z', meta: '2026-10-21T02:47:00.000Z', transactions: '2026-10-21T02:48:00.000Z' },
})

/** The same with everything optional left out. */
const bare = () => {
  const { balance: _balance, refreshed: _refreshed, formatted_account: _formatted, attributes: _attributes, ...rest } = full()
  return { ...rest, connection: { _id: 'conn_example0000000000001', name: 'Example Bank' } }
}

const parse = (input: unknown) => z.safeParse(akahuAccount, input)

describe('reading an Akahu account', () => {
  it('reads every field Akahu sends', () => {
    const parsed = parse(full())
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(full())
  })

  it('does not mind a missing balance, logo, connection type, attributes, refreshed or formatted account', () => {
    expect(parse(bare()).success).toBe(true)
  })

  it('does not mind a balance with no available figure, or a refreshed with parts missing', () => {
    expect(parse({ ...full(), balance: { currency: 'NZD', current: 1 }, refreshed: { balance: '2026-10-21T02:46:00.000Z' } }).success).toBe(true)
  })

  it('does not mind a missing status, type or connection, so one odd account cannot make the whole list unreadable', () => {
    const { status: _status, type: _type, connection: _connection, ...rest } = full()
    expect(parse(rest).success).toBe(true)
    expect(parse({ ...full(), connection: { logo: 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001' } }).success).toBe(true)
  })

  it('refuses an account with no ID or name', () => {
    for (const field of ['_id', 'name'] as const) {
      const { [field]: _gone, ...rest } = full()
      expect(parse(rest).success, field).toBe(false)
    }
  })

  it('ignores a field it does not know', () => {
    expect(parse({ ...full(), something_new: 1 }).success).toBe(true)
  })
})

describe('what Sync keeps of an Akahu account', () => {
  it('keeps every field, with the balance as integer cents and the currency beside it', () => {
    expect(toDetails(parse(full()).data!)).toEqual({
      akahuName: 'EXAMPLE EVERYDAY',
      akahuFormattedAccount: '99-9999-9999999-01',
      akahuStatus: 'ACTIVE',
      akahuType: 'CHECKING',
      akahuAttributes: '["PAYMENT_TO","PAYMENT_FROM","TRANSACTIONS"]',
      akahuConnectionId: 'conn_example0000000000001',
      akahuConnectionName: 'Example Bank',
      akahuConnectionLogo: 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001',
      akahuConnectionType: 'official',
      akahuBalanceCurrency: 'NZD',
      akahuBalanceCurrentCents: 70717,
      akahuBalanceAvailableCents: 70010,
      akahuRefreshedBalanceAt: '2026-10-21T02:46:00.000Z',
      akahuRefreshedMetaAt: '2026-10-21T02:47:00.000Z',
      akahuRefreshedTransactionsAt: '2026-10-21T02:48:00.000Z',
    })
  })

  it('keeps nothing for what Akahu did not send', () => {
    const details = toDetails(parse(bare()).data!)
    expect(details).toMatchObject({ akahuName: 'EXAMPLE EVERYDAY', akahuConnectionName: 'Example Bank' })
    expect(
      Object.entries(details)
        .filter(([, value]) => value === null)
        .map(([key]) => key),
    ).toEqual([
      'akahuFormattedAccount',
      'akahuAttributes',
      'akahuConnectionLogo',
      'akahuConnectionType',
      'akahuBalanceCurrency',
      'akahuBalanceCurrentCents',
      'akahuBalanceAvailableCents',
      'akahuRefreshedBalanceAt',
      'akahuRefreshedMetaAt',
      'akahuRefreshedTransactionsAt',
    ])
  })

  it('keeps an instant as an ISO instant, and nothing for one that is not an instant, which the screen could not write as a time', () => {
    const details = toDetails(parse({ ...full(), refreshed: { balance: '2026-10-21T15:46:00+13:00', meta: 'yesterday' } }).data!)
    expect(details).toMatchObject({ akahuRefreshedBalanceAt: '2026-10-21T02:46:00.000Z', akahuRefreshedMetaAt: null, akahuRefreshedTransactionsAt: null })
  })

  it('keeps nothing for a status, type or connection that is missing', () => {
    const { status: _status, type: _type, connection: _connection, ...rest } = full()
    expect(toDetails(parse(rest).data!)).toMatchObject({
      akahuName: 'EXAMPLE EVERYDAY',
      akahuStatus: null,
      akahuType: null,
      akahuConnectionId: null,
      akahuConnectionName: null,
      akahuConnectionLogo: null,
      akahuConnectionType: null,
    })
  })

  it('keeps a balance with no available figure as a current balance alone', () => {
    const details = toDetails(parse({ ...full(), balance: { currency: 'NZD', current: -12.34 } }).data!)
    expect(details).toMatchObject({ akahuBalanceCurrency: 'NZD', akahuBalanceCurrentCents: -1234, akahuBalanceAvailableCents: null })
  })
})

describe('the routes that carry it', () => {
  const SECRETS = { AKAHU_APP_TOKEN: 'app_token_SECRET_VALUE_1', AKAHU_USER_TOKEN: 'user_token_SECRET_VALUE_2' }
  const list = async (who: 'admin' | 'member') =>
    exports.default.fetch(new Request('http://localhost:5173/api/accounts', { headers: { Cookie: `fernledger_dev_as=${who}` } }))

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM transactions').run()
    await env.DB.prepare('DELETE FROM accounts').run()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('still lists the Akahu accounts for the picker, as the three things it shows, when Akahu sends the wider shape', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ items: [full(), bare()] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const ctx = createExecutionContext()
    const request = new Request('http://localhost:5173/api/akahu/accounts', { headers: { Cookie: 'fernledger_dev_as=admin' } })
    const res = await worker.fetch!(request as never, { ...env, ...SECRETS }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { _id: 'acc_example000000000000001', name: 'EXAMPLE EVERYDAY', formatted_account: '99-9999-9999999-01' },
      { _id: 'acc_example000000000000001', name: 'EXAMPLE EVERYDAY' },
    ])
  })

  it('still lists the Akahu accounts when one has no status, type or connection', async () => {
    const { status: _status, type: _type, connection: _connection, ...odd } = full()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ items: [full(), { ...odd, _id: 'acc_example000000000000009', name: 'ODD' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const ctx = createExecutionContext()
    const request = new Request('http://localhost:5173/api/akahu/accounts', { headers: { Cookie: 'fernledger_dev_as=admin' } })
    const res = await worker.fetch!(request as never, { ...env, ...SECRETS }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { _id: string }[]).map((account) => account._id)).toEqual(['acc_example000000000000001', 'acc_example000000000000009'])
  })

  it('lists the details the Accounts screen shows, and never the logo URL', async () => {
    const id = (await env.DB.prepare("INSERT INTO accounts (account_number, name, akahu_account_id) VALUES ('99-9999-9999999-01', 'Everyday', 'acc_example000000000000001') RETURNING id").first<{ id: number }>())!.id
    await env.DB.prepare(
      `UPDATE accounts SET akahu_name = 'EXAMPLE EVERYDAY', akahu_formatted_account = '99-9999-9999999-01', akahu_status = 'ACTIVE', akahu_type = 'CHECKING',
         akahu_attributes = '["PAYMENT_TO","TRANSACTIONS"]', akahu_connection_id = 'conn_example0000000000001', akahu_connection_name = 'Example Bank',
         akahu_connection_type = 'official',
         akahu_connection_logo = 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001', akahu_balance_currency = 'NZD',
         akahu_balance_current_cents = 70717, akahu_balance_available_cents = 70010, akahu_refreshed_balance_at = '2026-10-21T02:46:00.000Z',
         akahu_synced_at = '2026-10-20T18:00:00.000Z' WHERE id = ?`,
    )
      .bind(id)
      .run()
    const text = await (await list('member')).text()
    expect(text).not.toContain('cdn.akahu.nz')
    expect(JSON.parse(text)).toEqual([
      expect.objectContaining({
        id,
        akahuAccountId: 'acc_example000000000000001',
        akahuName: 'EXAMPLE EVERYDAY',
        akahuFormattedAccount: '99-9999-9999999-01',
        akahuStatus: 'ACTIVE',
        akahuType: 'CHECKING',
        // The words Akahu sent, as the words they are: the JSON the column holds is this Worker's storage and never the browser's to read.
        akahuAttributes: ['PAYMENT_TO', 'TRANSACTIONS'],
        akahuConnectionId: 'conn_example0000000000001',
        akahuConnectionName: 'Example Bank',
        akahuConnectionType: 'official',
        akahuBalanceCurrency: 'NZD',
        akahuBalanceCurrentCents: 70717,
        akahuBalanceAvailableCents: 70010,
        akahuRefreshedBalanceAt: '2026-10-21T02:46:00.000Z',
        akahuRefreshedMetaAt: null,
        akahuRefreshedTransactionsAt: null,
        akahuSyncedAt: '2026-10-20T18:00:00.000Z',
      }),
    ])
  })

  it.each([
    ['an empty list, which is Akahu saying the Account can do nothing', '[]', []],
    ['nothing at all, when Akahu sent no attributes', null, null],
    ['nothing at all, when the column holds something that is not a list of words', '{"not":"a list"}', null],
  ])('gives the attributes as %s', async (_, stored, expected) => {
    const id = (await env.DB.prepare("INSERT INTO accounts (account_number, name, akahu_account_id) VALUES ('99-9999-9999999-03', 'Card', 'acc_example000000000000003') RETURNING id").first<{ id: number }>())!.id
    await env.DB.prepare('UPDATE accounts SET akahu_attributes = ? WHERE id = ?').bind(stored, id).run()
    const [account] = (await (await list('member')).json()) as Record<string, unknown>[]
    expect(account).toMatchObject({ akahuAttributes: expected })
  })

  it('lists an Account that is not linked with none of it', async () => {
    await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-02', 'Savings')").run()
    const [account] = (await (await list('member')).json()) as Record<string, unknown>[]
    expect(account).toMatchObject({ akahuAccountId: null, akahuName: null, akahuBalanceCurrentCents: null, akahuRefreshedBalanceAt: null, akahuSyncedAt: null })
  })
})
