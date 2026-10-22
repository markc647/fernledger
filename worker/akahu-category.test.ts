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
const giveStoredOnly = (id: number) =>
  env.DB.prepare("UPDATE transactions SET akahu_balance_cents = 70717, akahu_hash = 'h', akahu_updated_at = 'u', akahu_posted_date = 'p', akahu_connection_id = 'c' WHERE id = ?").bind(id).run()
const DETAIL_KEYS = [
  'accountId', 'accountName', 'akahuCategoryGroupName', 'akahuCategoryName', 'amountCents', 'bankCardSuffix', 'bankCounterpartyAccount', 'bankMemo',
  'bankParticulars', 'bankPaymentCode', 'bankReference', 'bankTime', 'bankType', 'canMarkNotTransfer', 'categoryId', 'categoryKind', 'categoryName',
  'categorySource', 'date', 'description', 'firstSeenAt', 'id', 'notTransfer', 'note', 'source', 'transfer', 'transferAccountName', 'transferPartnerOverridden',
  'transferTransactionId',
]
const LIST_KEYS = [
  'accountId', 'accountName', 'amountCents', 'bankType', 'canMarkNotTransfer', 'categoryId', 'categoryKind', 'categoryName', 'categorySource', 'date',
  'description', 'id', 'notTransfer', 'note', 'transfer', 'transferAccountName',
]
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

