import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { callWhileInterrupted } from './test-support'
import { CHANGED_MEANWHILE } from './validate'

// Seam 1: PUT /api/accounts/:id/akahu-link through the Worker's exported handler, as the local-development Admin or a read-only
// Member. The Account Link is which Akahu account an Account receives its daily Sync from (spec 29); setting it contacts no one,
// and worker/outbound.test.ts holds it to that.
const origin = 'http://localhost:5173'
const LINKED = 'acc_example000000000000001'
const OTHER = 'acc_example000000000000002'

async function call(path: string, opts: { who?: 'admin' | 'member'; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

const link = (id: number, akahuAccountId: string | null, who: 'admin' | 'member' = 'admin') =>
  call(`/api/accounts/${id}/akahu-link`, { who, method: 'PUT', body: { akahuAccountId } })

const linkOf = async (id: number) =>
  (await env.DB.prepare('SELECT akahu_account_id FROM accounts WHERE id = ?').bind(id).first<{ akahu_account_id: string | null }>())!.akahu_account_id

let everyday = 0
let savings = 0

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM transactions').run()
  await env.DB.prepare('DELETE FROM accounts').run()
  await env.DB.prepare('DELETE FROM change_log').run()
  const add = async (number: string, name: string) =>
    (await env.DB.prepare('INSERT INTO accounts (account_number, name) VALUES (?, ?) RETURNING id').bind(number, name).first<{ id: number }>())!.id
  everyday = await add('99-9999-9999999-01', 'Everyday example')
  savings = await add('99-9999-9999999-02', 'Savings example')
})

describe('setting the Account Link', () => {
  it('links an Account and says so', async () => {
    const res = await link(everyday, LINKED)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: everyday, akahuAccountId: LINKED })
    expect(await linkOf(everyday)).toBe(LINKED)
  })

  it('shows the link on the Accounts list, so the screen knows what is linked without asking Akahu', async () => {
    await link(everyday, LINKED)
    const accounts = (await (await call('/api/accounts')).json()) as { id: number; akahuAccountId: string | null }[]
    expect(accounts.find((a) => a.id === everyday)?.akahuAccountId).toBe(LINKED)
    expect(accounts.find((a) => a.id === savings)?.akahuAccountId).toBeNull()
  })

  // Unlinking stops the daily Sync. It is not a delete: what Sync already brought in is the Account's history.
  it('unlinks without touching the Transactions Sync already brought in', async () => {
    await link(everyday, LINKED)
    await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, akahu_id) VALUES (?, '2026-10-01', -100, 'EXAMPLE SYNCED', 'sync', 'trans_example0000000000001')")
      .bind(everyday)
      .run()

    const res = await link(everyday, null)

    expect(res.status).toBe(200)
    expect(await linkOf(everyday)).toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').bind(everyday).first<{ n: number }>()).toEqual({ n: 1 })
  })

  // One Akahu account feeds at most one Account: syncing it into two would double every Transaction it has.
  it('refuses an Akahu account another Account already has, and names that Account', async () => {
    await link(everyday, LINKED)

    const res = await link(savings, LINKED)

    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toEqual({ error: 'That Akahu account is already linked to Everyday example' })
    expect(await linkOf(savings)).toBeNull()
  })

  it('lets an Account keep the link it already has, which is not a clash with itself', async () => {
    await link(everyday, LINKED)
    expect((await link(everyday, LINKED)).status).toBe(200)
  })

  it('moves a link from one Akahu account to another', async () => {
    await link(everyday, LINKED)
    expect((await link(everyday, OTHER)).status).toBe(200)
    expect(await linkOf(everyday)).toBe(OTHER)
  })

  it('records the change, without Akahu’s own ID in the summary a Member can read', async () => {
    await link(everyday, LINKED)
    await link(everyday, null)
    const entries = (await env.DB.prepare('SELECT type, summary FROM change_log ORDER BY id').all<{ type: string; summary: string }>()).results
    expect(entries.map((e) => e.summary)).toEqual(['Linked Everyday example to an Akahu account', 'Unlinked Everyday example from Akahu'])
    expect(entries.every((e) => e.type === 'account')).toBe(true)
    expect(entries.some((e) => e.summary.includes(LINKED))).toBe(false)
  })

  // The write is guarded on the link that was read, so a request whose Account was linked in between must not overwrite it.
  it('tells a request that lost a race that the Account changed meanwhile, and overwrites nothing', async () => {
    const res = await callWhileInterrupted(`/api/accounts/${everyday}/akahu-link`, 'PUT', { akahuAccountId: LINKED }, () =>
      env.DB.prepare('UPDATE accounts SET akahu_account_id = ? WHERE id = ?').bind(OTHER, everyday).run(),
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(CHANGED_MEANWHILE)
    expect(await linkOf(everyday)).toBe(OTHER)
  })
})

describe('what the Account Link refuses', () => {
  it.each([
    ['not an Akahu account ID', 'nope'],
    ['an empty string', ''],
    ['an ID of another kind', 'trans_example0000000000001'],
    ['one with characters Akahu does not use', 'acc_example/0000000000001'],
  ])('refuses %s', async (_label, value) => {
    const res = await link(everyday, value)
    expect(res.status).toBe(400)
    expect(await linkOf(everyday)).toBeNull()
  })

  it('refuses a Member, who may read but not write', async () => {
    const res = await link(everyday, LINKED, 'member')
    expect(res.status).toBe(403)
    expect(await linkOf(everyday)).toBeNull()
  })

  it('answers 404 for an Account that is not there', async () => {
    expect((await link(999_999, LINKED)).status).toBe(404)
  })
})
