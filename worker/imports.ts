import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName, bankAccountNumber, isoDate, normaliseAccountNumber } from './account-fields'
import type { AppEnv } from './app-env'
import { checkAfterRecording, DELETE_IMPORT_BALANCES, recordBalance } from './balance-check'
import { statusOnRecord } from './balance-rules'
import {
  annotated,
  APPLY_HELD,
  CARRY_PREVIEW,
  CARRIED,
  carryOutcome,
  carryStatements,
  CLEAR_HELD,
  CLEAR_HELD_IF_WAITING,
  COUNT_COLUMNS,
  COUNT_REMOVED_ANNOTATED,
  FORGET_APPLIED,
  HOLD_REMOVED,
  INCOMING_CTE,
  MARK_APPLIED,
  PENDING_CTE,
  parseLostRows,
  planCarryOver,
  TIDY_HELD,
  WAITING_LIST,
  type CarryCounts,
} from './carry-over'
import { recordChange } from './changelog'
import { chunkDetail, chunkStatements, chunkSummary, replaceWouldLeaveNothing } from './import-chunk'
import { badPreviewField, badRowField, IMPORTED_SLICE, MAX_CHUNKS, REPLACE_SLICE, serialisePreviewRows, serialiseRows, type ImportRow, type PreviewRow } from './import-rows'
import { applyRulesStatement, lastTransactionId } from './rule-apply'
import { pairTransfersStatement, UNPAIR_PARTNERS, unpairPartnersOfImportedStatement } from './transfers'
import { CHANGED_MEANWHILE, pathId, validate } from './validate'

// The browser parses the file (ADR 0004) and sends rows in chunks of about 500. Limits measured and chosen
// (D1 limits from developers.cloudflare.com/d1/platform/limits, checked 2026-10):
// - D1 allows 100 bound parameters per statement, so inserting rows one `?` per value caps a statement at 11 rows
//   and a 500-row chunk would need 46 statements (the free plan allows 50 D1 queries per invocation).
//   Instead a chunk is bound as ONE parameter, a JSON array, and unpacked in SQL with json_each: 500 rows are
//   one INSERT statement with one bound parameter.
// - A bound string may be 2 MB. Row fields are length-capped (import-rows.ts); 500 worst-case rows measured 335 KB.
// - 10 ms of CPU: reading, checking and re-serialising 500 typical rows (86 KB) measured about 1-2 ms in Node.
// - A chunk request costs at most 20 D1 queries (find the Account, count the Import-sourced rows to replace, count the
//   rows it already holds and the Overrides, Notes and Not a Transfer marks it will carry over, find the highest Transaction ID, then one batch
//   of at most 14 statements: set the Cutover Date (or create the Account), remove the old balances, forget what an
//   earlier attempt gave out, hold the Overrides, Notes and Not a Transfer marks of the rows that go, let go of the matching Transactions of the rows
//   that go, remove the old rows, insert the rows, apply the Rules to the rows just added, give the new
//   rows what is held, mark what was given, pair their Transfers, clear what is left (or, in an Import that is not a replace, tidy what is
//   finished with), record the file's ledger balance (last chunk only), write the Change Log entry; then the last chunk's
//   Balance Check reads and saves in 2 more), well under 50. A statement in a batch counts as one query; balances.test.ts
//   pins the worst case. Only a replace, or an Import of an Account a replace left holding Overrides, Notes and Not a Transfer marks, has the
//   carry-over statements (carry-over.ts); an ordinary chunk is exactly as it was, plus the one that pairs its Transfers.
//   The list of Transactions that lost theirs rides in the row count's one query. The Replace question's forecast
//   (`/carry-preview`, 500 rows a request) costs 2 queries, discarding what a stopped replace holds (`/discard-held`) 3.
// - MAX_CHUNKS (import-rows.ts) keeps one Import within the free plan's 100k D1 row writes a day.
// - Rows dated on or after the Account's Cutover Date are filtered out in SQL (`json_each` rows are compared there),
//   so the Worker never loops over them.

