import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName, bankAccountNumber, normaliseAccountNumber } from './account-fields'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { badRowField, isRealDate, MAX_CHUNKS, serialiseRows, type ImportRow } from './import-rows'
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
// - A chunk request costs 3 D1 queries (find the Account, count the rows it already holds, then one batch of at
//   most 3 statements), well under 50.
// - MAX_CHUNKS (import-rows.ts) keeps one Import within the free plan's 100k D1 row writes a day.

const isoDate = z.string().check(z.refine(isRealDate))

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
})

// `ON CONFLICT … DO NOTHING` ignores only a repeat of the bank's unique ID, unlike `OR IGNORE`, which would also
// swallow a bad row. A repeat is a duplicate: it adds no row, so duplicates = rows sent - rows added.
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
  WHERE true
  ON CONFLICT (account_id, bank_unique_id) WHERE bank_unique_id IS NOT NULL DO NOTHING`

// How many different unique IDs the chunk carries, and how many of those the Account already holds. The insert
// adds the difference, so the chunk's Change Log entry (written in the same batch as the insert) can say so up front.
const COUNT_NEW_ROWS = `
  WITH incoming AS (SELECT DISTINCT json_extract(value, '$.uniqueId') AS id FROM json_each(?2))
  SELECT COUNT(*) AS ids, COUNT(t.id) AS held
  FROM incoming LEFT JOIN transactions t ON t.account_id = ?1 AND t.bank_unique_id = incoming.id`

export const imports = new Hono<AppEnv>().post('/chunks', validate('json', chunkRequest), async (c) => {
  const { account, chunk, file, rows } = c.req.valid('json')
  const db = c.env.DB
  const badField = badRowField(rows)
  if (badField) return c.json({ error: 'Invalid request', field: badField }, 400)

  const number = normaliseAccountNumber(account.number)
  const existing = await db.prepare('SELECT id, name FROM accounts WHERE account_number = ?').bind(number).first<{ id: number; name: string }>()
  if (!existing && chunk.index !== 0) return c.json({ error: 'Send the first chunk of the Import first' }, 409)

  const rowsJson = serialiseRows(rows)
  const { ids, held } = (await db.prepare(COUNT_NEW_ROWS).bind(existing?.id ?? null, rowsJson).first<{ ids: number; held: number }>())!
  const added = ids - held
  const name = existing?.name ?? account.name ?? number
  const create = existing ? [] : [db.prepare('INSERT INTO accounts (account_number, name) VALUES (?, ?)').bind(number, name)]

  // Every chunk is its own Change Log entry, written in the same batch as its rows, so the log says exactly what
  // was saved even if the Import stops part way.
  const results = await recordChange(db, [...create, db.prepare(INSERT_ROWS).bind(number, rowsJson)], {
    actor: c.var.member,
    summary: `Imported ${added} rows into ${name}${chunk.count > 1 ? ` (part ${chunk.index + 1} of ${chunk.count})` : ''}`,
    after: {
      adapter: file.adapterId,
      part: chunk.index + 1,
      parts: chunk.count,
      added,
      duplicates: rows.length - added,
      fileRows: file.rowCount,
      skipped: file.skipped,
      from: file.from,
      to: file.to,
      newAccount: !existing,
    },
  })
  const accountId = existing?.id ?? results[0]!.meta.last_row_id
  await afterTransactionsChanged(db, { accountId })
  return c.json({ accountId, added: results.at(-1)!.meta.changes, duplicates: rows.length - results.at(-1)!.meta.changes })
})
