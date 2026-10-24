import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'
import { REPORTS } from '../src/lib/reports'
import { app } from './app'
import worker from './index'
import { KEPT_LIMIT, keepBody, NOT_KEPT, REPORT_IDS, requestedChoices, SHAPES, type ReportId } from './kept-reports'
import { callAsAdminWith, callWhileInterrupted, meteredDb } from './test-support'

afterEach(() => vi.restoreAllMocks())

// Seam 1: the list of kept Reports, through the Worker's exported handler as the local-development Admin or a read-only Member. A kept Report is a Report's CHOICES (which
// Report, the dates, the Account or Category), never its figures. Only the Admin makes Reports: the Admin showing one keeps it, and a Member can read only a Report that is kept.
const origin = 'http://localhost:5173'

type Who = 'admin' | 'member'

/** A request as the Admin or a Member, or (`who: null`) from somewhere that is not localhost, so with no dev identity and no Access token: not signed in. */
async function call(path: string, opts: { who?: Who | null; method?: string; body?: unknown } = {}) {
  const from = opts.who === null ? 'https://app.test' : origin
  const headers: Record<string, string> = opts.who === null ? {} : { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: from, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${from}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

type Kept = {
  id: number
  report: ReportId
  accountId: number | null
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  categoryRemoved: boolean
  from: string | null
  to: string
  lastMadeAt: string
}
const list = async (who: Who = 'member'): Promise<Kept[]> => {
  const res = await call('/api/kept-reports', { who })
  expect(res.status).toBe(200)
  return res.json()
}
const keep = (body: unknown, who: Who = 'admin') => call('/api/kept-reports', { who, method: 'POST', body })
const forget = (id: number | string, who: Who = 'admin', body: unknown = {}) => call(`/api/kept-reports/${id}`, { who, method: 'DELETE', body })
const rows = async () => (await env.DB.prepare('SELECT * FROM kept_reports ORDER BY id').all()).results
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, type, before, after FROM change_log ORDER BY id').all()).results

let savings = 0
let cheque = 0
let loanId = 0

beforeEach(async () => {
  await env.DB.batch(['kept_reports', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  savings = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example savings') RETURNING id").first<{ id: number }>())!.id
  cheque = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-98', 'Example cheque') RETURNING id").first<{ id: number }>())!.id
  await env.DB.prepare("DELETE FROM categories WHERE name = 'Loan – Alice'").run()
  loanId = (await env.DB.prepare("INSERT INTO categories (name, kind) VALUES ('Loan – Alice', 'loans') RETURNING id").first<{ id: number }>())!.id
})

/** `n` different days, so `n` different choices of a Report that takes only dates. */
const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2001, 0, 1 + i)).toISOString().slice(0, 10))
const insertKept = (to: string, lastMadeAt: string) =>
  env.DB.prepare('INSERT INTO kept_reports (report, from_date, to_date, last_made_at, made_by) VALUES (?, ?, ?, ?, ?)').bind('budget-vs-actual', '2000-01-01', to, lastMadeAt, 'admin@example.com')

/** Puts a kept Report in the list directly, as the Admin's showing it would have. */
async function seedKept(over: Partial<{ report: string; accountId: number | null; categoryId: number | null; from: string | null; to: string; lastMadeAt: string; madeBy: string }> = {}) {
  const k = { report: 'spending', accountId: null, categoryId: null, from: '2026-10-01', to: '2026-10-31', lastMadeAt: '2026-10-16T01:00:00.000Z', madeBy: 'admin@example.com', ...over }
  return (
    await env.DB.prepare('INSERT INTO kept_reports (report, account_id, category_id, from_date, to_date, last_made_at, made_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(k.report, k.accountId, k.categoryId, k.from, k.to, k.lastMadeAt, k.madeBy)
      .first<{ id: number }>()
  )!.id
}

const SPENDING = { report: 'spending', from: '2026-10-01', to: '2026-10-31' }

describe('the list', () => {
  it('is empty before any Report is made, for a Member to read', async () => {
    expect(await list('member')).toEqual([])
    expect(await list('admin')).toEqual([])
  })

  it('refuses someone who is not signed in', async () => {
    expect((await call('/api/kept-reports', { who: null })).status).toBe(401)
  })

  it('has the newest first, each with the Account or Category named, and says when a Category has been removed', async () => {
    const older = await seedKept({ report: 'transactions', accountId: savings, lastMadeAt: '2026-10-14T01:00:00.000Z' })
    const loans = await seedKept({ report: 'loans', categoryId: loanId, from: null, lastMadeAt: '2026-10-15T01:00:00.000Z' })
    const newest = await seedKept({ report: 'budget-vs-actual', lastMadeAt: '2026-10-16T01:00:00.000Z', madeBy: 'other.admin@example.com' })

    const kept = await list('member')

    expect(kept.map((k) => k.id)).toEqual([newest, loans, older])
    // Exactly these: the list does not say who made a Report, though this one was made by another Admin.
    expect(kept[0]).toEqual({
      id: newest, report: 'budget-vs-actual', accountId: null, accountName: null, categoryId: null, categoryName: null, categoryRemoved: false,
      from: '2026-10-01', to: '2026-10-31', lastMadeAt: '2026-10-16T01:00:00.000Z',
    })
    expect(kept[1]).toMatchObject({ report: 'loans', categoryId: loanId, categoryName: 'Loan – Alice', categoryRemoved: false, from: null })
    expect(kept[2]).toMatchObject({ report: 'transactions', accountId: savings, accountName: 'Example savings' })

    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-16T02:00:00.000Z' WHERE id = ?").bind(loanId).run()
    expect((await list()).find((k) => k.id === loans)).toMatchObject({ categoryName: 'Loan – Alice', categoryRemoved: true })
  })

  it('breaks a tie in the time by the ID, so the order is the same each time', async () => {
    const first = await seedKept({ to: '2026-10-30' })
    const second = await seedKept({ to: '2026-10-31' })
    expect((await list()).map((k) => k.id)).toEqual([second, first])
  })

  it('is one small query: a few rows read for each kept Report, a full list of KEPT_LIMIT included', async () => {
    const inserts = days(KEPT_LIMIT).map((to, i) =>
      i % 2
        ? env.DB.prepare('INSERT INTO kept_reports (report, account_id, from_date, to_date, made_by) VALUES (?, ?, ?, ?, ?)').bind('transactions', i % 4 === 1 ? savings : cheque, '2000-01-01', to, 'admin@example.com')
        : env.DB.prepare('INSERT INTO kept_reports (report, category_id, to_date, made_by) VALUES (?, ?, ?, ?)').bind('loans', loanId, to, 'admin@example.com'),
    )
    await env.DB.batch(inserts)
    const { db, usage } = meteredDb()

    const res = await callAsAdminWith(db, '/api/kept-reports', 'GET', undefined)

    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(KEPT_LIMIT)
    expect(usage.rowsRead).toBeLessThanOrEqual(3 * KEPT_LIMIT) // measured: 2 * KEPT_LIMIT, the index entry and the row of each
  })

  it('lists at most KEPT_LIMIT, the newest', async () => {
    const all = days(KEPT_LIMIT + 5)
    await env.DB.batch(all.map((to, i) => insertKept(to, `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`)))

    const kept = await list()

    expect(kept).toHaveLength(KEPT_LIMIT)
    expect(kept[0]!.to).toBe(all.at(-1)) // the last made
    expect(kept.map((k) => k.to)).not.toContain(all[0]) // the first made is not
  })
})

describe('showing a Report as the Admin', () => {
  it('keeps its choices, as a new row, and writes a Change Log entry', async () => {
    const res = await keep({ ...SPENDING, accountId: savings })

    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    expect(await rows()).toEqual([
      { id, report: 'spending', account_id: savings, category_id: null, from_date: '2026-10-01', to_date: '2026-10-31', last_made_at: expect.stringMatching(/^2\d{3}-\d\d-\d\dT[\d:.]+Z$/), made_by: 'admin@example.com' },
    ])
    expect(await changeLog()).toEqual([
      {
        summary: 'Kept the Spending by Category Report for Example savings, 2026-10-01 to 2026-10-31',
        actor: 'admin@example.com',
        type: 'report',
        before: null,
        after: '{"report":"Spending by Category","account":"Example savings","from":"2026-10-01","to":"2026-10-31"}',
      },
    ])
  })

  it('keeps every Account as no Account, and a Loans Report with no start date as no start date', async () => {
    await keep(SPENDING)
    await keep({ report: 'loans', to: '2026-10-31' })
    await keep({ report: 'loans', categoryId: loanId, from: '2026-01-01', to: '2026-10-31' })

    const choices = (await list()).map((k) => [k.report, k.accountId, k.categoryId, k.from])
    expect(choices).toHaveLength(3)
    expect(choices).toEqual(expect.arrayContaining([['loans', null, loanId, '2026-01-01'], ['loans', null, null, null], ['spending', null, null, '2026-10-01']]))
    expect((await changeLog()).map((e) => e.summary)).toEqual([
      'Kept the Spending by Category Report for all Accounts, 2026-10-01 to 2026-10-31',
      'Kept the Loans Report for all loans, from the first Transaction to 2026-10-31',
      'Kept the Loans Report for Loan – Alice, 2026-01-01 to 2026-10-31',
    ])
  })

  it('does not add a row for the same choices again: it updates when the Report was last made, and who made it', async () => {
    const first = (await (await keep({ ...SPENDING, accountId: savings })).json()) as { id: number }
    await env.DB.prepare("UPDATE kept_reports SET last_made_at = '2020-01-01T00:00:00.000Z', made_by = 'someone.before@example.com'").run()

    const again = await keep({ ...SPENDING, accountId: savings })

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ id: first.id })
    const kept = await list()
    expect(kept).toHaveLength(1)
    expect(kept[0]!.id).toBe(first.id)
    expect(kept[0]!.lastMadeAt > '2025-01-01').toBe(true)
    expect((await rows())[0]).toMatchObject({ made_by: 'admin@example.com' }) // still recorded, as the column is not null; the list does not send it
    expect(await changeLog()).toHaveLength(1) // only the Report being kept is a change; showing it again is not
  })

  it('treats no Account twice, and no start date twice, as the same choices', async () => {
    await keep(SPENDING)
    await keep(SPENDING)
    await keep({ report: 'loans', to: '2026-10-31' })
    await keep({ report: 'loans', to: '2026-10-31' })

    expect(await list()).toHaveLength(2)
  })

  it('keeps Reports that differ in any one choice as separate rows', async () => {
    const base = { ...SPENDING, accountId: savings }
    for (const body of [base, { ...base, accountId: cheque }, { ...base, from: '2026-10-02' }, { ...base, to: '2026-10-30' }, { ...base, report: 'income-vs-spending' }, { ...base, accountId: undefined }]) {
      expect((await keep(body)).status).toBe(201)
    }
    expect(await list()).toHaveLength(6)
  })

  it('refuses a Member, keeps nothing and logs nothing', async () => {
    const res = await keep({ ...SPENDING, accountId: savings }, 'member')

    expect(res.status).toBe(403)
    expect(await rows()).toEqual([])
    expect(await changeLog()).toEqual([])
  })

  it('refuses choices a Report does not have, or does not have all of, and names the field and not the value', async () => {
    const refuse = async (body: unknown, field: string) => {
      const res = await keep(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
    }
    await refuse({ ...SPENDING, report: 'nonsense' }, 'report')
    await refuse({ ...SPENDING, extra: 1 }, '')
    await refuse({ report: 'spending', to: '2026-10-31' }, 'from') // a start date is needed, but by the Loans Report
    await refuse({ ...SPENDING, to: '2026-09-30' }, 'to') // the wrong way round
    await refuse({ ...SPENDING, to: '2026-02-30' }, 'to')
    await refuse({ ...SPENDING, from: '1999-12-31' }, 'from')
    await refuse({ ...SPENDING, accountId: 0 }, 'accountId')
    await refuse({ ...SPENDING, accountId: '3' }, 'accountId')
    await refuse({ ...SPENDING, categoryId: loanId }, 'categoryId') // only the Loans Report has a Category
    await refuse({ report: 'loans', to: '2026-10-31', accountId: savings }, 'accountId') // and it has no Account
    await refuse({ report: 'budget-vs-actual', from: '2026-10-01', to: '2026-10-31', accountId: savings }, 'accountId') // nor does Budget vs actual
    expect(await rows()).toEqual([])
    expect(await changeLog()).toEqual([])
  })

  it('refuses an Account or Category that is not there (404), and keeps nothing', async () => {
    expect((await keep({ ...SPENDING, accountId: savings + 1000 })).status).toBe(404)
    expect((await keep({ report: 'loans', to: '2026-10-31', categoryId: loanId + 1000 })).status).toBe(404)
    expect(await rows()).toEqual([])
    expect(await changeLog()).toEqual([])
  })

  it('refuses a Category that is not a live Loans one (404): a Spending or Income Category, or a Loans one that has been removed', async () => {
    const spendingId = (await env.DB.prepare("INSERT INTO categories (name, kind) VALUES ('Groceries – kept', 'spending') RETURNING id").first<{ id: number }>())!.id
    const incomeId = (await env.DB.prepare("INSERT INTO categories (name, kind) VALUES ('Wages – kept', 'income') RETURNING id").first<{ id: number }>())!.id
    try {
      for (const categoryId of [spendingId, incomeId]) {
        const res = await keep({ report: 'loans', to: '2026-10-31', categoryId })
        expect(res.status, String(categoryId)).toBe(404)
        expect(await res.json()).toEqual({ error: 'Not found', field: 'categoryId' })
      }
      await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-16T02:00:00.000Z' WHERE id = ?").bind(loanId).run()
      expect((await keep({ report: 'loans', to: '2026-10-31', categoryId: loanId })).status).toBe(404)
      expect(await rows()).toEqual([])
      expect(await changeLog()).toEqual([])
    } finally {
      await env.DB.prepare('DELETE FROM categories WHERE id IN (?, ?)').bind(spendingId, incomeId).run()
    }
  })

  it('keeps no more than KEPT_LIMIT: a new Report drops the oldest made, and the Change Log has an entry for the drop that names it', async () => {
    await env.DB.batch(days(KEPT_LIMIT - 1).map((to) => insertKept(to, '2026-10-01T00:00:00.000Z')))
    const oldest = await seedKept({ report: 'budget-vs-actual', from: '2000-01-01', lastMadeAt: '2020-01-01T00:00:00.000Z', to: '2026-12-31' }) // the last of the limit, and made longest ago
    expect(await rows()).toHaveLength(KEPT_LIMIT)

    expect((await keep({ ...SPENDING, accountId: savings })).status).toBe(201)

    const all = await rows()
    expect(all).toHaveLength(KEPT_LIMIT)
    expect(all.map((r) => r.id)).not.toContain(oldest)
    expect(all.some((r) => r.report === 'spending')).toBe(true) // the new one is kept
    expect(await changeLog()).toEqual([
      {
        summary: `Dropped the oldest kept Report to stay within ${KEPT_LIMIT}: the Budget vs actual Report for all Accounts, 2000-01-01 to 2026-12-31`,
        actor: 'admin@example.com',
        type: 'report',
        before: '{"report":"Budget vs actual","account":"all Accounts","from":"2000-01-01","to":"2026-12-31"}',
        after: null,
      },
      {
        summary: 'Kept the Spending by Category Report for Example savings, 2026-10-01 to 2026-10-31',
        actor: 'admin@example.com',
        type: 'report',
        before: null,
        after: '{"report":"Spending by Category","account":"Example savings","from":"2026-10-01","to":"2026-10-31"}',
      },
    ])
  })

  it('reads the list twice, two index walks, when a new Report pushes one over the limit: to name what is over, and to check in the batch that it still is. About 2 * KEPT_LIMIT rows read', async () => {
    await env.DB.batch(days(KEPT_LIMIT).map((to) => insertKept(to, '2026-10-01T00:00:00.000Z')))
    const { db, usage } = meteredDb()

    const res = await callAsAdminWith(db, '/api/kept-reports', 'POST', SPENDING)

    expect(res.status).toBe(201)
    expect(usage.rowsRead).toBeLessThanOrEqual(2 * KEPT_LIMIT + 50) // measured: 425 (it was 218 with the first walk alone)
  })

  it('drops every Report over the limit, and names them all in one entry, if the list somehow holds more than one over', async () => {
    await env.DB.batch(days(KEPT_LIMIT - 1).map((to) => insertKept(to, '2026-10-01T00:00:00.000Z')))
    await seedKept({ report: 'budget-vs-actual', from: '2000-01-01', lastMadeAt: '2020-01-01T00:00:00.000Z', to: '2026-12-31' })
    await seedKept({ report: 'budget-vs-actual', from: '2000-01-01', lastMadeAt: '2019-01-01T00:00:00.000Z', to: '2026-12-30' })
    expect(await rows()).toHaveLength(KEPT_LIMIT + 1)

    expect((await keep(SPENDING)).status).toBe(201)

    expect(await rows()).toHaveLength(KEPT_LIMIT)
    const log = await changeLog()
    expect(log).toHaveLength(2)
    expect(log[0]!.summary).toBe(`Dropped the oldest kept Reports to stay within ${KEPT_LIMIT}: the Budget vs actual Report for all Accounts, 2000-01-01 to 2026-12-31 and 1 more`)
    expect(JSON.parse(log[0]!.before as string)).toHaveLength(2)
    expect(log[1]!.summary).toBe('Kept the Spending by Category Report for all Accounts, 2026-10-01 to 2026-10-31')
    expect(log[1]!.before).toBeNull()
  })

  it('drops nothing, and names nothing, when the list was not over the limit', async () => {
    await env.DB.batch(days(KEPT_LIMIT - 1).map((to) => insertKept(to, '2026-10-01T00:00:00.000Z')))
    await keep(SPENDING)
    expect(await rows()).toHaveLength(KEPT_LIMIT)
    expect(await changeLog()).toEqual([expect.objectContaining({ summary: 'Kept the Spending by Category Report for all Accounts, 2026-10-01 to 2026-10-31', before: null })])
  })

  it('drops nothing when it only shows a Report again, even with the list at the limit', async () => {
    await keep(SPENDING)
    await env.DB.batch(days(KEPT_LIMIT - 1).map((to) => insertKept(to, '2020-01-01T00:00:00.000Z')))
    expect(await rows()).toHaveLength(KEPT_LIMIT)

    expect((await keep(SPENDING)).status).toBe(200)

    expect(await rows()).toHaveLength(KEPT_LIMIT)
    expect(await changeLog()).toHaveLength(1)
  })
})

describe('deleting a kept Report', () => {
  it('removes it, as the Admin, and logs it with what it was', async () => {
    const keptId = await seedKept({ report: 'transactions', accountId: savings })
    const other = await seedKept({ report: 'spending' })

    const res = await forget(keptId)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: keptId })
    expect((await rows()).map((r) => r.id)).toEqual([other])
    expect(await changeLog()).toEqual([
      {
        summary: 'Removed the kept Transaction listing Report for Example savings, 2026-10-01 to 2026-10-31',
        actor: 'admin@example.com',
        type: 'report',
        before: '{"report":"Transaction listing","account":"Example savings","from":"2026-10-01","to":"2026-10-31"}',
        after: null,
      },
    ])
  })

  it('refuses a Member, and leaves the row and the Change Log as they were', async () => {
    const keptId = await seedKept()

    const res = await forget(keptId, 'member')

    expect(res.status).toBe(403)
    expect((await rows()).map((r) => r.id)).toEqual([keptId])
    expect(await changeLog()).toEqual([])
  })

  it('answers 404 for one that is not there, and for an ID written any other way, and writes nothing', async () => {
    const keptId = await seedKept()
    for (const id of [keptId + 1, 0, '1e1', '010', '-1', 'abc']) expect((await forget(id)).status, String(id)).toBe(404)
    expect(await rows()).toHaveLength(1)
    expect(await changeLog()).toEqual([])
  })

  it('answers 404 the second time, with no second entry', async () => {
    const keptId = await seedKept()
    expect((await forget(keptId)).status).toBe(200)
    expect((await forget(keptId)).status).toBe(404)
    expect(await changeLog()).toHaveLength(1)
  })

  it('refuses a body with anything in it', async () => {
    const keptId = await seedKept()
    const res = await forget(keptId, 'admin', { extra: true })
    expect(res.status).toBe(400)
    expect(await rows()).toHaveLength(1)
  })

  it('is then not in the list, so it is a new row if the Admin shows that Report again', async () => {
    const keptId = await seedKept({ accountId: savings })
    await forget(keptId)
    const again = (await (await keep({ ...SPENDING, accountId: savings })).json()) as { id: number }
    expect(again.id).not.toBe(keptId)
  })
})