describe('the Transaction list', () => {
  it("sends exactly these fields, and none of the stored-only columns or Akahu's category, whatever is stored", async () => {
    const id = await add()
    await giveAkahuCategory(id)
    await giveStoredOnly(id)
    const page = (await (await call('/api/transactions')).json()) as { transactions: Record<string, unknown>[] }
    expect(page.transactions).toHaveLength(1)
    expect(Object.keys(page.transactions[0]!).sort()).toEqual(LIST_KEYS)
  })
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

  // What the page may read, by exact name: a stored-only column that was sent would be a new name here, and fail this.
  it('sends exactly these fields, and none of the stored-only columns or the category IDs, whatever is stored', async () => {
    const id = await add()
    await giveAkahuCategory(id)
    await giveStoredOnly(id)
    expect(Object.keys(await detail(id)).sort()).toEqual(DETAIL_KEYS)
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

// The same work done twice over the same made-up Transactions, once as they are and once as Sync leaves them with Akahu's category (and the
// other stored fields) filled in. Every step is the real code path, and everything it makes visible is compared: they must be identical.
describe("Akahu's category through the real paths", () => {
  const admin = (path: string, method = 'GET', body?: unknown) =>
    exports.default.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: { Cookie: 'fernledger_dev_as=admin', ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const res = await admin(path, method, body)
    return { status: res.status, body: (await res.json()) as unknown }
  }
  const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ? AND removed_at IS NULL').bind(name).first<{ id: number }>())!.id

  const ROWS = [
    { description: 'EXAMPLE STORE', amountCents: -5000, date: '2026-10-10' },
    { description: 'EXAMPLE STORE NORTH', amountCents: -2500, date: '2026-10-11' },
    { description: 'EXAMPLE PETROL', amountCents: -8000, date: '2026-10-12' },
    { description: 'EXAMPLE LOAN REPAYMENT', amountCents: -30000, date: '2026-10-13' },
    { description: 'EXAMPLE WAGES', amountCents: 120000, date: '2026-10-14' },
  ]

  type ListRow = { description: string; categoryName: string | null; categorySource: string | null; categoryKind: string | null }

  /** Everything a reader can see of the data: the list, what is Uncategorised, one Transaction, and every Report. */
  async function snapshot(accountId: number, loans: number, firstId: number) {
    const range = 'from=2026-10-01&to=2026-10-31'
    const list = (await json('/api/transactions?limit=200')).body as { transactions: ListRow[] }
    return {
      list: list.transactions.map(({ description, categoryName, categorySource, categoryKind }) => ({ description, categoryName, categorySource, categoryKind })),
      uncategorised: await json('/api/transactions?uncategorised=true&count=only'),
      // Akahu's category is the one thing that may differ, and only in the two fields made to show it.
      detail: (({ akahuCategoryName: _name, akahuCategoryGroupName: _group, ...rest }) => rest)((await json(`/api/transactions/${firstId}`)).body as Record<string, unknown>),
      reports: {
        transactions: await json(`/api/reports/transactions?accountId=${accountId}&${range}`),
        spending: await json(`/api/reports/spending?${range}`),
        incomeVsSpending: await json(`/api/reports/income-vs-spending?${range}`),
        loans: await json(`/api/reports/loans?categoryId=${loans}&to=2026-10-31`),
        balances: await json(`/api/reports/balances?accountId=${accountId}&${range}`),
        budgetVsActual: await json(`/api/reports/budget-vs-actual?${range}`),
      },
    }
  }

  async function scenario(withAkahu: boolean) {
    await env.DB.batch(['kept_reports', 'budgets', 'transactions', 'rules', 'accounts', 'change_log', 'data_migration_progress'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
    await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('transactions', 'accounts', 'rules')").run() // the same IDs both times
    const accountId = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example cheque') RETURNING id").first<{ id: number }>())!.id
    const ids: number[] = []
    for (const row of ROWS) {
      const { meta } = await env.DB.prepare('INSERT INTO transactions (account_id, date, amount_cents, description, bank_type, source) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(accountId, row.date, row.amountCents, row.description, 'EFTPOS', 'sync')
        .run()
      ids.push(meta.last_row_id)
    }
    if (withAkahu) {
      for (const id of ids.slice(0, 4)) {
        await giveAkahuCategory(id)
        await giveStoredOnly(id)
      }
    }
    const [groceries, fuel, loans, wages] = [await categoryId('Groceries'), await categoryId('Fuel'), await categoryId('Loans'), await categoryId('Wages and salary')]
    const seen: unknown[] = []
    const step = async (what: string) => seen.push({ what, ...(await snapshot(accountId, loans, ids[0]!)) })

    await step('as synced')
    // Rules: made one at a time, then applied to all Transactions by a re-run, walked to its end.
    for (const body of [
      { textContains: 'EXAMPLE PETROL', categoryId: fuel },
      { textContains: 'EXAMPLE LOAN', categoryId: loans },
      { textContains: 'EXAMPLE WAGES', categoryId: wages },
    ])
      seen.push(await json('/api/rules', 'POST', body))
    seen.push(await json('/api/rules/preview', 'POST', { textContains: 'EXAMPLE STORE' }))
    seen.push(await json('/api/rules/preview', 'POST', { textContains: 'EXAMPLE STORE', uncategorised: true }))
    seen.push((await json('/api/rules/rerun', 'POST', {})).status)
    for (let i = 0; i < 5; i++) {
      const job = ((await json('/api/rules/rerun/step', 'POST', {})).body as { job: { status: string; doneRows: number; changedRows: number; totalRows: number } }).job
      seen.push({ status: job.status, doneRows: job.doneRows, changedRows: job.changedRows, totalRows: job.totalRows })
      if (job.status !== 'running') break
    }
    await step('after the re-run')
    // Create Rule from a Transaction, which gives its Category to the other Uncategorised Transactions it matches.
    seen.push(await json('/api/rules/from-transaction', 'POST', { transactionId: ids[0], textContains: 'EXAMPLE STORE', direction: 'out', categoryId: groceries }))
    await step('after Create Rule')
    // An Override, then cleared.
    seen.push(await json(`/api/transactions/${ids[0]}/override`, 'PUT', { categoryId: fuel }))
    await step('with an Override')
    seen.push(await json(`/api/transactions/${ids[0]}/override`, 'PUT', { categoryId: null }))
    await step('with the Override cleared')
    return seen
  }

  it('makes every Category, Rule match, Uncategorised count and Report figure what it is without it', async () => {
    const without = await scenario(false)
    const withAkahu = await scenario(true)
    expect(withAkahu).toEqual(without)

    // The scenario did something: nothing was categorised as synced, and by the end some Transactions were and a Report has figures.
    const first = without[0] as { list: ListRow[] }
    expect(first.list.every((row) => row.categoryName === null)).toBe(true)
    const rerunSteps = without.filter((entry) => (entry as { status?: string }).status !== undefined)
    expect(rerunSteps.length).toBeGreaterThan(0)
    const last = without[without.length - 1] as { list: ListRow[]; reports: { spending: { body: unknown } } }
    expect(last.list.filter((row) => row.categoryName !== null).length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(last.reports.spending.body)).toContain('Groceries')
  })
})
