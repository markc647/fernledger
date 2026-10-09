import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { badRowField, type ImportRow } from './import-rows'
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
// - A chunk request costs 2 D1 queries (find the Account, then one batch of at most 3 statements), well under 50.
// - Free-plan D1 allows 100k rows written a day, and each index entry counts too. A row costs 3 writes (row, date
//   index, unique index), so MAX_CHUNKS caps one Import at 30k rows, 90k writes. Duplicates write nothing.
const MAX_CHUNKS = 60

const isoDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/))

const chunkRequest = z.object({
  account: z.object({
    number: z.string().check(z.regex(/^\d{2}-\d{4}-\d{7}-\d{2,3}$/)),
    /** Used only when this chunk creates the Account. */
    name: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(60))),
  }),
  chunk: z.object({ index: z.int().check(z.minimum(0), z.maximum(MAX_CHUNKS - 1)), count: z.int().check(z.minimum(1), z.maximum(MAX_CHUNKS)) }),
  /** About the whole file, for the Change Log entry. */
  file: z.object({
    adapterId: z.string().check(z.maxLength(40)),
    rowCount: z.int().check(z.minimum(0)),
    skipped: z.int().check(z.minimum(0)),
    from: isoDate,
    to: isoDate,
  }),
  // Checked by badRowField: a schema is too slow for 500 rows within 10 ms of CPU. The custom type only carries the type.
  rows: z.custom<ImportRow[]>(),
})

// `ON CONFLICT … DO NOTHING` ignores only a repeat of the bank's unique ID, unlike `OR IGNORE`, which would also
// swallow a bad row. A repeat is a duplicate: it adds no row, so duplicates = rows sent - rows added.
const INSERT_ROWS = `
  INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, type, reference, source, bank_unique_id)
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

export const imports = new Hono<AppEnv>().post('/chunks', validate('json', chunkRequest), async (c) => {
  const { account, chunk, file, rows } = c.req.valid('json')
  const db = c.env.DB
  const badField = badRowField(rows)
  if (badField) return c.json({ error: 'Invalid request', field: badField }, 400)

  const existing = await db.prepare('SELECT id, name FROM accounts WHERE account_number = ?').bind(account.number).first<{ id: number; name: string }>()
  if (!existing && chunk.index !== 0) return c.json({ error: 'Send the first chunk of the Import first' }, 409)

  const insertRows = db.prepare(INSERT_ROWS).bind(account.number, JSON.stringify(rows))
  let accountId = existing?.id
  let inserted: D1Result

  if (chunk.index === 0) {
    // The Import's one Change Log entry is written with its first chunk (and the Account, if the Import creates it),
    // so an Import that stops part way is still on the record. The later chunks continue that Import.
    const name = existing?.name ?? account.name ?? account.number
    const create = existing ? [] : [db.prepare('INSERT INTO accounts (account_number, name) VALUES (?, ?)').bind(account.number, name)]
    const results = await recordChange(db, [...create, insertRows], {
      actor: c.var.member,
      summary: `Imported ${file.rowCount} rows into ${name}`,
      after: { adapter: file.adapterId, rows: file.rowCount, skipped: file.skipped, from: file.from, to: file.to, chunks: chunk.count, newAccount: !existing },
    })
    inserted = results.at(-1)!
    accountId ??= results[0]!.meta.last_row_id
  } else {
    inserted = (await db.batch([insertRows]))[0]!
  }

  const added = inserted.meta.changes
  if (chunk.index === chunk.count - 1) await afterTransactionsChanged(db, { accountId: accountId! })
  return c.json({ accountId: accountId!, added, duplicates: rows.length - added })
})
