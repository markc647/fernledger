import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { findCategory } from './categories'
import { isLoansKind } from './category-kinds'
import { recordChange } from './changelog'
import { isQueryDate } from './dates'
import { ID, nothing, pathId, validate } from './validate'

// Kept Reports (migrations/9701_kept_reports.sql). Only the Admin makes Reports: each time the Admin shows one, its CHOICES are kept here (which Report, the dates, the Account or
// Category), not its figures, and a Member can open only a Report that is kept. Opening one works it out again from today's data, as showing it does, so this table is small:
// the list is one query, and a kept Report costs the Report's own reads and, for a Member, `isKept`'s lookup by Report and last date (an index).

/** The six Reports, as the last part of their address (`/reports/spending`, `/api/reports/spending`). The Reports page keeps the same list (src/lib/reports.ts); this file's test holds the two together. */
export const REPORT_IDS = ['spending', 'income-vs-spending', 'loans', 'transactions', 'balances', 'budget-vs-actual'] as const
export type ReportId = (typeof REPORT_IDS)[number]

type Shape = {
  /** What the Report is called, as the Change Log says it. */
  name: string
  /**
   * Whether the Report has an Account to choose. `together` asks the Worker for one Account or for all of them in one request; `each` asks for one Account at a time, so a Report of all
   * of them is a request for each, and a Member who may read that Report may read each of its Accounts.
   */
  account: false | 'together' | 'each'
  /** The Loans Report has a Loans Category to choose, or all of them; its request is for one Category, so the Report of all of them is a request for each. */
  category: boolean
  /** The Report may begin at the first Transaction, so its start date can be left out (Loans). */
  fromOptional: boolean
}

export const SHAPES: Record<ReportId, Shape> = {
  spending: { name: 'Spending by Category', account: 'together', category: false, fromOptional: false },
  'income-vs-spending': { name: 'Income vs spending by month', account: 'together', category: false, fromOptional: false },
  loans: { name: 'Loans', account: false, category: true, fromOptional: true },
  transactions: { name: 'Transaction listing', account: 'each', category: false, fromOptional: false },
  balances: { name: 'Balances over time', account: 'each', category: false, fromOptional: false },
  'budget-vs-actual': { name: 'Budget vs actual', account: false, category: false, fromOptional: false },
}

/** The most kept Reports. A new one over the limit drops the Report made longest ago, so the list stays one small query however long the Admin uses Fernledger. */
export const KEPT_LIMIT = 200

const id = z.int().check(z.positive(), z.maximum(999_999_999))
const date = z.string().check(z.refine(isQueryDate))
const keepFields = z.strictObject({ report: z.enum(REPORT_IDS), accountId: z.optional(id), categoryId: z.optional(id), from: z.optional(date), to: date })
type KeepFields = z.output<typeof keepFields>

/**
 * What the Admin says a shown Report chose: the Report and its dates, with the Account or Category only for a Report that has one. A refusal names the field. The browser keeps
 * the same choices the Report's address holds (`?account=2&from=…&to=…`), with `accountId` and `categoryId` for what the address calls `account` and `category`.
 */
export const keepBody = keepFields.check(
  z.refine<KeepFields>((b) => b.from !== undefined || SHAPES[b.report].fromOptional, { path: ['from'] }),
  z.refine<KeepFields>((b) => b.accountId === undefined || SHAPES[b.report].account !== false, { path: ['accountId'] }),
  z.refine<KeepFields>((b) => b.categoryId === undefined || SHAPES[b.report].category, { path: ['categoryId'] }),
  z.refine<KeepFields>((b) => b.from === undefined || b.from <= b.to, { path: ['to'] }),
)

/** The choices of a Report: `null` is every Account, every Loans Category, or (for `from`) the first Transaction. */
export type Choices = { accountId: number | null; categoryId: number | null; from: string | null; to: string }

const choicesOf = (body: z.output<typeof keepBody>): Choices => ({ accountId: body.accountId ?? null, categoryId: body.categoryId ?? null, from: body.from ?? null, to: body.to })

