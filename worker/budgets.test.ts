import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { IN_EFFECT, MAX_BUDGET_CHANGES } from './budget-rules'
import { nzMonth } from './months'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member (the dev
// identity cookie is honoured on localhost only; Access token handling is tested in api.test.ts). All the data is made up (bank 99).
// Spending is imported the way the Admin does it, so Rules, Overrides and Transfer pairing are the real ones.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

const ids: Record<string, number> = {}
const NAMES = ['Groceries', 'Fuel', 'Eating out', 'Travel', 'Wages and salary']

type Change = { effectiveFrom: string; amountCents: number | null }
type BudgetRow = { categoryId: number; categoryName: string; amountCents: number | null; effectiveFrom: string | null; changes: Change[] }
type VsActual = { categoryId: number; categoryName: string; budgetCents: number; spentCents: number }

const budgets = async (month?: string, who: Who = 'member') => (await (await call(`/api/budgets${month ? `?month=${month}` : ''}`, { who })).json()) as { month: string; budgets: BudgetRow[] }
/** The Budget a Category has in a month: `[amount, month it began]`, or `[null, null]` while it has none. */
const budgetIn = async (name: string, month: string) => {
  const row = (await budgets(month)).budgets.find((b) => b.categoryName === name)!
  return [row.amountCents, row.effectiveFrom] as const
}
const vsActual = async (month: string, who: Who = 'member') => (await (await call(`/api/budgets/vs-actual?month=${month}`, { who })).json()) as { month: string; rows: VsActual[] }
const spentOn = async (month: string, name: string) => (await vsActual(month)).rows.find((r) => r.categoryName === name)?.spentCents

const set = (name: string, effectiveFrom: string, amountCents: number | null, who: Who = 'admin') => call(`/api/budgets/${ids[name]}`, { who, method: 'PUT', body: { effectiveFrom, amountCents } })
const mustSet = async (name: string, effectiveFrom: string, amountCents: number | null) => {
  const res = await set(name, effectiveFrom, amountCents)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}
const changeLog = async () => (await env.DB.prepare('SELECT actor, type, summary, before, after FROM change_log ORDER BY id').all()).results
const budgetRows = async () => (await env.DB.prepare('SELECT category_id, effective_from_month, amount_cents FROM budgets ORDER BY category_id, effective_from_month').all()).results

const EVERYDAY = { number: '99-9999-9999999-01', name: 'Everyday' }
const SAVINGS = { number: '99-9999-9999999-02', name: 'Savings' }
type Account = typeof EVERYDAY
let serial = 0
const row = (date: string, amountCents: number, payee: string, uniqueId = `B${++serial}`) => ({ date, uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee, bankMemo: '', amountCents })
async function importInto(account: Account, rows: unknown[]) {
  const res = await call('/api/imports/chunks', {
    method: 'POST',
    body: {
      account,
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-09-01', to: '2026-10-31', ledgerBalance: { cents: 0, date: '2026-10-31' } },
      rows,
    },
  })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
}
const rule = async (textContains: string, target: { category: string } | { transfer: true }) => {
  const res = await call('/api/rules', { method: 'POST', body: { textContains, ...('category' in target ? { categoryId: ids[target.category] } : { transfer: true }) } })
  expect(res.status).toBe(201)
}
const idOf = async (uniqueId: string) => (await env.DB.prepare('SELECT id FROM transactions WHERE bank_unique_id = ?').bind(uniqueId).first<{ id: number }>())!.id
const override = async (uniqueId: string, name: string) => {
  const res = await call(`/api/transactions/${await idOf(uniqueId)}/override`, { method: 'PUT', body: { categoryId: ids[name] } })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  serial = 0
  await env.DB.batch(['budgets', 'balance_checks', 'transactions', 'rules', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
  for (const name of NAMES) ids[name] = (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
})

describe('the Budget in a month', () => {
  it('is none before the first month a Budget is effective from', async () => {
    await mustSet('Groceries', '2026-08', 80_000)

    expect(await budgetIn('Groceries', '2026-07')).toEqual([null, null])
    expect(await budgetIn('Groceries', '2025-01')).toEqual([null, null])
  })

  it('begins exactly in the month it is effective from', async () => {
    await mustSet('Groceries', '2026-08', 80_000)

    expect(await budgetIn('Groceries', '2026-08')).toEqual([80_000, '2026-08'])
  })

  it('stays the same through the months until it changes', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Groceries', '2026-11', 90_000)

    expect(await budgetIn('Groceries', '2026-09')).toEqual([80_000, '2026-08'])
    expect(await budgetIn('Groceries', '2026-10')).toEqual([80_000, '2026-08'])
  })

  it('is the new amount from the month it changes, and after', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Groceries', '2026-11', 90_000)

    expect(await budgetIn('Groceries', '2026-11')).toEqual([90_000, '2026-11'])
    expect(await budgetIn('Groceries', '2026-12')).toEqual([90_000, '2026-11'])
    expect(await budgetIn('Groceries', '2027-03')).toEqual([90_000, '2026-11'])
    expect(await budgetIn('Groceries', '2040-01')).toEqual([90_000, '2026-11'])
  })

  it('does not depend on the order the changes were made in', async () => {
    await mustSet('Groceries', '2026-11', 90_000)
    await mustSet('Groceries', '2026-08', 80_000)

    expect(await budgetIn('Groceries', '2026-10')).toEqual([80_000, '2026-08'])
    expect(await budgetIn('Groceries', '2026-11')).toEqual([90_000, '2026-11'])
  })

  it('is none from the month it ends, and starts again when a later change gives it an amount', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Groceries', '2026-12', null)
    await mustSet('Groceries', '2027-02', 50_000)

    expect(await budgetIn('Groceries', '2026-11')).toEqual([80_000, '2026-08'])
    expect(await budgetIn('Groceries', '2026-12')).toEqual([null, '2026-12'])
    expect(await budgetIn('Groceries', '2027-01')).toEqual([null, '2026-12'])
    expect(await budgetIn('Groceries', '2027-02')).toEqual([50_000, '2027-02'])
  })

  it('belongs to one Category, and every Category in use is listed whether or not it has one', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Fuel', '2026-09', 9_000)

    const { month, budgets: all } = await budgets('2026-10')

    expect(month).toBe('2026-10')
    expect(all).toHaveLength(22)
    const names = all.map((b) => b.categoryName)
    expect(names).toEqual(names.toSorted((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))
    expect(all.filter((b) => b.amountCents !== null).map((b) => [b.categoryName, b.amountCents])).toEqual([['Fuel', 9_000], ['Groceries', 80_000]])
  })

  it('lists a Category\'s changes, oldest month first, for the Budgets page', async () => {
    await mustSet('Groceries', '2026-11', 90_000)
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Groceries', '2027-01', null)

    const groceries = (await budgets('2026-10')).budgets.find((b) => b.categoryName === 'Groceries')!

    expect(groceries.changes).toEqual([
      { effectiveFrom: '2026-08', amountCents: 80_000 },
      { effectiveFrom: '2026-11', amountCents: 90_000 },
      { effectiveFrom: '2027-01', amountCents: null },
    ])
  })

  it('is the Budget in the current NZ month when no month is asked for', async () => {
    const before = nzMonth(new Date())
    const { month } = await budgets()
    expect([before, nzMonth(new Date())]).toContain(month)
  })

  it('ignores a removed Category', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Groceries'").run()

    expect((await budgets('2026-10')).budgets.map((b) => b.categoryName)).not.toContain('Groceries')
    expect((await vsActual('2026-10')).rows).toEqual([])
  })
})