const chunkRequest = z.object({
  account: z.object({
    number: bankAccountNumber,
    /** Used only when this chunk creates the Account. */
    name: z.optional(accountName),
  }),
  chunk: z
    .object({ index: z.int().check(z.minimum(0)), count: z.int().check(z.minimum(1), z.maximum(MAX_CHUNKS)) })
    .check(z.refine((chunk) => chunk.index < chunk.count, { path: ['index'] })),
  /** About the whole file, for the Change Log entries. */
  file: z.object({
    adapterId: z.string().check(z.maxLength(40)),
    rowCount: z.int().check(z.minimum(0)),
    skipped: z.int().check(z.minimum(0)),
    from: isoDate,
    to: isoDate,
    /** The balance in the file's header and the date it is as of; recorded with the last chunk (balance-check.ts). */
    ledgerBalance: z.object({ cents: z.int(), date: isoDate }),
  }),
  // Checked by badRowField: a schema is too slow for 500 rows within 10 ms of CPU (CODING_STANDARDS.md#structure).
  // The custom type only carries the type.
  rows: z.custom<ImportRow[]>(),
  /** Set the Account's Cutover Date to this before importing (first chunk only), so rows on or after it are dropped. */
  cutoverDate: z.optional(isoDate),
  /** Remove the Account's Import-sourced Transactions in the same batch as this chunk (first chunk only). */
  replace: z.optional(z.boolean()),
  /** This is the last chunk of a replace: what no Transaction claimed is lost, and the Account's held Overrides, Notes and Not a Transfer marks are cleared (last chunk only). */
  completes: z.optional(z.boolean()),
})
  // Whole-Import options ride on the first chunk, where they apply once and atomically with its rows.
  .check(z.refine((request) => request.cutoverDate === undefined || request.chunk.index === 0, { path: ['cutoverDate'] }))
  .check(z.refine((request) => !request.replace || request.chunk.index === 0, { path: ['replace'] }))
  .check(z.refine((request) => !request.completes || request.chunk.index === request.chunk.count - 1, { path: ['completes'] }))

const clearRequest = z.object({ accountId: z.int().check(z.minimum(1)) })

// The rows of the Replace question's forecast are checked by badPreviewField, for the same reason as a chunk's.
const previewRequest = z.object({ accountId: z.int().check(z.minimum(1)), rows: z.custom<PreviewRow[]>() })

// `ON CONFLICT … DO NOTHING` ignores only a repeat of the bank's unique ID, unlike `OR IGNORE`, which would also
// swallow a bad row. A repeat is a duplicate: it adds no row, so duplicates = rows kept - rows added.
// ?3 is the Cutover Date (or null): rows dated on or after it are not inserted. ISO dates compare correctly as text.
export const INSERT_ROWS = `
  INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, bank_type, bank_reference, source, bank_unique_id)
  SELECT (SELECT id FROM accounts WHERE account_number = ?1),
         json_extract(value, '$.date'),
         json_extract(value, '$.amountCents'),
         CASE WHEN json_extract(value, '$.payee') <> '' THEN json_extract(value, '$.payee') ELSE json_extract(value, '$.bankMemo') END,
         json_extract(value, '$.bankMemo'),
         json_extract(value, '$.tranType'),
         json_extract(value, '$.chequeNumber'),
         'import',
         json_extract(value, '$.uniqueId')
  FROM json_each(?2)
  WHERE ?3 IS NULL OR json_extract(value, '$.date') < ?3
  ON CONFLICT (account_id, bank_unique_id) WHERE bank_unique_id IS NOT NULL DO NOTHING`

// How many different unique IDs the chunk carries on days before the Cutover Date (?3), how many of those the
// Account already holds, and how many rows are dropped for being on or after it. The insert adds the difference
// between the first two, so the chunk's Change Log entry (written in the same batch as the insert) can say so up front.
// It also counts what the chunk will carry over from replaced history (?4, ?5, ?6: carry-over.ts), in the same query. Its
// reads of the Account's own Transactions stay out of an ordinary chunk: ?5 is null unless this chunk starts a replace.
export const COUNT_NEW_ROWS = `
  WITH ${INCOMING_CTE}, ${PENDING_CTE}
  SELECT COUNT(*) AS ids, COUNT(t.id) AS held,
         (SELECT COUNT(*) FROM json_each(?2) WHERE ?3 IS NOT NULL AND json_extract(value, '$.date') >= ?3) AS dropped,
         ${COUNT_COLUMNS}
  FROM incoming LEFT JOIN transactions t ON t.account_id = ?1 AND t.bank_unique_id = incoming.id`

