import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS } from './net-worth'

// Seam 1: requests through the Worker's exported handler. The Admin's order of Accounts (#45) is set with PUT /api/accounts/order
// and used wherever Accounts are listed; Accounts with no position yet follow, by name.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

const addCard = async (name: string) => ((await (await call('/api/accounts', { method: 'POST', body: { name } })).json()) as { id: number }).id
const order = (ids: number[], who: Who = 'admin') => call('/api/accounts/order', { who, method: 'PUT', body: { ids } })
const names = async () => ((await (await call('/api/accounts')).json()) as { name: string }[]).map((account) => account.name)
const balanceNames = async () => ((await (await call('/api/balances')).json()) as { accounts: { accountName: string }[] }).accounts.map((account) => account.accountName)
const netWorthNames = async () => (await env.DB.prepare(ACCOUNTS).all<{ name: string }>()).results.map((account) => account.name)
const entries = async () => (await env.DB.prepare('SELECT summary, before, after FROM change_log ORDER BY id').all<{ summary: string; before: string; after: string }>()).results

let visa: number, mastercard: number, amex: number
beforeEach(async () => {
  await env.DB.batch(['transactions', 'balance_checks', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  visa = await addCard('Visa')
  mastercard = await addCard('Mastercard')
  amex = await addCard('Amex')
})

describe('the order of Accounts', () => {
  it('is by name before the Admin chooses one', async () => {
    expect(await names()).toEqual(['Amex', 'Mastercard', 'Visa'])
  })

  it("is the Admin's order once chosen, in every list of Accounts, and is in the Change Log", async () => {
    const res = await order([visa, amex, mastercard])

    expect(res.status).toBe(200)
    expect(await names()).toEqual(['Visa', 'Amex', 'Mastercard'])
    expect(await balanceNames()).toEqual(['Visa', 'Amex', 'Mastercard'])
    expect(await netWorthNames()).toEqual(['Visa', 'Amex', 'Mastercard'])
    expect((await entries()).at(-1)).toMatchObject({ summary: 'Changed the order of Accounts' })
    expect(JSON.parse((await entries()).at(-1)!.after)).toEqual({ order: ['1. Visa', '2. Amex', '3. Mastercard'] })
  })

  it('puts an Account added after the order was chosen last', async () => {
    await order([visa, amex, mastercard])
    await addCard('Aardvark card')
    expect(await names()).toEqual(['Visa', 'Amex', 'Mastercard', 'Aardvark card'])
  })

  it('writes nothing for the order already held', async () => {
    const before = (await entries()).length
    expect((await order([amex, mastercard, visa])).status).toBe(200)
    expect(await entries()).toHaveLength(before)
  })

  it('refuses a list that is not exactly the Accounts held', async () => {
    expect((await order([visa, amex])).status).toBe(400)
    expect((await order([visa, amex, mastercard, mastercard])).status).toBe(400)
    expect((await order([visa, amex, 999_999])).status).toBe(400)
    expect(await names()).toEqual(['Amex', 'Mastercard', 'Visa'])
  })

  it('is the Admin’s to change, not a Member’s', async () => {
    expect((await order([visa, amex, mastercard], 'member')).status).toBe(403)
    expect(await names()).toEqual(['Amex', 'Mastercard', 'Visa'])
  })
})