describe('setting a Budget', () => {
  it('lets the Admin set one and logs it, with the month in words and the amount in dollars', async () => {
    const res = await set('Groceries', '2026-10', 80_050)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ categoryId: ids['Groceries'], effectiveFrom: '2026-10', amountCents: 80_050, changed: true })
    expect(await budgetRows()).toEqual([{ category_id: ids['Groceries'], effective_from_month: '2026-10', amount_cents: 80_050 }])
    expect(await changeLog()).toEqual([
      {
        actor: 'admin@example.com',
        type: 'budget',
        summary: 'Set the Budget for Groceries to $800.50 a month from October 2026',
        before: '{"category":"Groceries","fromMonth":"October 2026","monthlyBudget":null}',
        after: '{"category":"Groceries","fromMonth":"October 2026","monthlyBudget":"$800.50"}',
      },
    ])
  })

  it('logs what the Budget was in that month before, even when it came from an earlier month', async () => {
    await mustSet('Groceries', '2026-08', 80_000)

    await mustSet('Groceries', '2026-11', 90_000)

    const [, change] = await changeLog()
    expect(change).toMatchObject({
      type: 'budget',
      summary: 'Changed the Budget for Groceries from $800.00 to $900.00 a month from November 2026',
      before: '{"category":"Groceries","fromMonth":"November 2026","monthlyBudget":"$800.00"}',
      after: '{"category":"Groceries","fromMonth":"November 2026","monthlyBudget":"$900.00"}',
    })
  })

  it('logs the end of a Budget', async () => {
    await mustSet('Groceries', '2026-08', 80_000)

    await mustSet('Groceries', '2026-12', null)

    const [, change] = await changeLog()
    expect(change).toMatchObject({ type: 'budget', summary: 'Ended the Budget for Groceries from December 2026', after: '{"category":"Groceries","fromMonth":"December 2026","monthlyBudget":null}' })
  })

  it('replaces the amount for a month that already has one, so a mistake can be corrected', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Groceries', '2026-08', 85_000)

    expect(await budgetRows()).toEqual([{ category_id: ids['Groceries'], effective_from_month: '2026-08', amount_cents: 85_000 }])
    expect(await budgetIn('Groceries', '2026-09')).toEqual([85_000, '2026-08'])
    expect(await changeLog()).toHaveLength(2)
  })

  it('never changes an earlier month when a Budget is set from a later one', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    const months = ['2026-08', '2026-09', '2026-10']
    const before = await Promise.all(months.map((m) => budgetIn('Groceries', m)))

    await mustSet('Groceries', '2026-11', 95_000)
    await mustSet('Groceries', '2027-06', null)

    expect(await Promise.all(months.map((m) => budgetIn('Groceries', m)))).toEqual(before)
  })

  it('changes only the months from the chosen one when it is a month already past, and none before it', async () => {
    await mustSet('Groceries', '2026-08', 80_000)

    await mustSet('Groceries', '2026-09', 70_000)

    expect(await budgetIn('Groceries', '2026-08')).toEqual([80_000, '2026-08'])
    expect(await budgetIn('Groceries', '2026-09')).toEqual([70_000, '2026-09'])
    expect(await budgetIn('Groceries', '2026-10')).toEqual([70_000, '2026-09'])
  })

  it('keeps past months\' budget vs actual as it was when a Budget changes from a later month', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await importInto(EVERYDAY, [row('2026-09-10', -30_000, 'EXAMPLE SHOP', 'S1')])
    await override('S1', 'Groceries')
    const september = await vsActual('2026-09')

    await mustSet('Groceries', '2026-10', 20_000)

    expect(await vsActual('2026-09')).toEqual(september)
    expect(september.rows).toEqual([{ categoryId: ids['Groceries'], categoryName: 'Groceries', budgetCents: 80_000, spentCents: 30_000 }])
    expect((await vsActual('2026-10')).rows).toEqual([{ categoryId: ids['Groceries'], categoryName: 'Groceries', budgetCents: 20_000, spentCents: 0 }])
  })

  describe('when nothing would change', () => {
    it('does not write or log a Budget that is already what it is set to in that month', async () => {
      await mustSet('Groceries', '2026-08', 80_000)

      const sameMonth = await set('Groceries', '2026-08', 80_000)
      const laterMonth = await set('Groceries', '2026-12', 80_000)

      for (const res of [sameMonth, laterMonth]) {
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ amountCents: 80_000, changed: false })
      }
      expect(await budgetRows()).toHaveLength(1)
      expect(await changeLog()).toHaveLength(1)
    })

    it('does not write or log the end of a Budget that is not there', async () => {
      await mustSet('Groceries', '2026-08', 80_000)

      const res = await set('Groceries', '2026-03', null)
      const other = await set('Fuel', '2026-08', null)

      for (const r of [res, other]) expect(await r.json()).toMatchObject({ amountCents: null, changed: false })
      expect(await budgetRows()).toHaveLength(1)
      expect(await changeLog()).toHaveLength(1)
    })
  })

  describe('refusing a request', () => {
    it.each([
      ['no month', { amountCents: 100 }, 'effectiveFrom'],
      ['a month that does not exist', { effectiveFrom: '2026-13', amountCents: 100 }, 'effectiveFrom'],
      ['a month written as a date', { effectiveFrom: '2026-10-01', amountCents: 100 }, 'effectiveFrom'],
      ['a month before 2000', { effectiveFrom: '1999-12', amountCents: 100 }, 'effectiveFrom'],
      ['a month after 2100', { effectiveFrom: '2101-01', amountCents: 100 }, 'effectiveFrom'],
      ['no amount', { effectiveFrom: '2026-10' }, 'amountCents'],
      ['an amount of nothing', { effectiveFrom: '2026-10', amountCents: 0 }, 'amountCents'],
      ['a negative amount', { effectiveFrom: '2026-10', amountCents: -100 }, 'amountCents'],
      ['an amount with part of a cent', { effectiveFrom: '2026-10', amountCents: 99.5 }, 'amountCents'],
      ['an amount as text', { effectiveFrom: '2026-10', amountCents: '500' }, 'amountCents'],
      ['more than a Budget can be', { effectiveFrom: '2026-10', amountCents: 100_000_000_001 }, 'amountCents'],
    ])('with %s (400), naming only the field and writing nothing', async (_why, body, field) => {
      const res = await call(`/api/budgets/${ids['Groceries']}`, { method: 'PUT', body })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
      expect(await budgetRows()).toEqual([])
      expect(await changeLog()).toEqual([])
    })

    it('for a Category that does not exist, or was removed, or is not a number (404)', async () => {
      await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-09T00:00:00.000Z' WHERE name = 'Travel'").run()
      const body = { effectiveFrom: '2026-10', amountCents: 100 }

      for (const id of ['999999', String(ids['Travel']), 'abc', '0', '-3', '1.5']) {
        const res = await call(`/api/budgets/${id}`, { method: 'PUT', body })
        expect(res.status, id).toBe(404)
      }
      expect(await budgetRows()).toEqual([])
      expect(await changeLog()).toEqual([])
    })

    it('when the database already holds as many Budget changes as it allows (409), unless the month being set already has one', async () => {
      // 22 Categories x 28 months from 2030, cut to the limit: every row sits apart from the ones set below.
      await env.DB.prepare(
        `WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 27)
         INSERT INTO budgets (category_id, effective_from_month, amount_cents)
         SELECT c.id, printf('%04d-%02d', 2030 + s.n / 12, s.n % 12 + 1), 100 FROM categories c, s WHERE c.removed_at IS NULL LIMIT ${MAX_BUDGET_CHANGES}`,
      ).run()

      const refused = await set('Groceries', '2026-10', 5_000)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({ error: 'There are too many Budget changes to add another' })
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM budgets').first<{ n: number }>())!.n).toBe(MAX_BUDGET_CHANGES)
      expect(await changeLog()).toEqual([])

      const existing = (await env.DB.prepare('SELECT category_id AS id, effective_from_month AS month FROM budgets LIMIT 1').first<{ id: number; month: string }>())!
      const replaced = await call(`/api/budgets/${existing.id}`, { method: 'PUT', body: { effectiveFrom: existing.month, amountCents: 200 } })
      expect(replaced.status).toBe(200)
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM budgets').first<{ n: number }>())!.n).toBe(MAX_BUDGET_CHANGES)
    })
  })
})

