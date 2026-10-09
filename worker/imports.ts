import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName, bankAccountNumber, isoDate, normaliseAccountNumber } from './account-fields'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { badRowField, MAX_CHUNKS, REPLACE_SLICE, serialiseRows, type ImportRow } from './import-rows'
import { afterTransactionsChanged } from './transactions-changed'
import { validate } from './validate'

// The browser parses the file (ADR 0004) and sends rows in chunks of about 500. Limits measured and chosen
// (D1 limits from developers.cloudflare.com/d1/platform/limits, checked 2026-10):
// - D1 allows 100 bound parameters per statement, so inserting rows one `?` per value caps a statement at 11 rows
//   and a 500-row chunk would need 46 statements (the free plan allows 50 D1 queries per invocation).
//   Instead a chunk is bound as ONE parameter, a JSON array, and unpacked in SQL with json_each: 500 rows are
//   one INSERT statement with one bound parameter.
// - A bound string may be 2 MB. Row fields are length-capped (import-rows.ts); 500 worst-case rows measured 335 KB.
// - 10 ms of CPU: reading, checking and re-serialising 500 typical rows (86 KB) measured about 1-2 ms in Node.
// - A chunk request costs at most 4 D1 queries (find the Account, count the Import-sourced rows to replace, count the
//   rows it already holds, then one batch of at most 4 statements), well under 50.
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
  }),
  // Checked by badRowField: a schema is too slow for 500 rows within 10 ms of CPU (CODING_STANDARDS.md#structure).
  // The custom type only carries the type.
  rows: z.custom<ImportRow[]>(),
  /** Set the Account's Cutover Date to this before importing (first chunk only), so rows on or after it are dropped. */
  cutoverDate: z.optional(isoDate),
  /** Remove the Account's Import-sourced Transactions in the same batch as this chunk (first chunk only). */
  replace: z.optional(z.boolean()),
})
  // Whole-Import options ride on the first chunk, where they apply once and atomically with its rows.
  .check(z.refine((request) => request.cutoverDate === undefined || request.chunk.index === 0, { path: ['cutoverDate'] }))
  .check(z.refine((request) => !request.replace || request.chunk.index === 0, { path: ['replace'] }))

const clearRequest = z.object({ accountId: z.int().check(z.minimum(1)) })

// `ON CONFLICT … DO NOTHING` ignores only a repeat of the bank's unique ID, unlike `OR IGNORE`, which would also
// swallow a bad row. A repeat is a duplicate: it adds no row, so duplicates = rows kept - rows added.
// ?3 is the Cutover Date (or null): rows dated on or after it are not inserted. ISO dates compare correctly as text.
const INSERT_ROWS = `
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
const COUNT_NEW_ROWS = `
  WITH incoming AS (SELECT DISTINCT json_extract(value, '$.uniqueId') AS id FROM json_each(?2) WHERE ?3 IS NULL OR json_extract(value, '$.date') < ?3)
  SELECT COUNT(*) AS ids, COUNT(t.id) AS held,
         (SELECT COUNT(*) FROM json_each(?2) WHERE ?3 IS NOT NULL AND json_extract(value, '$.date') >= ?3) AS dropped
  FROM incoming LEFT JOIN transactions t ON t.account_id = ?1 AND t.bank_unique_id = incoming.id`

const COUNT_IMPORTED = "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND source = 'import'"

// Only ever Import-sourced rows: Sync-sourced Transactions are never removed here.
const DELETE_IMPORTED = "DELETE FROM transactions WHERE account_id = ? AND source = 'import'"
const DELETE_IMPORTED_SLICE = `DELETE FROM transactions WHERE id IN (SELECT id FROM transactions WHERE account_id = ?1 AND source = 'import' ORDER BY id LIMIT ?2)`

type AccountRow = { id: number; name: string; cutover_date: string | null }

export const imports = new Hono<AppEnv>()
  .post('/chunks', validate('json', chunkRequest), async (c) => {
    const { account, chunk, file, rows, cutoverDate, replace } = c.req.valid('json')
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
    // When replacing, the rows being removed don't count as already held.
    const counts = (await db.prepare(COUNT_NEW_ROWS).bind(replace ? null : (existing?.id ?? null), rowsJson, effectiveCutover).first<{ ids: number; held: number; dropped: number }>())!
    const { dropped } = counts
    const added = counts.ids - counts.held
    const name = existing?.name ?? account.name ?? number
    const setsCutover = cutoverDate !== undefined

    const statements = [
      ...(existing ? [] : [db.prepare('INSERT INTO accounts (account_number, name, cutover_date) VALUES (?, ?, ?)').bind(number, name, effectiveCutover)]),
      ...(existing && setsCutover ? [db.prepare('UPDATE accounts SET cutover_date = ? WHERE id = ?').bind(cutoverDate, existing.id)] : []),
      ...(replace && existing ? [db.prepare(DELETE_IMPORTED).bind(existing.id)] : []),
      db.prepare(INSERT_ROWS).bind(number, rowsJson, effectiveCutover),
    ]
    const part = chunk.count > 1 ? ` (part ${chunk.index + 1} of ${chunk.count})` : ''
    const skipped = dropped > 0 ? `, skipped ${dropped} dated on or after the Cutover Date` : ''
    // Every chunk is its own Change Log entry, written in the same batch as its rows, so the log says exactly what
    // was saved even if the Import stops part way.
    const results = await recordChange(db, statements, {
      actor: c.var.member,
      summary: replace
        ? `Replaced imported history in ${name}: removed ${toRemove} rows, imported ${added} rows${skipped}${part}`
        : `Imported ${added} rows into ${name}${skipped}${part}`,
      ...(setsCutover ? { before: { cutoverDate: existing?.cutover_date ?? null } } : {}),
      after: {
        adapter: file.adapterId,
        part: chunk.index + 1,
        parts: chunk.count,
        added,
        duplicates: rows.length - dropped - added,
        dropped,
        cutoverDate: effectiveCutover,
        replaced: replace === true,
        removed: toRemove,
        fileRows: file.rowCount,
        skipped: file.skipped,
        from: file.from,
        to: file.to,
        newAccount: !existing,
      },
    })
    const accountId = existing?.id ?? results[0]!.meta.last_row_id
    await afterTransactionsChanged(db, { accountId })
    const inserted = results.at(-1)!.meta.changes
    return c.json({ accountId, added: inserted, duplicates: rows.length - dropped - inserted, dropped, removed: replace && existing ? results.at(-2)!.meta.changes : 0 })
  })
  // One step of clearing a history too big to replace in a single chunk (REPLACE_SLICE rows): the Admin's browser calls
  // it until the rest fits, then sends the first chunk with `replace`. Each step is logged.
  .post('/clear-history', validate('json', clearRequest), async (c) => {
    const { accountId } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(accountId).first<{ name: string }>()
    if (!account) return c.json({ error: 'Not found' }, 404)

    const total = (await db.prepare(COUNT_IMPORTED).bind(accountId).first<{ n: number }>())?.n ?? 0
    const removed = Math.min(total, REPLACE_SLICE)
    const remaining = total - removed
    await recordChange(db, db.prepare(DELETE_IMPORTED_SLICE).bind(accountId, REPLACE_SLICE), {
      actor: c.var.member,
      summary: `Removed ${removed} imported rows from ${account.name} to replace its imported history (${remaining} left)`,
      after: { removed, remaining },
    })
    await afterTransactionsChanged(db, { accountId })
    return c.json({ removed, remaining })
  })
