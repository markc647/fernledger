import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

// Seam 1: what Akahu says about a Transaction beyond what Sync always held (ticket 43), as the Transaction detail gives it, and that Akahu's
// category is inert: it is shown and does nothing else. Made-up data throughout (bank 99, nzfcc_example…). Sync's own storing of these fields
// is in sync.test.ts.
const origin = 'http://localhost:5173'

async function call(path: string, who: 'admin' | 'member' = 'member') {
  return exports.default.fetch(new Request(`${origin}${path}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }))
}
const detail = async (id: number) => (await call(`/api/transactions/${id}`)).json<Record<string, unknown>>()

let account = 0
async function add(over: { description?: string; amountCents?: number; date?: string } = {}) {
  const { meta } = await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, source) VALUES (?, ?, ?, ?, ?)')
    .bind(account, over.date ?? '2026-10-10', over.amountCents ?? -5000, over.description ?? 'EXAMPLE STORE', 'sync')
    .run()
  return meta.last_row_id
}
const giveAkahuCategory = (id: number) =>
  env.DB.prepare(
    `UPDATE transactions SET akahu_category_id = 'nzfcc_example0000000001', akahu_category_name = 'Example category',
       akahu_category_group_id = 'group_example00000001', akahu_category_group_name = 'Example group' WHERE id = ?`,
  )
    .bind(id)
    .run()

beforeEach(async () => {
  await env.DB.batch(['kept_reports', 'budgets', 'transactions', 'accounts', 'change_log', 'rules'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  account = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example cheque') RETURNING id").first<{ id: number }>())!.id
})

describe('the Transaction detail', () => {
  it("gives Akahu's category and its group, named as Akahu's", async () => {
    const id = await add()
    await giveAkahuCategory(id)
    expect(await detail(id)).toMatchObject({ akahuCategoryName: 'Example category', akahuCategoryGroupName: 'Example group' })
  })

  it('gives nothing for one with no category, which is not the same as a category called nothing', async () => {
    const id = await add()
    expect(await detail(id)).toMatchObject({ akahuCategoryName: null, akahuCategoryGroupName: null })
  })

  it("does not send the balance, hash, update or posted dates or connection, which are kept and not shown", async () => {
    const id = await add()
    await env.DB.prepare("UPDATE transactions SET akahu_balance_cents = 70717, akahu_hash = 'h', akahu_updated_at = 'u', akahu_posted_date = 'p', akahu_connection_id = 'c' WHERE id = ?").bind(id).run()
    const keys = Object.keys(await detail(id))
    expect(keys.filter((key) => /balance|hash|updated|posted|connection/i.test(key))).toEqual([])
  })

  describe('the Bank Time', () => {
    const set = (id: number, raw: string | null, hasTime: number | null, fromMemo: string | null) =>
      env.DB.prepare('UPDATE transactions SET akahu_date_raw = ?, has_bank_time = ?, bank_time_from_memo = ? WHERE id = ?').bind(raw, hasTime, fromMemo, id).run()

    it('is the time read from the description when Akahu supplied none', async () => {
      const id = await add()
      await set(id, '2026-10-09T11:00:00.000Z', 0, '2026-10-09T23:07:00.000Z')
      expect(await detail(id)).toMatchObject({ bankTime: '2026-10-09T23:07:00.000Z' })
    })

    it("is the time Akahu supplied when it did, before one read from the description", async () => {
      const id = await add()
      await set(id, '2026-10-09T20:15:00.000Z', 1, '2026-10-09T23:07:00.000Z')
      expect(await detail(id)).toMatchObject({ bankTime: '2026-10-09T20:15:00.000Z' })
    })

    it('is none when neither is known, and a date at midnight is not a time', async () => {
      const id = await add()
      await set(id, '2026-10-09T11:00:00.000Z', 0, null)
      expect(await detail(id)).toMatchObject({ bankTime: null })
    })
  })
})

describe("Akahu's category is inert", () => {
  const spending = async () => (await call('/api/reports/spending?from=2026-10-01&to=2026-10-31', 'admin')).json()
  const uncategorisedIds = async () =>
    ((await (await call('/api/transactions?uncategorised=true')).json()) as { transactions: { id: number }[] }).transactions.map((t) => t.id).sort()

  it('leaves a Transaction Uncategorised, with no Category, Rule or Override', async () => {
    const id = await add()
    await giveAkahuCategory(id)
    expect(await detail(id)).toMatchObject({ categoryId: null, categoryName: null, categorySource: null })
    expect(await uncategorisedIds()).toEqual([id])
  })

  it("changes no Report figure and no count of what is Uncategorised, whichever Transactions have one", async () => {
    const [a, b] = [await add({ amountCents: -5000 }), await add({ amountCents: -2500, description: 'ANOTHER EXAMPLE STORE' })]
    await add({ amountCents: 120000, description: 'EXAMPLE WAGES' })
    const reportBefore = await spending()
    const uncategorisedBefore = await uncategorisedIds()

    await giveAkahuCategory(a)
    await giveAkahuCategory(b)

    expect(await spending()).toEqual(reportBefore)
    expect(await uncategorisedIds()).toEqual(uncategorisedBefore)
    expect(JSON.stringify(reportBefore)).not.toContain('Example category')
  })

  it('does not stop a Rule categorising the Transaction', async () => {
    const id = await add({ description: 'EXAMPLE STORE' })
    await giveAkahuCategory(id)
    const groceries = (await env.DB.prepare("SELECT id FROM categories WHERE name = 'Groceries'").first<{ id: number }>())!.id
    await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE id = ?').bind(groceries, id).run()
    expect(await detail(id)).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
  })
})