/** One value of a query string's parameter: `undefined` when it is left out, `null` when it is written more than once. */
const only = (params: URLSearchParams, name: string) => {
  const all = params.getAll(name)
  return all.length === 0 ? undefined : all.length === 1 ? all[0]! : null
}

/**
 * The choices a request for a Report's data makes, from its query string: `null` when it makes them badly (a date that is not a date, a choice written twice, an ID that is not a whole
 * number), so it is never one that was kept. A choice the Report does not have (an Account for the Loans Report) is left out, as the Report's route leaves it out.
 */
export function requestedChoices(report: ReportId, params: URLSearchParams): Choices | null {
  const shape = SHAPES[report]
  const to = only(params, 'to')
  const from = only(params, 'from')
  if (!isQueryDate(to)) return null
  if (from === null || (from !== undefined && !isQueryDate(from)) || (from === undefined && !shape.fromOptional)) return null
  const idOf = (name: string): number | null | undefined => {
    const raw = only(params, name)
    return raw === undefined ? null : raw !== null && ID.test(raw) ? Number(raw) : undefined
  }
  const accountId = shape.account === false ? null : idOf('accountId')
  const categoryId = shape.category ? idOf('categoryId') : null
  if (accountId === undefined || categoryId === undefined) return null
  return { accountId, categoryId, from: from ?? null, to }
}

/** Whether a Report with these choices has been kept, for a request that makes them: the kept Report is the one asked for, or (for a Report that asks for its Accounts or Categories one at a time) one of everything. */
async function isKept(db: D1Database, report: ReportId, ask: Choices) {
  const shape = SHAPES[report]
  const binds: (string | number | null)[] = [report, ask.to, ask.from]
  let account = 'account_id IS NULL'
  if (shape.account === 'together') {
    account = 'account_id IS ?'
    binds.push(ask.accountId)
  } else if (shape.account === 'each' && ask.accountId !== null) {
    account = '(account_id IS NULL OR account_id = ?)'
    binds.push(ask.accountId)
  }
  let category = 'category_id IS NULL'
  if (shape.category && ask.categoryId !== null) {
    category = '(category_id IS NULL OR category_id = ?)'
    binds.push(ask.categoryId)
  }
  // Report and last date are the first two columns of the unique index, so this reads the rows of the Report with that last date, and those are few.
  const row = await db.prepare(`SELECT 1 AS kept FROM kept_reports WHERE report = ? AND to_date = ? AND from_date IS ? AND ${account} AND ${category} LIMIT 1`).bind(...binds).first()
  return row !== null
}

/** The answer (403) to a Member who asks for a Report that has not been kept. It says nothing of the choices. */
export const NOT_KEPT = { error: 'Only the Admin makes Reports. This one has not been made.' } as const

/**
 * In front of every Report's data: the Admin reads any (that is how a Report is made), and a Member only a Report that the Admin has kept. It fails closed: a path under
 * /api/reports that is not one of the six is refused too, so a Report added without being listed here cannot be read by a Member until it is.
 */
export const requireKept = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.member.role === 'admin') return next()
  const report = REPORT_IDS.find((name) => c.req.path === `/api/reports/${name}`)
  const ask = report && requestedChoices(report, new URL(c.req.url).searchParams)
  if (report && ask && (await isKept(c.env.DB, report, ask))) return next()
  return c.json(NOT_KEPT, 403)
})

export type KeptReport = {
  id: number
  report: ReportId
  accountId: number | null
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  /** The Category has been removed, which does not remove the kept Report: opening it says the Category is gone. */
  categoryRemoved: boolean
  from: string | null
  to: string
  /** UTC time, ISO 8601, the Admin last showed it. */
  lastMadeAt: string
  madeBy: string
}
type KeptRow = Omit<KeptReport, 'categoryRemoved' | 'from' | 'to'> & { categoryRemoved: number | null; fromDate: string | null; toDate: string }