describe('when another request lands between the read and the write', () => {
  it("a delete of a kept Report that the other request deleted first answers 404, and the Change Log has only the other request's entry", async () => {
    const keptId = await seedKept({ report: 'transactions', accountId: savings })

    const res = await callWhileInterrupted(`/api/kept-reports/${keptId}`, 'DELETE', {}, () => forget(keptId))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(await rows()).toEqual([])
    expect(await changeLog()).toEqual([expect.objectContaining({ summary: 'Removed the kept Transaction listing Report for Example savings, 2026-10-01 to 2026-10-31' })])
  })

  it('a keep of choices that the other request kept first is the same row, shown again, and the Change Log has the one entry', async () => {
    let other: { id: number } | undefined
    const res = await callWhileInterrupted('/api/kept-reports', 'POST', SPENDING, async () => void (other = (await (await keep(SPENDING)).json()) as { id: number }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: other!.id })
    expect(await rows()).toHaveLength(1)
    expect(await changeLog()).toHaveLength(1)
  })

  it('a keep that finds the Report already kept drops nothing, and so writes no entry that is missing a dropped Report', async () => {
    await env.DB.batch(days(KEPT_LIMIT - 1).map((to) => insertKept(to, '2026-10-01T00:00:00.000Z')))
    const oldest = await seedKept({ report: 'budget-vs-actual', from: '2000-01-01', lastMadeAt: '2020-01-01T00:00:00.000Z', to: '2026-12-31' })
    expect(await rows()).toHaveLength(KEPT_LIMIT)

    // The other request added these choices without trimming the list, so this one's Report is not new, and the Report it chose to drop is not dropped.
    const res = await callWhileInterrupted('/api/kept-reports', 'POST', SPENDING, async () => void (await seedKept({ ...SPENDING, lastMadeAt: '2026-10-16T01:00:00.000Z' })))

    expect(res.status).toBe(200)
    expect((await rows()).map((r) => r.id)).toContain(oldest)
    expect(await rows()).toHaveLength(KEPT_LIMIT + 1)
    expect(await changeLog()).toEqual([])
  })

  /** How many Reports the Change Log says were dropped, counting each one an entry names. Each of them must be a Report that is no longer in the list. */
  const droppedInLog = async () =>
    (await changeLog()).reduce((n, entry) => {
      if (!/dropped/i.test(entry.summary as string)) return n
      const before = JSON.parse(entry.before as string)
      return n + (Array.isArray(before) ? before.length : 1)
    }, 0)
  const OLDEST = { report: 'budget-vs-actual', from: '2000-01-01', to: '2026-12-31' } // the choices of the oldest Report `seedFullList` keeps
  /** The list at the limit, with the Report made longest ago the last of it: 199 made on one day, and this. Returns their IDs, the oldest last. */
  const seedFullList = async () => {
    await env.DB.batch(days(KEPT_LIMIT - 1).map((to) => insertKept(to, '2026-10-01T00:00:00.000Z')))
    await seedKept({ ...OLDEST, lastMadeAt: '2020-01-01T00:00:00.000Z' })
    const ids = (await rows()).map((r) => r.id as number)
    expect(ids).toHaveLength(KEPT_LIMIT)
    return ids
  }

  it('two new Reports at the limit that both read the same Report as over it drop it once, and the Change Log names it once; the next new Report brings the list back', async () => {
    const ids = await seedFullList()
    const oldest = ids.at(-1)!

    // The second keep has read that the oldest is over the limit when the first keeps its Report, which drops it. The second finds nothing of what it read to drop.
    const res = await callWhileInterrupted('/api/kept-reports', 'POST', { ...SPENDING, accountId: cheque }, async () => void (await keep({ ...SPENDING, accountId: savings })))

    expect(res.status).toBe(201)
    expect((await rows()).map((r) => r.id)).toEqual([...ids.slice(0, -1), expect.any(Number), expect.any(Number)]) // both are kept, and only the oldest is gone
    expect((await rows()).map((r) => r.id)).not.toContain(oldest)
    expect(await droppedInLog()).toBe(1) // the one Report that was dropped is named once, not by the second keep too
    expect((await changeLog()).map((e) => e.summary)).toEqual([
      `Dropped the oldest kept Report to stay within ${KEPT_LIMIT}: the Budget vs actual Report for all Accounts, 2000-01-01 to 2026-12-31`,
      'Kept the Spending by Category Report for Example savings, 2026-10-01 to 2026-10-31',
      'Kept the Spending by Category Report for Example cheque, 2026-10-01 to 2026-10-31',
    ])

    // The list is one over the limit now (the second keep dropped nothing). The next new Report reads everything over the limit, drops it, and names it.
    expect(await rows()).toHaveLength(KEPT_LIMIT + 1)
    expect((await keep(SPENDING)).status).toBe(201)
    expect(await rows()).toHaveLength(KEPT_LIMIT)
    expect((await rows()).map((r) => r.id)).not.toContain(ids[0]) // the two made longest ago of those left
    expect((await rows()).map((r) => r.id)).not.toContain(ids[1])
    expect(await droppedInLog()).toBe(3) // 200 + 3 kept - 200 left
    expect(await changeLog()).toHaveLength(5)
  })

  it('a Report that is made again after a keep read it as over the limit is not dropped by that keep, and the next new Report finds what is over then', async () => {
    const ids = await seedFullList()
    const oldest = ids.at(-1)!

    // The Admin shows the oldest Report again between the read and the batch, so it is the newest now and the Report to drop is another.
    const res = await callWhileInterrupted('/api/kept-reports', 'POST', { ...SPENDING, accountId: savings }, async () => {
      expect((await keep(OLDEST)).status).toBe(200)
    })

    expect(res.status).toBe(201)
    const left = await rows()
    expect(left.map((r) => r.id)).toContain(oldest)
    expect(left.find((r) => r.id === oldest)!.last_made_at).not.toBe('2020-01-01T00:00:00.000Z')
    expect(left).toHaveLength(KEPT_LIMIT + 1) // nothing was dropped: the Report it read is not over the limit any more
    expect(await droppedInLog()).toBe(0)
    expect((await changeLog()).map((e) => e.summary)).toEqual(['Kept the Spending by Category Report for Example savings, 2026-10-01 to 2026-10-31']) // showing the oldest again is not a change

    expect((await keep(SPENDING)).status).toBe(201)
    const healed = await rows()
    expect(healed).toHaveLength(KEPT_LIMIT)
    expect(healed.map((r) => r.id)).toContain(oldest) // it is still there: what is dropped is the two that are over now
    expect(healed.map((r) => r.id)).not.toContain(ids[0])
    expect(healed.map((r) => r.id)).not.toContain(ids[1])
    expect(await droppedInLog()).toBe(2)
  })

  it('a keep that read two Reports as over the limit drops both or neither, so its entry never names one that was not dropped', async () => {
    const ids = await seedFullList()
    const second = await seedKept({ report: 'budget-vs-actual', from: '2000-01-01', lastMadeAt: '2019-01-01T00:00:00.000Z', to: '2026-12-30' }) // the list is one over the limit
    expect(await rows()).toHaveLength(KEPT_LIMIT + 1)

    // The Admin shows the second of the two again after the read, so it is no longer over the limit while the oldest still is.
    const res = await callWhileInterrupted('/api/kept-reports', 'POST', { ...SPENDING, accountId: savings }, async () => {
      expect((await keep({ ...OLDEST, to: '2026-12-30' })).status).toBe(200)
    })

    expect(res.status).toBe(201)
    expect((await rows()).map((r) => r.id)).toContain(ids.at(-1)) // the oldest is not dropped either
    expect((await rows()).map((r) => r.id)).toContain(second)
    expect(await rows()).toHaveLength(KEPT_LIMIT + 2)
    expect(await droppedInLog()).toBe(0)

    expect((await keep(SPENDING)).status).toBe(201) // the next new Report drops what is over then: three
    expect(await rows()).toHaveLength(KEPT_LIMIT)
    expect(await droppedInLog()).toBe(3)
  })
})