const COUNT_IMPORTED = "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND source = 'import'"

// `annotated` counts the rows a replace would carry over (an Override, a Note or a Not a Transfer mark), and `waiting` what a replace that did not finish still has to give back (carry-over.ts).
// `paired` is how many of those are one half of a Transfer, which a replace has to let go of and pair again (transfers.ts).
const COUNT_IMPORTED_AND_ANNOTATED = `SELECT COUNT(*) AS imported,
         COUNT(CASE WHEN ${annotated('transactions')} THEN 1 END) AS annotated, COUNT(transfer_of) AS paired,
         (SELECT COUNT(*) FROM carry_over WHERE account_id = ?1 AND applied = 0 AND ${annotated('carry_over')}) AS waiting
  FROM transactions WHERE account_id = ?1 AND source = 'import'`

// Only ever Import-sourced rows: Sync-sourced Transactions are never removed here. At most ?2 (REPLACE_SLICE) rows go
// in one statement, so rows added between the count and the delete can't push one replace past the write budget in
// ADR 0004: a removed row costs 4 D1 writes (the row and its three indexes), so a slice is 20,000 of the day's 100,000, and
// each of its rows that has an Override, Note or Not a Transfer mark costs 2 more to hold (the row and its key): at worst 10,000 more. A removed
// row that was paired costs up to 3 more, for its own Transfer index entry and to let go of its matching Transaction (transfers.ts): at worst
// 15,000 more again.
export const DELETE_IMPORTED = `DELETE FROM transactions WHERE id IN (${IMPORTED_SLICE})`

// A step of clearing a history too big to replace (POST /clear-history) is the statements a replace uses, each made to do nothing unless the slice it removes is still the one
// that was counted: another step or an Import can land between the count and the batch, and a step that finds the Account changed must neither remove rows the entry does not
// describe, nor remove any when the history now fits in one replace (which is what the route refuses). The slice is the oldest-dated REPLACE_SLICE Import-sourced rows, so it has
// not moved while the first row left over (the one after it, `FIRST_ROW_LEFT`) is the same row; if rows before it went or there are no longer more than a slice, it is another or none.
// (A gap, accepted: nothing removes a single imported row today, but an Import adding a row dated before the boundary in the same instant as a removal of one before it would swap a
// row of the slice without moving the boundary.)
// What it costs (ADR 0004): both are ordered by (date, id), which is the order of the index `transactions_account_date`, so D1 searches the Account in that index from its start and stops
// at the row it wants, reading a slice and sorting nothing, whatever else the table holds. The check runs up to five times in a step (once to read the boundary, once in each of the
// four statements, the balances one only if the Account has balance rows) at about 5,000 reads each, in a step that reads 90,262 rows at 5,201 and 105,061 at 20,000, with or without other Accounts' rows in the table (measured, and pinned
// in cutover.test.ts). In ID order it either sorts every row of the Account in a temporary b-tree (the whole history, each time), or, forced to walk the table in ID order with
// NOT INDEXED, reads every Account's rows up to the 5,001st of this one (the whole table, when another Account's rows were imported first). Counting the rows would read them all too.
export const FIRST_ROW_LEFT = "SELECT id FROM transactions WHERE account_id = ?1 AND source = 'import' ORDER BY date, id LIMIT 1 OFFSET ?2"
const STILL_THE_SAME = `(${FIRST_ROW_LEFT}) IS ?3`
const SLICE_IF_SAME = IMPORTED_SLICE.replace('LIMIT ?2', `LIMIT CASE WHEN ${STILL_THE_SAME} THEN ?2 ELSE 0 END`)
/** `sql`, with the rows it selects by IMPORTED_SLICE (?1 the Account, ?2 how many) selected only while the boundary (?3) is unchanged. */
const ifTheSame = (sql: string) => {
  const guarded = sql.replaceAll(IMPORTED_SLICE, SLICE_IF_SAME)
  if (guarded === sql || SLICE_IF_SAME === IMPORTED_SLICE) throw new Error('A step of clearing needs statements that select their rows with IMPORTED_SLICE')
  return guarded
}
const HOLD_REMOVED_IF_SAME = ifTheSame(HOLD_REMOVED)
const UNPAIR_PARTNERS_IF_SAME = ifTheSame(UNPAIR_PARTNERS)
const DELETE_IMPORTED_IF_SAME = ifTheSame(DELETE_IMPORTED)
const CLEAR_BALANCES_IF_SAME = `DELETE FROM balance_checks WHERE account_id = ?1 AND source = 'import' AND ${STILL_THE_SAME}`