// A removed Category still names its kept Report, as it does its Rule.
const SELECT_KEPT = `
  SELECT k.id, k.report, k.account_id AS accountId, a.name AS accountName, k.category_id AS categoryId, c.name AS categoryName, c.removed_at IS NOT NULL AS categoryRemoved,
         k.from_date AS fromDate, k.to_date AS toDate, k.last_made_at AS lastMadeAt, k.made_by AS madeBy
  FROM kept_reports k LEFT JOIN accounts a ON a.id = k.account_id LEFT JOIN categories c ON c.id = k.category_id`

const view = ({ fromDate, toDate, categoryRemoved, ...row }: KeptRow): KeptReport => ({ ...row, categoryRemoved: categoryRemoved === 1, from: fromDate, to: toDate })

/** The Reports kept, the newest made first: at most KEPT_LIMIT rows, in one query. */
const listKept = async (db: D1Database) => (await db.prepare(`${SELECT_KEPT} ORDER BY k.last_made_at DESC, k.id DESC LIMIT ?`).bind(KEPT_LIMIT).all<KeptRow>()).results.map(view)

const findKept = async (db: D1Database, keptId: number) => {
  const row = await db.prepare(`${SELECT_KEPT} WHERE k.id = ?`).bind(keptId).first<KeptRow>()
  return row ? view(row) : null
}

/** Who or what a kept Report is of, in words: the Account or Category, or all of them. */
const subjectOf = (kept: { report: ReportId; accountId: number | null; accountName: string | null; categoryId: number | null; categoryName: string | null }) =>
  SHAPES[kept.report].category
    ? kept.categoryId === null ? 'all loans' : (kept.categoryName ?? `Category ${kept.categoryId}`)
    : kept.accountId === null ? 'all Accounts' : (kept.accountName ?? `Account ${kept.accountId}`)

/** The dates, as the Change Log's summaries have them. */
const datesOf = (from: string | null, to: string) => (from === null ? `from the first Transaction to ${to}` : `${from} to ${to}`)

/** What the Change Log shows of a kept Report, before or after: the Report, who or what it is of, and the dates (which the page writes the usual way). */
const recordOf = (kept: Parameters<typeof subjectOf>[0] & { from: string | null; to: string }) => ({
  report: SHAPES[kept.report].name,
  [SHAPES[kept.report].category ? 'loan' : 'account']: subjectOf(kept),
  from: kept.from ?? 'The first Transaction',
  to: kept.to,
})

const describe = (kept: Parameters<typeof recordOf>[0]) => `${SHAPES[kept.report].name} Report for ${subjectOf(kept)}, ${datesOf(kept.from, kept.to)}`
const sentence = (verb: string, kept: Parameters<typeof recordOf>[0]) => `${verb} ${describe(kept)}`

// The same Report with the same choices is the same row. A choice that is left out is NULL in the table and compares as 0 or '' here, as the unique index does.
const SAME = "report = ? AND to_date = ? AND COALESCE(from_date, '') = ? AND COALESCE(account_id, 0) = ? AND COALESCE(category_id, 0) = ?"