describe('who can use Budgets', () => {
  it('lets a Member read them but not set one (403), and writes nothing', async () => {
    await mustSet('Groceries', '2026-08', 80_000)

    const res = await set('Groceries', '2026-11', 1, 'member')

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Read-only' })
    expect(await budgetRows()).toHaveLength(1)
    expect(await changeLog()).toHaveLength(1)
    expect((await call('/api/budgets?month=2026-10', { who: 'member' })).status).toBe(200)
    expect((await call('/api/budgets/vs-actual?month=2026-10', { who: 'member' })).status).toBe(200)
  })

  it('refuses someone who is not signed in', async () => {
    for (const [method, path] of [['GET', '/api/budgets'], ['GET', '/api/budgets/vs-actual'], ['PUT', `/api/budgets/${ids['Groceries']}`]]) {
      const res = await exports.default.fetch(new Request(`https://app.test${path}`, { method }))
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('refuses a change from another site, or without a JSON body', async () => {
    const wrongOrigin = await exports.default.fetch(
      new Request(`${origin}/api/budgets/${ids['Groceries']}`, {
        method: 'PUT',
        headers: { Cookie: 'fernledger_dev_as=admin', Origin: 'https://other.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ effectiveFrom: '2026-10', amountCents: 100 }),
      }),
    )
    const notJson = await exports.default.fetch(
      new Request(`${origin}/api/budgets/${ids['Groceries']}`, { method: 'PUT', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' }),
    )

    expect(wrongOrigin.status).toBe(403)
    expect(notJson.status).toBe(415)
    expect(await budgetRows()).toEqual([])
  })

  it('refuses a month that is not a month when reading (400)', async () => {
    for (const path of ['/api/budgets?month=2026-13', '/api/budgets/vs-actual?month=October']) {
      const res = await call(path)
      expect(res.status, path).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'month' })
    }
  })
})

describe('budget vs actual', () => {
  it('compares each Category that has a Budget with what it spent in the month, and lists no other', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Fuel', '2026-08', 9_000)
    await mustSet('Travel', '2026-08', 50_000) // nothing spent in October
    await rule('EXAMPLE COUNTDOWN', { category: 'Groceries' })
    await importInto(EVERYDAY, [
      row('2026-10-03', -4_000, 'EXAMPLE COUNTDOWN'),
      row('2026-10-20', -1_550, 'EXAMPLE COUNTDOWN'),
      row('2026-10-05', -9_500, 'EXAMPLE BP', 'FUEL1'),
      row('2026-10-06', -700, 'EXAMPLE DAIRY'), // Uncategorised: no Budget to compare with
    ])
    await override('FUEL1', 'Fuel')

    const { month, rows } = await vsActual('2026-10')

    expect(month).toBe('2026-10')
    expect(rows).toEqual([
      { categoryId: ids['Fuel'], categoryName: 'Fuel', budgetCents: 9_000, spentCents: 9_500 },
      { categoryId: ids['Groceries'], categoryName: 'Groceries', budgetCents: 80_000, spentCents: 5_550 },
      { categoryId: ids['Travel'], categoryName: 'Travel', budgetCents: 50_000, spentCents: 0 },
    ])
  })

  it("uses the Admin's Override over a Rule, and the Rule over nothing", async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await mustSet('Eating out', '2026-08', 20_000)
    await rule('EXAMPLE COUNTDOWN', { category: 'Groceries' })
    await importInto(EVERYDAY, [row('2026-10-03', -4_000, 'EXAMPLE COUNTDOWN', 'C1'), row('2026-10-04', -2_500, 'EXAMPLE COUNTDOWN', 'C2')])
    await override('C2', 'Eating out')

    expect(await spentOn('2026-10', 'Groceries')).toBe(4_000)
    expect(await spentOn('2026-10', 'Eating out')).toBe(2_500)
  })

  it('takes a refund off what a Category spent', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await rule('EXAMPLE COUNTDOWN', { category: 'Groceries' })
    await importInto(EVERYDAY, [row('2026-10-03', -6_000, 'EXAMPLE COUNTDOWN'), row('2026-10-09', 1_500, 'EXAMPLE COUNTDOWN REFUND')])

    expect(await spentOn('2026-10', 'Groceries')).toBe(4_500)
  })

  it('counts only the Transactions dated in the month, by their NZ date', async () => {
    await mustSet('Groceries', '2026-08', 80_000)
    await rule('EXAMPLE COUNTDOWN', { category: 'Groceries' })
    await importInto(EVERYDAY, [
      row('2026-09-30', -1_000, 'EXAMPLE COUNTDOWN'),
      row('2026-10-01', -2_000, 'EXAMPLE COUNTDOWN'),
      row('2026-10-31', -4_000, 'EXAMPLE COUNTDOWN'),
      row('2026-11-01', -8_000, 'EXAMPLE COUNTDOWN'),
    ])

    expect(await spentOn('2026-09', 'Groceries')).toBe(1_000)
    expect(await spentOn('2026-10', 'Groceries')).toBe(6_000)
    expect(await spentOn('2026-11', 'Groceries')).toBe(8_000)
    expect(await spentOn('2026-12', 'Groceries')).toBe(0)
  })

  describe('leaves out Transfers', () => {
    it('both halves of a pair between two tracked Accounts, though a Rule would put them in a Category', async () => {
      await mustSet('Groceries', '2026-08', 80_000)
      await rule('EXAMPLE TFR', { category: 'Groceries' })
      await importInto(EVERYDAY, [row('2026-10-05', -50_000, 'EXAMPLE TFR TO SAVINGS', 'OUT'), row('2026-10-06', -1_200, 'EXAMPLE COUNTDOWN', 'REAL')])
      await importInto(SAVINGS, [row('2026-10-05', 50_000, 'EXAMPLE TFR FROM EVERYDAY', 'IN')])
      await override('REAL', 'Groceries')

      // Both halves matched the Rule and are in Groceries until they are paired; paired, neither is spending.
      expect(await spentOn('2026-10', 'Groceries')).toBe(1_200)
    })

    it('one a Rule marks as a Transfer, even if a Category was stored with it before the Rule changed', async () => {
      await mustSet('Groceries', '2026-08', 80_000)
      await rule('EXAMPLE SWEEP', { transfer: true })
      await importInto(EVERYDAY, [row('2026-10-05', -7_000, 'EXAMPLE SWEEP', 'SWEEP'), row('2026-10-06', -1_200, 'EXAMPLE COUNTDOWN', 'REAL')])
      await override('REAL', 'Groceries')
      // A Rule's stored result stays as it was when stored (migrations/1301_rules.sql), so it can still name a Category.
      await env.DB.prepare('UPDATE transactions SET rule_category = ? WHERE bank_unique_id = ?').bind(ids['Groceries'], 'SWEEP').run()

      expect(await spentOn('2026-10', 'Groceries')).toBe(1_200)
    })

    it('but counts a half the Admin chose a Category for, and still leaves out its matching Transaction', async () => {
      await mustSet('Groceries', '2026-08', 80_000)
      await mustSet('Fuel', '2026-08', 9_000)
      await rule('EXAMPLE TFR', { category: 'Fuel' })
      await importInto(EVERYDAY, [row('2026-10-05', -5_000, 'EXAMPLE TFR TO SAVINGS', 'OUT')])
      await importInto(SAVINGS, [row('2026-10-05', 5_000, 'EXAMPLE TFR FROM EVERYDAY', 'IN')])
      await override('OUT', 'Groceries')

      expect(await spentOn('2026-10', 'Groceries')).toBe(5_000)
      expect(await spentOn('2026-10', 'Fuel')).toBe(0) // the other half is still a Transfer, though its Rule names Fuel
    })
  })

  describe('has no carry-over', () => {
    it('does not add last month\'s unspent Budget to this month\'s', async () => {
      await mustSet('Groceries', '2026-08', 50_000)
      await rule('EXAMPLE COUNTDOWN', { category: 'Groceries' })
      await importInto(EVERYDAY, [row('2026-09-10', -20_000, 'EXAMPLE COUNTDOWN')])

      expect((await vsActual('2026-09')).rows[0]).toMatchObject({ budgetCents: 50_000, spentCents: 20_000 }) // $300 unspent
      expect((await vsActual('2026-10')).rows[0]).toMatchObject({ budgetCents: 50_000, spentCents: 0 })
    })

    it('does not take last month\'s overspending off this month\'s Budget, nor count it in this month\'s spending', async () => {
      await mustSet('Groceries', '2026-08', 50_000)
      await rule('EXAMPLE COUNTDOWN', { category: 'Groceries' })
      await importInto(EVERYDAY, [row('2026-09-10', -70_000, 'EXAMPLE COUNTDOWN'), row('2026-10-02', -10_000, 'EXAMPLE COUNTDOWN')])

      expect((await vsActual('2026-09')).rows[0]).toMatchObject({ budgetCents: 50_000, spentCents: 70_000 }) // $200 over
      expect((await vsActual('2026-10')).rows[0]).toMatchObject({ budgetCents: 50_000, spentCents: 10_000 })
    })
  })

  it('shows the month it is asked about, and this NZ month when none is given', async () => {
    const before = nzMonth(new Date())
    const res = await call('/api/budgets/vs-actual')
    const { month } = (await res.json()) as { month: string }
    expect([before, nzMonth(new Date())]).toContain(month)
  })
})

describe('what a request reads from D1', () => {
  // ADR 0004: D1 Free bills rows read (5 million a day). The Budget in a month is one seek on the primary key for each
  // Category, however long its history is, and the whole history is read only by the Budgets page, which is bounded.
  it('looks up each Category\'s Budget with a seek, so a long history costs no more than a short one', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 23)
       INSERT INTO budgets (category_id, effective_from_month, amount_cents)
       SELECT c.id, printf('%04d-%02d', 2024 + s.n / 12, s.n % 12 + 1), 100 FROM categories c, s WHERE c.removed_at IS NULL`,
    ).run()
    const categories = (await env.DB.prepare('SELECT id FROM categories WHERE removed_at IS NULL').all<{ id: number }>()).results

    const result = await env.DB.prepare(IN_EFFECT).bind('2025-06').all<{ effectiveFrom: string }>()

    expect(result.results).toHaveLength(categories.length)
    expect(result.results.every((r) => r.effectiveFrom === '2025-06')).toBe(true)
    // Per Category: its row, one seek to the latest month and the Budget row itself (66 for 22 Categories when measured).
    expect((result.meta as { rows_read: number }).rows_read).toBeLessThanOrEqual(categories.length * 4)
  })
})
