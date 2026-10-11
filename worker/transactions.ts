import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import type { CategoryKind } from './category-kinds'
import { recordChange } from './changelog'
import { effectiveCategory, type CategorySource, type TransferSource } from './effective-category'
import { exportQuery, exportResponse } from './transaction-export'
import { buildSearch, categoryProbe, isFewInCategory, needsCategoryProbe, searchQuery, toFilters, toSearch, type Statement } from './transaction-search'
import { clearHeldNotTransferStatement, clearNotTransferStatement, markNotTransferStatement, pairOneStatement, PARTNER_JOIN } from './transfers'
import { nothing, pathId, validate } from './validate'

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
  /** The Category's kind (ADR 0012), which decides how the Transaction is counted; null while Uncategorised, and for a Transfer. */
  categoryKind: CategoryKind | null
  note: string | null
  transfer: TransferSource | null
  /** The Account of the matching Transaction (the one this is paired with), whether or not an Override takes this one out of the Transfers; null when unpaired. */
  transferAccountName: string | null
  /** The Admin can say Not a Transfer (effective-category.ts `markable`), and the Admin has said it. */
  canMarkNotTransfer: boolean
  notTransfer: boolean
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
  categoryKind: CategoryKind | null
  note: string | null
  transfer: TransferSource | null
  /** The Account and the ID of the matching Transaction (the one this is paired with), or null when unpaired. */
  transferAccountName: string | null
  transferTransactionId: number | null
  /** True when the matching Transaction has an Override with a Category in use, so it counts under that Category's kind although this one is a Transfer. */
  transferPartnerOverridden: boolean
  /** The Admin can say Not a Transfer (effective-category.ts `markable`), and the Admin has said it: it is not paired, and neither a pairing nor a Rule makes it a Transfer. */
  canMarkNotTransfer: boolean
  notTransfer: boolean
  bankTime: string | null
  firstSeenAt: string | null
}

/** Describes a Transaction in a Change Log summary: enough to find it, from its ID, date and description. */
type Described = { id: number; date: string; description: string }
const describe = (t: Described) => `Transaction ${t.id} (${t.date}, ${t.description})`

const findTransaction = (db: D1Database, id: number) =>
  db.prepare('SELECT id, date, description, override_category AS overrideCategory, note FROM transactions WHERE id = ?').bind(id).first<Described & { overrideCategory: number | null; note: string | null }>()

/** What the Not a Transfer routes need to know about a Transaction, and the one it is paired or marked with, with each one's Account. */
type TransferState = Described & {
  accountName: string
  transferOf: number | null
  /** The Admin can say Not a Transfer (effective-category.ts), which is not the case once they have. */
  markable: boolean
  /** The number it shares with the Transaction it was marked with, null while it is not marked. */
  mark: number | null
  /** The Transaction it is paired with, or else the one it shares its mark with, when that one is still there. */
  matching: (Described & { accountName: string }) | null
}

