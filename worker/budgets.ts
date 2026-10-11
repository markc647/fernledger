import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { ALL_CHANGES, budgetBody, budgetVsActual, describeChange, IN_EFFECT, latestMonth, MAX_BUDGET_CHANGES, monthQuery, withChanges, type Change, type InEffect } from './budget-rules'
import { findCategory } from './categories'
import { recordChange } from './changelog'
import { monthEnd, monthStart, nzMonth } from './months'
import { buildSpending, type SpendingRow } from './spending'
import { CHANGED_MEANWHILE, pathId, validate } from './validate'

// A monthly Budget for each Spending Category, effective from a month onward (migrations/1601_budgets.sql, budget-rules.ts). Every Member
// can read them; the guard in app.ts already refuses a change from anyone but the Admin. Each change is one Change Log entry of type
// `budget`. Budget vs actual compares a month's Budgets with its spending (spending.ts, ADR 0012). No amount carries over from one month
// to the next: a month's figures depend on that month's rows alone.

/** The month a request is about: the one asked for, else this NZ month. */
const monthOf = (asked: string | undefined) => asked ?? nzMonth(new Date())

type Previous = { effectiveFrom: string; amountCents: number | null }

const BUDGET_CHANGES_FULL = { error: `Fernledger keeps at most ${MAX_BUDGET_CHANGES} Budget changes and cannot remove one, so there is no room to add another` }

export const budgets = new Hono<AppEnv>()
  // Every Spending Category in use with its Budget in the month, and all of its changes (the page shows what is coming as well as what is now).
  // `changeCount` of `changeLimit` is how full the history is, for the page to say when it is near.
  .get('/', validate('query', monthQuery), async (c) => {
    const month = monthOf(c.req.valid('query').month)
    const db = c.env.DB
    const [inEffect, changes] = await db.batch([db.prepare(IN_EFFECT).bind(month), db.prepare(ALL_CHANGES)])
    return c.json({ month, budgets: withChanges(inEffect!.results as InEffect[], changes!.results as Change[]), changeCount: changes!.results.length, changeLimit: MAX_BUDGET_CHANGES })
  })
  // Each Spending Category with a Budget in the month, against what it spent, and what the rest spent. Two queries, whatever the number of Transactions.
  .get('/vs-actual', validate('query', monthQuery), async (c) => {
    const month = monthOf(c.req.valid('query').month)
    const db = c.env.DB
    const spending = buildSpending({ from: monthStart(month), to: monthEnd(month) })
    const [inEffect, spent] = await db.batch([db.prepare(IN_EFFECT).bind(month), db.prepare(spending.sql).bind(...spending.binds)])
    return c.json({ month, ...budgetVsActual(inEffect!.results as InEffect[], spent!.results as SpendingRow[]) })
  })
  // Sets what the Category's Budget is from a month on (null ends it). Only that month's row is written, so months before it keep
  // their amounts. Asking for what the month already has changes nothing and is not logged.
  .put('/:categoryId', validate('json', budgetBody), async (c) => {
    const { effectiveFrom, amountCents } = c.req.valid('json')
    const db = c.env.DB
    const categoryId = pathId(c.req.param('categoryId'))
    if (categoryId === null) return c.json({ error: 'Not found' }, 404)
    const category = await findCategory(db, categoryId)
    if (!category) return c.json({ error: 'Not found' }, 404)
    // Budgets are for Spending Categories only (ADR 0012). The Category is in the path, so that is the field named.
    if (category.kind !== 'spending') return c.json({ error: 'Invalid request', field: 'categoryId' }, 400)

    const [current, held] = await db.batch([
      db
        .prepare(`SELECT effective_from_month AS effectiveFrom, amount_cents AS amountCents FROM budgets WHERE category_id = ?1 AND effective_from_month = ${latestMonth('?1', '?2')}`)
        .bind(category.id, effectiveFrom),
      db.prepare('SELECT COUNT(*) AS n FROM budgets'),
    ])
    const previous = (current!.results[0] as Previous | undefined) ?? null
    const before = previous?.amountCents ?? null
    const done = { categoryId: category.id, effectiveFrom, amountCents }
    if (before === amountCents) return c.json({ ...done, changed: false })
    // A month that already has a row is replaced, which adds none; otherwise this one is added.
    if (previous?.effectiveFrom !== effectiveFrom && (held!.results[0] as { n: number }).n >= MAX_BUDGET_CHANGES) {
      return c.json(BUDGET_CHANGES_FULL, 409)
    }

    const entry = describeChange(category.name, effectiveFrom, before, amountCents)
    const [written] = await recordChange(db, putBudget(db, { categoryId: category.id, effectiveFrom, amountCents, previous }), { actor: c.var.member, type: 'budget', ...entry, onlyIfChanged: true })
    if (written!.meta.changes === 0) {
      switch (await whyUnwritten(db, category.id, { effectiveFrom, amountCents, previous })) {
        case 'gone':
          return c.json({ error: 'Not found' }, 404)
        case 'not spending':
          return c.json({ error: 'Invalid request', field: 'categoryId' }, 400)
        case 'already':
          return c.json({ ...done, changed: false })
        case 'full':
          return c.json(BUDGET_CHANGES_FULL, 409)
        case 'changed':
          return c.json(CHANGED_MEANWHILE, 409)
      }
    }
    return c.json({ ...done, changed: true })
  })