describe('what the six Reports take', () => {
  it('agrees with the Reports page: the same six, named the same, with the same choices', () => {
    const slug = (to: string) => to.replace('/reports/', '')
    expect(Object.values(REPORTS).map((r) => slug(r.to))).toEqual([...REPORT_IDS])
    for (const r of Object.values(REPORTS)) {
      const shape = SHAPES[slug(r.to) as ReportId]
      expect(shape.name).toBe(r.name)
      const choices = r.choices as readonly string[]
      expect(choices.includes('account')).toBe(shape.account !== false)
      expect(choices.includes('category')).toBe(shape.category)
    }
  })

  it('has a Report for each of the routes under /api/reports, so a route added there is not open to a Member until the Reports are told of it', () => {
    const routes = new Set(app.routes.filter((r) => r.path.startsWith('/api/reports/') && r.path !== '/api/reports/*').map((r) => r.path.replace('/api/reports/', '')))
    expect([...routes].sort()).toEqual([...REPORT_IDS].sort())
  })

  it('parses the choices a request keeps', () => {
    const parse = (body: unknown) => z.safeParse(keepBody, body)
    expect(parse({ report: 'spending', accountId: 3, from: '2026-10-01', to: '2026-10-31' }).success).toBe(true)
    expect(parse({ report: 'loans', to: '2026-10-31' }).success).toBe(true)
    expect(parse({ report: 'loans', categoryId: 7, from: '2026-10-01', to: '2026-10-31' }).success).toBe(true)
    expect(parse({ report: 'budget-vs-actual', from: '2026-10-01', to: '2026-10-31' }).success).toBe(true)
    expect(parse({ report: 'loans', from: '2026-11-01', to: '2026-10-31' }).success).toBe(false)
    expect(parse({ report: 'spending', to: '2026-10-31' }).success).toBe(false)
    expect(parse({ report: 'spending', accountId: 1.5, from: '2026-10-01', to: '2026-10-31' }).success).toBe(false)
    expect(parse({ report: 'spending', from: '2026-10-01', to: '2026-10-31', categoryId: 2 }).success).toBe(false)
    expect(parse({ report: 'transactions', from: '2026-10-01', to: '2026-10-31', accountId: null }).success).toBe(false)
  })

  describe('reads the choices a request makes', () => {
    const choices = (report: ReportId, query: string) => requestedChoices(report, new URLSearchParams(query))
    it('as the Account, Category and dates in its query string', () => {
      expect(choices('spending', 'accountId=3&from=2026-10-01&to=2026-10-31')).toEqual({ accountId: 3, categoryId: null, from: '2026-10-01', to: '2026-10-31' })
      expect(choices('spending', 'from=2026-10-01&to=2026-10-31')).toEqual({ accountId: null, categoryId: null, from: '2026-10-01', to: '2026-10-31' })
      expect(choices('loans', 'categoryId=7&to=2026-10-31')).toEqual({ accountId: null, categoryId: 7, from: null, to: '2026-10-31' })
      expect(choices('transactions', 'accountId=3&from=2026-10-01&to=2026-10-31&limit=200&after=abc')).toMatchObject({ accountId: 3, from: '2026-10-01' })
    })
    it('leaving out an Account that a Report does not have, and a Category that it does not have', () => {
      expect(choices('budget-vs-actual', 'accountId=3&categoryId=2&from=2026-10-01&to=2026-10-31')).toEqual({ accountId: null, categoryId: null, from: '2026-10-01', to: '2026-10-31' })
      expect(choices('loans', 'accountId=3&categoryId=7&to=2026-10-31')).toEqual({ accountId: null, categoryId: 7, from: null, to: '2026-10-31' })
    })
    it('as nothing when a choice is missing, written twice or is not a whole number or a real date', () => {
      expect(choices('spending', 'from=2026-10-01')).toBeNull()
      expect(choices('spending', 'from=2026-10-01&from=2026-10-02&to=2026-10-31')).toBeNull()
      expect(choices('spending', 'accountId=1e1&from=2026-10-01&to=2026-10-31')).toBeNull()
      expect(choices('spending', 'accountId=3&accountId=4&from=2026-10-01&to=2026-10-31')).toBeNull()
      expect(choices('spending', 'from=2026-02-30&to=2026-10-31')).toBeNull()
      expect(choices('spending', 'from=&to=2026-10-31')).toBeNull()
    })
  })
})