type AccountRow = { id: number; name: string; cutover_date: string | null }

export const imports = new Hono<AppEnv>()
  // Saves one chunk of an Import. With `replace` (first chunk only) the Account's Import-sourced rows are removed in the
  // same batch. That makes a replace safe to repeat as a whole (the Admin chooses the file again and replaces again),
  // but not to replay: a stale or retried first chunk would also remove whatever later chunks had saved since. The
  // browser never resends a saved chunk, and if a replace stops part way the Admin simply replaces again from the start.
  .post('/chunks', validate('json', chunkRequest), async (c) => {
    const { account, chunk, file, rows, cutoverDate, replace, completes } = c.req.valid('json')
    const db = c.env.DB
    const badField = badRowField(rows)
    if (badField) return c.json({ error: 'Invalid request', field: badField }, 400)

    const number = normaliseAccountNumber(account.number)
    const existing = await db.prepare('SELECT id, name, cutover_date FROM accounts WHERE account_number = ?').bind(number).first<AccountRow>()
    if (!existing && chunk.index !== 0) return c.json({ error: 'Send the first chunk of the Import first' }, 409)

    // Replacing imported history removes the Account's Import-sourced Transactions in the same batch as this chunk's
    // rows, so a failure leaves the old history untouched. A history too big for one batch is cleared in steps first.
    const toRemove = replace && existing ? ((await db.prepare(COUNT_IMPORTED).bind(existing.id).first<{ n: number }>())?.n ?? 0) : 0
    if (toRemove > REPLACE_SLICE) return c.json({ error: 'Too many imported rows to replace at once', remaining: toRemove }, 409)

    const effectiveCutover = cutoverDate ?? existing?.cutover_date ?? null
    const rowsJson = serialiseRows(rows)
    // When replacing, the rows being removed don't count as already held. The Account's held Overrides, Notes and Not a Transfer marks count as
    // waiting, and so do those of the rows about to be removed.
    const replacing = replace === true && existing != null
    const lastChunk = chunk.index === chunk.count - 1
    // The last chunk of a replace (a single chunk has `replace` on it, a longer Import says `completes`) is the one that
    // empties what is held and reports what was lost, so it also asks the count to list those Transactions.
    const finishesReplace = lastChunk && (completes === true || replace === true)
    const counts = (await db
      .prepare(COUNT_NEW_ROWS)
      .bind(replace ? null : (existing?.id ?? null), rowsJson, effectiveCutover, existing?.id ?? null, replacing ? existing.id : null, finishesReplace ? 1 : 0)
      .first<{ ids: number; held: number; dropped: number } & CarryCounts>())!
    const { dropped } = counts
    const added = counts.ids - counts.held
    // The browser sends rows oldest first, so a first chunk that is entirely on or after the Cutover Date means the whole file is.
    if (replaceWouldLeaveNothing({ replace: replace === true, removed: toRemove, dropped, rowsInChunk: rows.length })) {
      return c.json({ error: 'Every row in this file is dated on or after the Cutover Date, so replacing would remove the old history and import nothing' }, 400)
    }
    const name = existing?.name ?? account.name ?? number
    const setsCutover = cutoverDate !== undefined
    // What this chunk does about the Overrides, Notes and Not a Transfer marks of the history it replaces, and what it will have carried.
    const carryPlan = planCarryOver({ replacing, lastChunk, finishesReplace }, counts)
    const carry = carryOutcome(carryPlan, counts, lastChunk)

    const planned = chunkStatements(
      { newAccount: !existing, setsCutover, replace: replace === true },
      {
        createAccount: () => db.prepare('INSERT INTO accounts (account_number, name, cutover_date) VALUES (?, ?, ?)').bind(number, name, effectiveCutover),
        setCutover: () => db.prepare('UPDATE accounts SET cutover_date = ? WHERE id = ?').bind(cutoverDate, existing!.id),
        clearBalances: () => db.prepare(DELETE_IMPORT_BALANCES).bind(existing!.id),
        forgetApplied: () => db.prepare(FORGET_APPLIED).bind(existing!.id),
        holdRemoved: () => db.prepare(HOLD_REMOVED).bind(existing!.id, REPLACE_SLICE),
        unpairPartners: () => unpairPartnersOfImportedStatement(db, { accountId: existing!.id, limit: REPLACE_SLICE }),
        removeImported: () => db.prepare(DELETE_IMPORTED).bind(existing!.id, REPLACE_SLICE),
        insertRows: () => db.prepare(INSERT_ROWS).bind(number, rowsJson, effectiveCutover),
      },
    )
    // The Rules apply to this Account's Transactions above this ID. It is read here, outside the batch, so those are the rows
    // this chunk adds and also any other write to the Account that lands between the read and the batch; a Rule's result
    // depends only on its own row, so giving those the Rules too is harmless.
    const afterId = await lastTransactionId(db)
    // The Rules are applied in the same batch as the rows, so a chunk and its Rule results commit together or not at all.
    // Applied after the commit, a failure would leave rows no retry gives Rules to: the retry reads the new highest ID.
    // What was held for the new rows is given to them next, before they are paired, so a Transaction that comes back marked Not a Transfer is
    // never paired (transfers.ts); and their Transfers are paired in the same batch, for the same reason as the Rules. The last chunk of a replace
    // clears what nothing claimed after that; the last chunk of any other Import only drops what it has finished with.
    const { give, finish } = carryStatements(carryPlan, {
      apply: () => db.prepare(APPLY_HELD).bind(existing!.id, rowsJson),
      markApplied: () => db.prepare(MARK_APPLIED).bind(existing!.id, rowsJson),
      clear: () => db.prepare(CLEAR_HELD).bind(existing!.id),
      tidy: () => db.prepare(TIDY_HELD).bind(existing!.id),
    })
    // The file's ledger balance is recorded with its last chunk, once every row is in, so an Import that stops part way
    // doesn't claim a balance. It goes after the insert, which it follows in the batch.
    const ledger = file.ledgerBalance
    const statements = [
      ...planned,
      applyRulesStatement(db, { accountNumber: number, afterId }),
      ...give,
      pairTransfersStatement(db, { accountNumber: number, afterId }),
      ...finish,
      ...(lastChunk
        ? [recordBalance(db, { accountNumber: number, asOfDate: ledger.date, bankCents: ledger.cents, source: 'import', status: statusOnRecord({ asOfDate: ledger.date, fileTo: file.to, cutoverDate: effectiveCutover }) })]
        : []),
    ]
    const insertAt = planned.length - 1
    // The Rules follow the insert, then come what is given out (and the statement that marks it given: its count is what was carried), then the
    // pairing, whose count of rows changed is two for each pair made.
    const markAt = planned.length + 2
    const pairAt = planned.length + 1 + give.length
    // Every chunk is its own Change Log entry, written in the same batch as its rows. Its counts are the ones worked out before the batch ran (`counts` above): two identical
    // chunks landing together could each say they added rows that only one did, and the response below, from the batch, has what was done.
    const outcome = { accountName: name, replace: replace === true, removed: toRemove, added, dropped, index: chunk.index, count: chunk.count, carry }
    const results = await recordChange(db, statements, {
      actor: c.var.member,
      type: 'import',
      summary: chunkSummary(outcome),
      onlyIfChanged: false,
      ...(setsCutover ? { before: { cutoverDate: existing?.cutover_date ?? null } } : {}),
      after: chunkDetail(outcome, { file, rowsInChunk: rows.length, cutoverDate: effectiveCutover, newAccount: !existing }),
    })
    const accountId = existing?.id ?? results[0]!.meta.last_row_id
    const inserted = results[insertAt]!.meta.changes
    // After the last chunk, every balance of the Account is checked again: this file's, and the neighbours it changes.
    const balanceCheck = lastChunk ? await checkAfterRecording(db, accountId, ledger.date) : null
    // The response says what the batch did (rows marked given out), where the Change Log entry, written before it, said what was counted.
    const done = carryOutcome(carryPlan, counts, lastChunk, carryPlan.applies ? results[markAt]!.meta.changes : 0)
    return c.json({
      accountId,
      added: inserted,
      duplicates: rows.length - dropped - inserted,
      dropped,
      removed: replace && existing ? results[insertAt - 1]!.meta.changes : 0,
      // Pairs of Transactions this chunk matched as Transfers with another Account's, counting both halves once. The Change Log entry
      // was written with the rows, before there was a count to put in it.
      paired: results[pairAt]!.meta.changes / 2,
      // Transactions this chunk gave an Override, Note or Not a Transfer mark from the replaced history. On the last chunk of an Import that took
      // part (carry-over.ts), also the total over all its chunks and how many went to a Transaction with another amount,
      // and how many Overrides, Notes and Not a Transfer marks found no Transaction (lost, with the Transactions they were on, when a replace
      // finishes; still waiting after any other Import).
      carried: done?.carried ?? 0,
      carriedTotal: done?.carriedTotal ?? null,
      differingAmount: done?.differing ?? null,
      lost: done?.lost ?? null,
      lostTransactions: done?.lostRows ?? [],
      stillWaiting: done?.stillWaiting ?? null,
      balanceCheck,
    })
  })
  // How many Import-sourced rows an Account holds, and how many of those carry the Admin's own work (an Override to a
  // Category in use, a Note or a Not a Transfer mark), so the Admin is told what a replace will carry over before confirming. A removed
  // Category's Override doesn't count: the Admin was told when they removed it that the Transactions lose it. Also how many
  // Overrides, Notes and Not a Transfer marks an earlier replace that stopped part way is still holding for the Account, and how many of the rows are
  // half of a Transfer, which cost more writes to remove and to import again (import-rows.ts: WRITES_PER_PAIRED_REMOVED).
  .get('/imported/:accountId', async (c) => {
    const accountId = pathId(c.req.param('accountId'))
    if (accountId === null) return c.json({ error: 'Not found' }, 404)
    const db = c.env.DB
    const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(accountId).first()
    if (!account) return c.json({ error: 'Not found' }, 404)
    const counts = await db.prepare(COUNT_IMPORTED_AND_ANNOTATED).bind(accountId).first<{ imported: number; annotated: number; paired: number; waiting: number }>()
    return c.json({ imported: counts?.imported ?? 0, withOwnWork: counts?.annotated ?? 0, paired: counts?.paired ?? 0, carryOverWaiting: counts?.waiting ?? 0 })
  })
  // One step of clearing a history too big to replace in a single chunk (more than REPLACE_SLICE rows): the Admin's
  // browser calls it until the rest fits, then sends the first chunk with `replace`. Each step is logged. It refuses
  // (409) when the history already fits, so it can't be used to remove rows outside a replace.
  .post('/clear-history', validate('json', clearRequest), async (c) => {
    const { accountId } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(accountId).first<{ name: string }>()
    if (!account) return c.json({ error: 'Not found' }, 404)

    const total = (await db.prepare(COUNT_IMPORTED).bind(accountId).first<{ n: number }>())?.n ?? 0
    if (total <= REPLACE_SLICE) return c.json({ error: 'The imported history is small enough to replace in one go', remaining: total }, 409)
    const remaining = total - REPLACE_SLICE
    // The first row this step leaves, which is how a step knows its slice is still the one it counted (STILL_THE_SAME).
    const boundary = (await db.prepare(FIRST_ROW_LEFT).bind(accountId, REPLACE_SLICE).first<{ id: number }>())?.id
    if (boundary === undefined) return c.json({ error: 'The imported history is small enough to replace in one go', remaining: total }, 409)
    // The Overrides, Notes and Not a Transfer marks of the rows this step removes are held for the Import that follows (carry-over.ts).
    const held = (await db.prepare(COUNT_REMOVED_ANNOTATED).bind(accountId, REPLACE_SLICE).first<{ n: number }>())?.n ?? 0
    const kept = held > 0 ? `, keeping the ${CARRIED} of ${held} ${held === 1 ? 'Transaction' : 'Transactions'} to carry over` : ''
    // The balances of the history being replaced go with its first step: they describe Transactions that are going. Each statement is the one a replace uses, made to do
    // nothing unless the slice is still the one that was counted (?3 is the boundary), and the removal is last, which `onlyIfChanged` looks at.
    const [, , , removed] = await recordChange(
      db,
      [
        db.prepare(CLEAR_BALANCES_IF_SAME).bind(accountId, REPLACE_SLICE, boundary),
        db.prepare(HOLD_REMOVED_IF_SAME).bind(accountId, REPLACE_SLICE, boundary),
        db.prepare(UNPAIR_PARTNERS_IF_SAME).bind(accountId, REPLACE_SLICE, boundary),
        db.prepare(DELETE_IMPORTED_IF_SAME).bind(accountId, REPLACE_SLICE, boundary),
      ],
      {
        actor: c.var.member,
        type: 'import',
        summary: `Removed ${REPLACE_SLICE} imported rows from ${account.name} to replace its imported history (${remaining} left)${kept}`,
        after: { removed: REPLACE_SLICE, remaining, ...(held > 0 ? { heldForCarryOver: held } : {}) },
        onlyIfChanged: true,
      },
    )
    if (removed!.meta.changes === 0) {
      // Nothing was removed: another step, or an Import, changed how many rows the Account holds since they were counted.
      const now = (await db.prepare(COUNT_IMPORTED).bind(accountId).first<{ n: number }>())?.n ?? 0
      return now <= REPLACE_SLICE ? c.json({ error: 'The imported history is small enough to replace in one go', remaining: now }, 409) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ removed: REPLACE_SLICE, remaining })
  })
  // What a replace with this file would do with the Account's Overrides, Notes and Not a Transfer marks, for the Replace question to say before
  // the Admin confirms: nothing is changed. The browser sends the file's IDs and amounts (already without the rows on or
  // after the Cutover Date) at most 500 at a time, as an Import does; `carries` and `differing` add up over the requests,
  // `waiting` is the Account's own and is the same in each. A POST with a body because the rows do not fit a URL; the
  // guard has already required the Admin. One D1 query beside finding the Account.
  .post('/carry-preview', validate('json', previewRequest), async (c) => {
    const { accountId, rows } = c.req.valid('json')
    const db = c.env.DB
    const badField = badPreviewField(rows)
    if (badField) return c.json({ error: 'Invalid request', field: badField }, 400)
    const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(accountId).first()
    if (!account) return c.json({ error: 'Not found' }, 404)
    const counts = (await db.prepare(CARRY_PREVIEW).bind(null, serialisePreviewRows(rows), null, accountId, accountId, 0).first<CarryCounts>())!
    return c.json({ waiting: counts.waiting, carries: counts.carried, differing: counts.differing })
  })
  // Throws away the Overrides, Notes and Not a Transfer marks a replace that stopped part way is still holding for the Account (they stay until
  // a replace completes or the Admin does this), and says in the Change Log which Transactions they were on.
  .post('/discard-held', validate('json', clearRequest), async (c) => {
    const { accountId } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(accountId).first<{ name: string }>()
    if (!account) return c.json({ error: 'Not found' }, 404)
    const waiting = (await db.prepare(WAITING_LIST).bind(accountId).first<{ n: number; listed: string }>())!
    if (waiting.n === 0) return c.json({ error: 'Nothing is waiting to be carried over', waiting: 0 }, 409)
    // Only while the Account is still waiting on as many as were counted, which is what the entry says: another discard, or an Import that gives some out, can land between.
    const [discarded] = await recordChange(db, db.prepare(CLEAR_HELD_IF_WAITING).bind(accountId, waiting.n), {
      actor: c.var.member,
      type: 'import',
      summary: `Discarded the ${CARRIED} of ${waiting.n} ${waiting.n === 1 ? 'Transaction' : 'Transactions'} that ${account.name} was holding from a replace that did not finish`,
      after: { discarded: waiting.n, lostTransactions: parseLostRows(waiting.listed) },
      onlyIfChanged: true,
    })
    if (discarded!.meta.changes === 0) {
      const now = (await db.prepare(WAITING_LIST).bind(accountId).first<{ n: number }>())?.n ?? 0
      return now === 0 ? c.json({ error: 'Nothing is waiting to be carried over', waiting: 0 }, 409) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ discarded: waiting.n })
  })