export const keptReports = new Hono<AppEnv>()
  // Every Member reads the list: the Reports the Admin has made. The Reports page is this table.
  .get('/', async (c) => c.json(await listKept(c.env.DB)))
  // The Admin has shown a Report: keep its choices, or, if a Report with those choices is kept, say it was made again now. The first is a change for the Change Log and the second is
  // not (the Admin reading a Report they already made is not a change to the list). One batch and no read of its own, so two requests at once cannot add the same row twice.
  .post('/', validate('json', keepBody), async (c) => {
    const db = c.env.DB
    const body = c.req.valid('json')
    const choices = choicesOf(body)
    const account = choices.accountId === null ? undefined : await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(choices.accountId).first<{ name: string }>()
    if (account === null) return c.json({ error: 'Not found', field: 'accountId' }, 404)
    // A Loans Category that is in use: not removed, and not a Spending or Income one, which the Loans Report has no loans in.
    const category = choices.categoryId === null ? undefined : await findCategory(db, choices.categoryId)
    if (category === null || (category && !isLoansKind(category.kind))) return c.json({ error: 'Not found', field: 'categoryId' }, 404)

    const kept = { report: body.report, ...choices, accountName: account?.name ?? null, categoryName: category?.name ?? null }
    // A new Report goes to the top of the list, so it pushes the one at KEPT_LIMIT - 1 now, and any below it, over the limit. They are chosen here, before the write, so that the batch drops
    // exactly them and the Change Log names them. The ID of a kept Report is never used again (AUTOINCREMENT), so the batch cannot drop a different Report than the one named.
    const over = (await db.prepare(`${SELECT_KEPT} WHERE k.id IN (SELECT id FROM kept_reports ORDER BY last_made_at DESC, id DESC LIMIT -1 OFFSET ?) ORDER BY k.last_made_at DESC, k.id DESC`).bind(KEPT_LIMIT - 1).all<KeptRow>()).results.map(view)
    const email = c.var.member.email
    const same: (string | number)[] = [body.report, choices.to, choices.from ?? '', choices.accountId ?? 0, choices.categoryId ?? 0]
    // The INSERT is the last statement, which `onlyIfChanged` looks at: it changes a row only when no Report with these choices was kept. The drop is only for a Report that is new: nothing
    // is dropped when the UPDATE found it (which would also leave no entry in the Change Log), however the request that kept it was interleaved with this one.
    const [updated, , inserted] = await recordChange(
      db,
      [
        db.prepare(`UPDATE kept_reports SET last_made_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), made_by = ? WHERE ${SAME} RETURNING id`).bind(email, ...same),
        db.prepare(`DELETE FROM kept_reports WHERE id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM kept_reports WHERE ${SAME})`).bind(JSON.stringify(over.map((r) => r.id)), ...same),
        db.prepare('INSERT OR IGNORE INTO kept_reports (report, account_id, category_id, from_date, to_date, made_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').bind(body.report, choices.accountId, choices.categoryId, choices.from, choices.to, email),
      ],
      {
        actor: c.var.member,
        type: 'report',
        summary: over.length === 0 ? sentence('Kept the', kept) : `${sentence('Kept the', kept)}, and dropped the oldest to stay within ${KEPT_LIMIT}: the ${describe(over[0]!)}${over.length > 1 ? ` and ${over.length - 1} more` : ''}`,
        before: over.length === 0 ? undefined : over.length === 1 ? recordOf(over[0]!) : over.map(recordOf),
        after: recordOf(kept),
        onlyIfChanged: true,
      },
    )
    const created = inserted!.results.length > 0
    const keptId = ((inserted!.results[0] ?? updated!.results[0]) as { id: number } | undefined)?.id
    if (keptId === undefined) return c.json({ error: 'Something went wrong' }, 500) // neither found it nor added it: a row that was removed between the two, which one batch cannot do
    return c.json({ id: keptId }, created ? 201 : 200)
  })
  // The Admin removes a kept Report from the list. The row goes (it is only choices); the Change Log keeps what it was.
  .delete('/:id', validate('json', nothing), async (c) => {
    const keptId = pathId(c.req.param('id'))
    if (keptId === null) return c.json({ error: 'Not found' }, 404)
    const db = c.env.DB
    const kept = await findKept(db, keptId)
    if (!kept) return c.json({ error: 'Not found' }, 404)

    // If another request removed it first, this one deleted nothing, logs nothing and answers as it does for one that is not there.
    const [removed] = await recordChange(db, db.prepare('DELETE FROM kept_reports WHERE id = ?').bind(keptId), {
      actor: c.var.member,
      type: 'report',
      summary: sentence('Removed the kept', kept),
      before: recordOf(kept),
      onlyIfChanged: true,
    })
    if (removed!.meta.changes === 0) return c.json({ error: 'Not found' }, 404)
    return c.json({ id: keptId })
  })