describe('a Member reading a Report', () => {
  const API: Record<ReportId, (a: number, from: string, to: string, extra?: string) => string> = {
    spending: (a, from, to) => `/api/reports/spending?accountId=${a}&from=${from}&to=${to}`,
    'income-vs-spending': (a, from, to) => `/api/reports/income-vs-spending?accountId=${a}&from=${from}&to=${to}`,
    loans: (_a, from, to, extra = '') => `/api/reports/loans?categoryId=${loanId}&from=${from}&to=${to}${extra}`,
    transactions: (a, from, to) => `/api/reports/transactions?accountId=${a}&from=${from}&to=${to}`,
    balances: (a, from, to) => `/api/reports/balances?accountId=${a}&from=${from}&to=${to}`,
    'budget-vs-actual': (_a, from, to) => `/api/reports/budget-vs-actual?from=${from}&to=${to}`,
  }
  const read = (path: string, who: Who | null = 'member') => call(path, { who })

  it('is refused every Report that has not been kept, and the refusal names no choice', async () => {
    for (const id of REPORT_IDS) {
      const res = await read(API[id](savings, '2026-10-01', '2026-10-31'))
      expect(res.status, id).toBe(403)
      expect(await res.json(), id).toEqual(NOT_KEPT)
    }
  })

  it('reads a Report once the Admin has kept it, as the Admin reads it', async () => {
    const kept: Record<ReportId, Record<string, unknown>> = {
      spending: { accountId: savings },
      'income-vs-spending': { accountId: savings },
      loans: { categoryId: loanId },
      transactions: { accountId: savings },
      balances: { accountId: savings },
      'budget-vs-actual': {},
    }
    for (const id of REPORT_IDS) {
      const path = API[id](savings, '2026-10-01', '2026-10-31')
      expect((await read(path)).status, `${id} before`).toBe(403)
      expect((await keep({ report: id, from: '2026-10-01', to: '2026-10-31', ...kept[id] })).status).toBe(201)
      const asMember = await read(path)
      expect(asMember.status, `${id} after`).toBe(200)
      expect(await asMember.json(), id).toEqual(await (await read(path, 'admin')).json())
    }
  })

  it('is refused the same Report with another date, another Account, or another start', async () => {
    await keep({ ...SPENDING, accountId: savings })
    expect((await read(API.spending(savings, '2026-10-01', '2026-10-31'))).status).toBe(200)
    expect((await read(API.spending(savings, '2026-10-01', '2026-10-30'))).status).toBe(403)
    expect((await read(API.spending(savings, '2026-10-02', '2026-10-31'))).status).toBe(403)
    expect((await read(API.spending(cheque, '2026-10-01', '2026-10-31'))).status).toBe(403)
    expect((await read('/api/reports/spending?from=2026-10-01&to=2026-10-31')).status).toBe(403) // every Account is not the one that was kept
    expect((await read(API['income-vs-spending'](savings, '2026-10-01', '2026-10-31'))).status).toBe(403) // nor is it another Report
  })

  it('reads a Report of every Account only as every Account, and an Account of a Report that asks for the Accounts one at a time', async () => {
    await keep(SPENDING)
    expect((await read('/api/reports/spending?from=2026-10-01&to=2026-10-31')).status).toBe(200)
    expect((await read(API.spending(savings, '2026-10-01', '2026-10-31'))).status).toBe(403)

    await keep({ report: 'transactions', from: '2026-10-01', to: '2026-10-31' }) // all Accounts: the page asks for each in turn
    expect((await read(API.transactions(savings, '2026-10-01', '2026-10-31'))).status).toBe(200)
    expect((await read(API.transactions(cheque, '2026-10-01', '2026-10-31'))).status).toBe(200)
    expect((await read(API.transactions(cheque, '2026-10-01', '2026-10-30'))).status).toBe(403)

    await keep({ report: 'balances', from: '2026-10-01', to: '2026-10-31', accountId: savings }) // one Account: that Account alone
    expect((await read(API.balances(savings, '2026-10-01', '2026-10-31'))).status).toBe(200)
    expect((await read(API.balances(cheque, '2026-10-01', '2026-10-31'))).status).toBe(403)
  })

  it('reads a Loans Report of every Loans Category, one request each, and one of a Category only as that Category; a start date is part of it', async () => {
    await keep({ report: 'loans', to: '2026-10-31' }) // every Loans Category, from the first Transaction
    expect((await read(`/api/reports/loans?categoryId=${loanId}&to=2026-10-31`)).status).toBe(200)
    expect((await read(`/api/reports/loans?categoryId=${loanId}&from=2026-01-01&to=2026-10-31`)).status).toBe(403)
    await env.DB.prepare('DELETE FROM kept_reports').run()

    await keep({ report: 'loans', categoryId: loanId, from: '2026-01-01', to: '2026-10-31' })
    expect((await read(`/api/reports/loans?categoryId=${loanId}&from=2026-01-01&to=2026-10-31`)).status).toBe(200)
    expect((await read(`/api/reports/loans?categoryId=${loanId + 1}&from=2026-01-01&to=2026-10-31`)).status).toBe(403)
    expect((await read(`/api/reports/loans?categoryId=${loanId}&to=2026-10-31`)).status).toBe(403)
  })

  it('is refused a request that makes a choice badly, whatever is kept', async () => {
    await keep(SPENDING)
    for (const path of ['/api/reports/spending', '/api/reports/spending?from=2026-10-01', '/api/reports/spending?from=2026-10-01&from=2026-10-02&to=2026-10-31', '/api/reports/spending?from=x&to=y']) {
      expect((await read(path)).status, path).toBe(403)
    }
  })

  it('is refused after the Admin deletes the kept Report', async () => {
    const { id } = (await (await keep(SPENDING)).json()) as { id: number }
    expect((await read('/api/reports/spending?from=2026-10-01&to=2026-10-31')).status).toBe(200)
    await forget(id)
    expect((await read('/api/reports/spending?from=2026-10-01&to=2026-10-31')).status).toBe(403)
  })

  it('fails closed: a path under /api/reports that is not one of the six, or is one written another way, is refused to a Member whatever is kept', async () => {
    await keep(SPENDING)
    const range = 'from=2026-10-01&to=2026-10-31'
    expect((await read('/api/reports/spending?' + range)).status).toBe(200) // kept, so the refusals below are of the path alone
    for (const path of ['/api/reports/nonsense', `/api/reports/nonsense?${range}`, '/api/reports/', `/api/reports/spending/?${range}`, `/api/reports/spending/extra?${range}`, `/api/reports/Spending?${range}`]) {
      const res = await read(path)
      expect(res.status, path).toBe(403)
      expect(await res.json(), path).toEqual(NOT_KEPT)
    }
  })

  it('does not hold the Admin to the list: the Admin reads any Report, which is how it is made', async () => {
    for (const id of REPORT_IDS) expect((await read(API[id](savings, '2026-10-01', '2026-10-31'), 'admin')).status, id).toBe(200)
    expect(await rows()).toEqual([]) // reading is not keeping: the page asks for that
  })

  it('still refuses someone who is not signed in', async () => {
    await keep(SPENDING)
    expect((await read('/api/reports/spending?from=2026-10-01&to=2026-10-31', null)).status).toBe(401)
  })

  it('costs one small query to check: a row or two more than the Report reads for the Admin, however many are kept', async () => {
    for (const to of days(30)) await seedKept({ report: 'spending', to })
    await seedKept({ report: 'spending', to: '2026-10-31' })
    // No chance charge of the Members' daily limit (member-read-limit.ts), whose write would read a row or two more.
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T) => (array as unknown as Uint32Array).fill(0xffffffff) as unknown as T)
    const rowsRead = async (who: Who) => {
      const { db, usage } = meteredDb()
      const ctx = createExecutionContext()
      const res = await worker.fetch!(new Request(`${origin}/api/reports/spending?from=2026-10-01&to=2026-10-31`, { headers: { Cookie: `fernledger_dev_as=${who}` } }) as never, { ...env, DB: db }, ctx)
      await waitOnExecutionContext(ctx)
      expect(res.status, who).toBe(200)
      return usage.rowsRead
    }

    const admin = await rowsRead('admin')
    const member = await rowsRead('member')

    expect(member - admin).toBeGreaterThan(0)
    expect(member - admin).toBeLessThanOrEqual(3)
  })
})