/**
 * The statement that sets a Budget, only if what the handler read still holds: the Category is a Spending Category in use, the latest row on or before the month is
 * the one that was read (its month and its amount; null for none), and, when the month has no row of its own yet, there is room for one (the count is of every
 * row, and a row is never removed). Another request can land between the reads and the write. When it holds nothing is written and, with `onlyIfChanged`, nothing
 * is logged. It is the last statement of its batch, which is what `onlyIfChanged` looks at.
 */
const putBudget = (db: D1Database, { categoryId, effectiveFrom, amountCents, previous }: { categoryId: number; effectiveFrom: string; amountCents: number | null; previous: Previous | null }) =>
  db
    .prepare(
      `INSERT INTO budgets (category_id, effective_from_month, amount_cents)
       SELECT ?1, ?2, ?3
       WHERE EXISTS (SELECT 1 FROM categories WHERE id = ?1 AND removed_at IS NULL AND kind = 'spending')
         AND (SELECT effective_from_month FROM budgets WHERE category_id = ?1 AND effective_from_month = ${latestMonth('?1', '?2')}) IS ?4
         AND (SELECT amount_cents FROM budgets WHERE category_id = ?1 AND effective_from_month = ${latestMonth('?1', '?2')}) IS ?5
         AND (?4 IS ?2 OR (SELECT COUNT(*) FROM budgets) < ?6)
       ON CONFLICT (category_id, effective_from_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
    )
    .bind(categoryId, effectiveFrom, amountCents, previous?.effectiveFrom ?? null, previous?.amountCents ?? null, MAX_BUDGET_CHANGES)

/**
 * Why the write changed nothing, from the Category and Budget as they are now: the Category went, or is no longer Spending (as the route answers when it is asked for),
 * the month already has what was asked for, the Budget is as it was read and so the last place went, or something changed it meanwhile.
 */
async function whyUnwritten(
  db: D1Database,
  categoryId: number,
  { effectiveFrom, amountCents, previous }: { effectiveFrom: string; amountCents: number | null; previous: Previous | null },
): Promise<'gone' | 'not spending' | 'already' | 'full' | 'changed'> {
  const category = await findCategory(db, categoryId)
  if (!category) return 'gone'
  if (category.kind !== 'spending') return 'not spending'
  const now = await db
    .prepare(`SELECT effective_from_month AS effectiveFrom, amount_cents AS amountCents FROM budgets WHERE category_id = ?1 AND effective_from_month = ${latestMonth('?1', '?2')}`)
    .bind(categoryId, effectiveFrom)
    .first<Previous>()
  if ((now?.amountCents ?? null) === amountCents) return 'already'
  const asRead = (now?.effectiveFrom ?? null) === (previous?.effectiveFrom ?? null) && (now?.amountCents ?? null) === (previous?.amountCents ?? null)
  return asRead ? 'full' : 'changed'
}