async function findTransferState(db: D1Database, id: number): Promise<TransferState | null> {
  const t = await db
    .prepare(
      `SELECT t.id, t.date, t.description, a.name AS accountName, t.transfer_of AS transferOf, ${effectiveCategory().markable} AS markable, t.not_transfer_with AS mark,
              m.id AS matchingId, m.date AS matchingDate, m.description AS matchingDescription, ma.name AS matchingAccountName
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN transactions m ON m.id = COALESCE(t.transfer_of, (SELECT x.id FROM transactions x WHERE x.not_transfer_with = t.not_transfer_with AND x.id <> t.id))
       LEFT JOIN accounts ma ON ma.id = m.account_id
       WHERE t.id = ?`,
    )
    .bind(id)
    .first<
      Described & {
        accountName: string
        transferOf: number | null
        markable: number
        mark: number | null
        matchingId: number | null
        matchingDate: string | null
        matchingDescription: string | null
        matchingAccountName: string | null
      }
    >()
  if (!t) return null
  const { matchingId, matchingDate, matchingDescription, matchingAccountName, markable, ...rest } = t
  return { ...rest, markable: markable === 1, matching: matchingId === null ? null : { id: matchingId, date: matchingDate!, description: matchingDescription!, accountName: matchingAccountName! } }
}

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
    // served by the (date, id) index. An Account filter wants (account_id, date, id):
    // the balances ticket's migration 1002 adds it and this ticket adds none. A text filter, or a sort on any column but date,
    // reads every Transaction the other filters keep. A Category filter reads the Transactions its Override and Rule indexes
    // list, or for a page sorted by date of a Category with many, the date index as far as the page needs; one small probe
    // tells which (transaction-search.ts says why).
    let search = toSearch(c.req.valid('query'))
    if (needsCategoryProbe(search)) {
      const probe = categoryProbe(search.categoryId!)
      const found = await db.prepare(probe.sql).bind(...probe.binds).first<{ candidates: number }>()
      search = { ...search, fewInCategory: isFewInCategory(found?.candidates ?? 0) }
    }
    const { count, page } = buildSearch(search)
    const run = ({ sql, binds }: Statement) => db.prepare(sql).bind(...binds)
    const counting = search.want !== 'page'
    const paging = search.want !== 'count'
    const results = await db.batch([...(counting ? [run(count)] : []), ...(paging ? [run(page)] : [])])
    const total = counting ? (results.shift()!.results[0] as { total: number }).total : null
    // SQLite answers its yes-or-no columns with 0 and 1; a page is at most 200 rows.
    const rows = paging ? (results[0]!.results as (Omit<TransactionListRow, 'canMarkNotTransfer' | 'notTransfer'> & { canMarkNotTransfer: number; notTransfer: number })[]) : []
    return c.json({ total, transactions: rows.map((r): TransactionListRow => ({ ...r, canMarkNotTransfer: r.canMarkNotTransfer === 1, notTransfer: r.notTransfer === 1 })) })
  })
  // The same filters as the list, as a CSV file (transaction-export.ts). Ahead of '/:id', which would take "export.csv" for an ID.
  .get('/export.csv', validate('query', exportQuery), (c) => exportResponse(c.env.DB, toFilters(c.req.valid('query'))))
  .get('/:id', async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const category = effectiveCategory()
    const transaction = await c.env.DB.prepare(
      `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.amount_cents AS amountCents, t.description,
              t.bank_memo AS bankMemo, t.bank_type AS bankType, t.bank_reference AS bankReference,
              t.bank_counterparty_account AS bankCounterpartyAccount, t.bank_card_suffix AS bankCardSuffix, t.bank_particulars AS bankParticulars, t.bank_payment_code AS bankPaymentCode,
              t.source, ${category.shown.id} AS categoryId, ${category.shown.name} AS categoryName, ${category.shown.source} AS categorySource, ${category.shown.kind} AS categoryKind, t.note,
              ${category.transfer} AS transfer, partner_account.name AS transferAccountName, partner.id AS transferTransactionId,
              EXISTS (SELECT 1 FROM categories partner_override WHERE partner_override.id = partner.override_category AND partner_override.removed_at IS NULL) AS transferPartnerOverridden,
              ${category.markable} AS canMarkNotTransfer, t.not_transfer_with IS NOT NULL AS notTransfer,
              CASE WHEN t.has_bank_time = 1 THEN t.akahu_date_raw END AS bankTime, t.akahu_first_seen_at AS firstSeenAt
       FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
       ${PARTNER_JOIN}
       WHERE t.id = ?`,
    )
      .bind(id)
      .first<Omit<TransactionDetail, 'transferPartnerOverridden' | 'canMarkNotTransfer' | 'notTransfer'> & { transferPartnerOverridden: number; canMarkNotTransfer: number; notTransfer: number }>()
    return transaction
      ? c.json({
          ...transaction,
          transferPartnerOverridden: transaction.transferPartnerOverridden === 1,
          canMarkNotTransfer: transaction.canMarkNotTransfer === 1,
          notTransfer: transaction.notTransfer === 1,
        })
      : c.json({ error: 'Not found' }, 404)
  })
  // The guard in app.ts has already required the Admin, so these only validate the body's shape.
  .put('/:id/override', validate('json', overrideBody), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
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
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
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
  // "Not a Transfer": a pairing is wrong, or a Rule made a Transfer of something that is not one. Both halves are marked, and so stop being paired, in one batch
  // with the Change Log entry, and pairing and the Rules leave them alone from then on (transfers.ts). Undo takes the marks off and pairs them again. The guard
  // in app.ts has already required the Admin. A request that finds nothing to do writes no entry (`onlyIfChanged`).
  .post('/:id/not-transfer', validate('json', nothing), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const db = c.env.DB
    const transaction = await findTransferState(db, id)
    if (!transaction) return c.json({ error: 'Not found' }, 404)
    if (transaction.mark !== null) return c.json({ id, notTransfer: true })
    if (!transaction.markable) return c.json({ error: 'This Transaction is not a Transfer' }, 409)

    const { matching } = transaction
    const named = `${describe(transaction)} in ${transaction.accountName}`
    const [update] = await recordChange(db, markNotTransferStatement(db, { id, matchingId: transaction.transferOf }), {
      actor: c.var.member,
      type: 'transfer',
      summary: matching
        ? `Marked ${named} and its matching ${describe(matching)} in ${matching.accountName} as Not a Transfer`
        : `Marked ${named} as Not a Transfer, so the Rule that marks it as a Transfer no longer applies to it`,
      before: { transfer: matching ? `Transfer between ${transaction.accountName} and ${matching.accountName}` : 'Marked by a Rule' },
      after: { transfer: 'Not a Transfer' },
      onlyIfChanged: true,
    })
    // Only if an Import moved the pairing on between the read and the write, and then no entry was written.
    if (update!.meta.changes === 0) return c.json({ error: 'This Transaction has changed. Reload the page and try again' }, 409)
    return c.json({ id, notTransfer: true })
  })
  .delete('/:id/not-transfer', validate('json', nothing), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const db = c.env.DB
    const transaction = await findTransferState(db, id)
    if (!transaction) return c.json({ error: 'Not found' }, 404)
    const token = transaction.mark
    if (token === null) return c.json({ id, notTransfer: false, paired: transaction.transferOf !== null })

    // Each half is paired with what matches now, the Transaction it was marked with first. The mark comes off what a replace that has not finished is holding
    // (or the half that comes back would be marked again), and then off the Transactions: last, so that a second request that finds them off changes
    // nothing and writes no entry.
    const { matching } = transaction
    const pairing = matching ? 2 : 1
    const results = await recordChange(
      db,
      [
        pairOneStatement(db, { id, prefer: matching?.id ?? null, token }),
        ...(matching ? [pairOneStatement(db, { id: matching.id, prefer: id, token })] : []),
        clearHeldNotTransferStatement(db, { token }),
        clearNotTransferStatement(db, { token }),
      ],
      {
        actor: c.var.member,
        type: 'transfer',
        summary: `Took Not a Transfer off ${describe(transaction)} in ${transaction.accountName}${matching ? ` and ${describe(matching)} in ${matching.accountName}` : ''}`,
        before: { transfer: 'Not a Transfer' },
        after: { transfer: 'Can be a Transfer again' },
        onlyIfChanged: true,
      },
    )
    const paired = results.slice(0, pairing).some((result) => result.meta.changes > 0)
    if (paired || results.at(-1)!.meta.changes > 0) return c.json({ id, notTransfer: false, paired })
    // Another request took the marks off first, so this one changed nothing: say how it left this Transaction.
    const now = await db.prepare('SELECT transfer_of IS NOT NULL AS paired FROM transactions WHERE id = ?').bind(id).first<{ paired: number }>()
    return c.json({ id, notTransfer: false, paired: now?.paired === 1 })
  })
