import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { ALL_CHANGES, budgetBody, budgetVsActual, describeChange, IN_EFFECT, MAX_BUDGET_CHANGES, monthQuery, withChanges, latestMonth, type Change, type InEffect } from './budget-rules'
import { findCategory } from './categories'
import { recordChange } from './changelog'
import { nzMonth } from './months'
import { buildSpending, type SpendingRow } from './spending'
import { validate } from './validate'

// A monthly Budget for each Category, effective from a month onward (migrations/1601_budgets.sql, budget-rules.ts). Every Member can
// read them; the guard in app.ts already refuses a change from anyone but the Admin. Each change is one Change Log entry of type `budget`.
// Budget vs actual compares a month's Budgets with spending (spending.ts: Transfers and Pending Transactions left out). No amount
// carries over from one month to the next: a month's figures depend on that month's rows alone.

/** The month a request is about: the one asked for, else this NZ month. */
const monthOf = (asked: string | undefined) => asked ?? nzMonth(new Date())

type Previous = { effectiveFrom: string; amountCents: number | null }

export const budgets = new Hono<AppEnv>()
  // Every Category in use with its Budget in the month, and all of its changes (the page shows what is coming as well as what is now).
  .get('/', validate('query', monthQuery), async (c) => {
    const month = monthOf(c.req.valid('query').month)
    const db = c.env.DB
    const [inEffect, changes] = await db.batch([db.prepare(IN_EFFECT).bind(month), db.prepare(ALL_CHANGES)])
    return c.json({ month, budgets: withChanges(inEffect!.results as InEffect[], changes!.results as Change[]) })
  })
  // Each Category with a Budget in the month, against what it spent. Two queries, whatever the number of Transactions.
  .get('/vs-actual', validate('query', monthQuery), async (c) => {
    const month = monthOf(c.req.valid('query').month)
    const db = c.env.DB
    const spending = buildSpending({ fromMonth: month, toMonth: month })
    const [inEffect, spent] = await db.batch([db.prepare(IN_EFFECT).bind(month), db.prepare(spending.sql).bind(...spending.binds)])
    return c.json({ month, rows: budgetVsActual(inEffect!.results as InEffect[], spent!.results as SpendingRow[]) })
  })
  // Sets what the Category's Budget is from a month on (null ends it). Only that month's row is written, so months before it keep
  // their amounts. Asking for what the month already has changes nothing and is not logged.
  .put('/:categoryId', validate('json', budgetBody), async (c) => {
    const { effectiveFrom, amountCents } = c.req.valid('json')
    const db = c.env.DB
    const category = await findCategory(db, Number(c.req.param('categoryId')))
    if (!category) return c.json({ error: 'Not found' }, 404)

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
      return c.json({ error: 'There are too many Budget changes to add another' }, 409)
    }

    const entry = describeChange(category.name, effectiveFrom, before, amountCents)
    await recordChange(
      db,
      db
        .prepare('INSERT INTO budgets (category_id, effective_from_month, amount_cents) VALUES (?, ?, ?) ON CONFLICT (category_id, effective_from_month) DO UPDATE SET amount_cents = excluded.amount_cents')
        .bind(category.id, effectiveFrom, amountCents),
      { actor: c.var.member, type: 'budget', ...entry },
    )
    return c.json({ ...done, changed: true })
  })
