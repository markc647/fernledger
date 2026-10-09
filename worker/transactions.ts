import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { effectiveCategory, type CategorySource } from './effective-category'
import { buildSearch, searchQuery, toSearch, type Statement } from './transaction-search'
import { validate } from './validate'

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

/**
 * One Transaction in full. The `bank…` fields are the bank's own words, as the bank or Akahu gave them; the ones Sync supplies
 * are null for an Import. `bankTime` is the bank's time of day, as a UTC instant, and is null unless the bank actually supplied
 * one (Bank Time), however the raw date looks. `firstSeenAt` is when Akahu first reported the Transaction, as a UTC instant.
 */
type TransactionDetail = {
  id: number
  accountId: number
  accountName: string
  date: string
  amountCents: number
  description: string
  bankMemo: string
  bankType: string
  bankReference: string | null
  bankCounterpartyAccount: string | null
  bankCardSuffix: string | null
  bankParticulars: string | null
  bankPaymentCode: string | null
  source: 'import' | 'sync'
  categoryId: number | null
  categoryName: string | null
  categorySource: CategorySource | null
  note: string | null
  bankTime: string | null
  firstSeenAt: string | null
}

/** A Transaction's ID in a path: digits only, no sign, exponent or leading zero, so it is what it looks like. */
const ID = /^[1-9]\d{0,14}$/

/** Describes a Transaction in a Change Log summary: enough to find it, from its ID, date and description. */
type Described = { id: number; date: string; description: string }
const describe = (t: Described) => `Transaction ${t.id} (${t.date}, ${t.description})`

const findTransaction = (db: D1Database, id: number) =>
  Number.isSafeInteger(id)
    ? db.prepare('SELECT id, date, description, override_category AS overrideCategory, note FROM transactions WHERE id = ?').bind(id).first<Described & { overrideCategory: number | null; note: string | null }>()
    : null

/**
 * Every Member can read these. The list is searched, filtered, sorted and paged by the query string (transaction-search.ts);
 * by default it is every Transaction, newest first, 50 at a time, with the total on the first page (`total` is null when
 * the request didn't count). `/:id` is one Transaction in full.
 */
export const transactions = new Hono<AppEnv>()
  .get('/', validate('query', searchQuery), async (c) => {
    const db = c.env.DB
    // The count reads every Transaction the filters keep, so it runs only when asked for or on the first page (`want`); the
    // page reads little more than itself when its order is the date index's (ADR 0004: D1 bills rows read). A date range is
    // served by the (date, id) index, and an Override Category by its own index. An Account filter wants (account_id, date, id):
    // the balances ticket's migration 1002 adds it and this ticket adds none. A text filter, or a sort on any column but date,
    // reads every Transaction the other filters keep. When Rules arrive the effective Category is worked out per Transaction,
    // so a Category filter should be revisited then.
    const search = toSearch(c.req.valid('query'))
    const { count, page } = buildSearch(search)
    const run = ({ sql, binds }: Statement) => db.prepare(sql).bind(...binds)
    const counting = search.want !== 'page'
    const paging = search.want !== 'count'
    const results = await db.batch([...(counting ? [run(count)] : []), ...(paging ? [run(page)] : [])])
    const total = counting ? (results.shift()!.results[0] as { total: number }).total : null
    return c.json({ total, transactions: paging ? (results[0]!.results as TransactionListRow[]) : [] })
  })
  .get('/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404)
    const category = effectiveCategory()
    const transaction = await c.env.DB.prepare(
      `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.amount_cents AS amountCents, t.description,
              t.bank_memo AS bankMemo, t.bank_type AS bankType, t.bank_reference AS bankReference,
              t.bank_counterparty_account AS bankCounterpartyAccount, t.bank_card_suffix AS bankCardSuffix, t.bank_particulars AS bankParticulars, t.bank_payment_code AS bankPaymentCode,
              t.source, ${category.id} AS categoryId, ${category.name} AS categoryName, ${category.source} AS categorySource, t.note,
              CASE WHEN t.has_bank_time = 1 THEN t.akahu_date_raw END AS bankTime, t.akahu_first_seen_at AS firstSeenAt
       FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
       WHERE t.id = ?`,
    )
      .bind(Number(id))
      .first<TransactionDetail>()
    return transaction ? c.json(transaction) : c.json({ error: 'Not found' }, 404)
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
