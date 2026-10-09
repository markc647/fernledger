import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { effectiveCategory, type CategorySource } from './effective-category'
import { validate } from './validate'

export const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

const digits = z.optional(z.string().check(z.regex(/^\d{1,9}$/)))
const pageQuery = z.object({ limit: digits, offset: digits, uncategorised: z.optional(z.literal('true')) })

/** The Admin's Override: a Category in use, or null to take it off. */
const overrideBody = z.object({ categoryId: z.nullable(z.int().check(z.positive())) })
/** A Note, trimmed. Blank takes the Note off. */
const noteBody = z.object({ note: z.string().check(z.trim(), z.maxLength(500)) })

type TransactionListRow = {
  id: number
  accountId: number
  accountName: string
  date: string
  description: string
  bankType: string
  amountCents: number
  /** The effective Category (see effective-category.ts), or null while Uncategorised. */
  categoryId: number | null
  categoryName: string | null
  /** Which source supplied the Category: 'override' for one the Admin set by hand. */
  categorySource: CategorySource | null
  note: string | null
}

/** Describes a Transaction in a Change Log summary: enough to find it, from its ID, date and description. */
type Described = { id: number; date: string; description: string }
const describe = (t: Described) => `Transaction ${t.id} (${t.date}, ${t.description})`

const findTransaction = (db: D1Database, id: number) =>
  Number.isSafeInteger(id)
    ? db.prepare('SELECT id, date, description, override_category AS overrideCategory, note FROM transactions WHERE id = ?').bind(id).first<Described & { overrideCategory: number | null; note: string | null }>()
    : null

/** Every Member can read the list: newest first, a page at a time. `?uncategorised=true` keeps only Transactions with no effective Category. */
export const transactions = new Hono<AppEnv>()
  .get('/', validate('query', pageQuery), async (c) => {
    const query = c.req.valid('query')
    const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)
    const offset = Number(query.offset ?? 0)
    const db = c.env.DB
    const category = effectiveCategory()
    const from = `FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}`
    const where = query.uncategorised ? `WHERE ${category.id} IS NULL` : ''
    // The COUNT re-evaluates the effective Category for every Transaction when `?uncategorised=true` filters on it, so the
    // scan grows with the history (ADR 0004: 10 ms CPU, and D1 rows read are billed). The Override and Rule slots each add a
    // join per row now, and Akahu's will too; a cached count, or a column kept up to date, is a later ticket's call.
    const [count, page] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS total ${from} ${where}`),
      db
        .prepare(
          `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents,
                  ${category.id} AS categoryId, ${category.name} AS categoryName, ${category.source} AS categorySource, t.note
           ${from} ${where}
           ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
        )
        .bind(limit, offset),
    ])
    return c.json({ total: (count!.results[0] as { total: number }).total, transactions: page!.results as TransactionListRow[] })
  })
  // The guard in app.ts has already required the Admin, so these only validate the body's shape.
  .put('/:id/override', validate('json', overrideBody), async (c) => {
    const id = Number(c.req.param('id'))
    const { categoryId } = c.req.valid('json')
    const db = c.env.DB
    const transaction = await findTransaction(db, id)
    if (!transaction) return c.json({ error: 'Not found' }, 404)

    const category = categoryId === null ? null : await db.prepare('SELECT id, name FROM categories WHERE id = ? AND removed_at IS NULL').bind(categoryId).first<{ id: number; name: string }>()
    if (categoryId !== null && !category) return c.json({ error: 'Invalid request', field: 'categoryId' }, 400)

    // What the Override was, as far as anything can tell: a removed Category no longer counts (migrations/1101_categories.sql).
    const was =
      transaction.overrideCategory === null
        ? null
        : await db.prepare('SELECT id, name FROM categories WHERE id = ? AND removed_at IS NULL').bind(transaction.overrideCategory).first<{ id: number; name: string }>()
    if ((was?.id ?? null) === (category?.id ?? null)) return c.json({ id, categoryId: category?.id ?? null })

    // The Category could be removed between the check above and this write, so the UPDATE only stores one that is in use.
    const set = db
      .prepare('UPDATE transactions SET override_category = ?1 WHERE id = ?2 AND (?1 IS NULL OR EXISTS (SELECT 1 FROM categories WHERE id = ?1 AND removed_at IS NULL))')
      .bind(category?.id ?? null, id)
    const [update] = await recordChange(db, set, {
      actor: c.var.member,
      type: 'transaction',
      summary: category ? `Set Override on ${describe(transaction)} to ${category.name}` : `Cleared Override on ${describe(transaction)}`,
      before: { override: was?.name ?? null },
      after: { override: category?.name ?? null },
    })
    // Only if the Category was removed in that instant: the Change Log entry above then records an attempt that changed nothing.
    if (update!.meta.changes === 0) return c.json({ error: 'Invalid request', field: 'categoryId' }, 400)
    return c.json({ id, categoryId: category?.id ?? null })
  })
  .put('/:id/note', validate('json', noteBody), async (c) => {
    const id = Number(c.req.param('id'))
    const note = c.req.valid('json').note || null
    const db = c.env.DB
    const transaction = await findTransaction(db, id)
    if (!transaction) return c.json({ error: 'Not found' }, 404)
    const was = transaction.note || null
    if (was === note) return c.json({ id, note })

    await recordChange(db, db.prepare('UPDATE transactions SET note = ? WHERE id = ?').bind(note, id), {
      actor: c.var.member,
      type: 'transaction',
      summary: `${was === null ? 'Added a Note to' : note === null ? 'Removed the Note from' : 'Changed the Note on'} ${describe(transaction)}`,
      before: { note: was },
      after: { note },
    })
    return c.json({ id, note })
  })
