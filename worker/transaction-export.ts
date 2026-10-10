import * as z from 'zod/mini'
import { effectiveCategory } from './effective-category'
import { buildFilter, filterChecks, filterFields, type Filters, type Statement } from './transaction-search'

// The CSV export (GET /api/transactions/export.csv): every Transaction the list's filters keep, oldest first, as a file for a
// spreadsheet. It takes the list's filters and nothing else (no sort, no paging), and builds its SQL from the list's `buildFilter`,
// so the two can't disagree about what a filter means.
//
// Free plan (ADR 0004): an invocation gets 10 ms of CPU and 50 D1 queries, and parsing and formatting rows in JS costs about
// 2 microseconds a row, so a 50,000-row export would be ten times the budget. As the backup does (worker/backup.ts), D1 builds
// the text: each query returns a chunk of Transactions as one finished string, so the Worker only passes strings along and its
// cost goes by bytes, not rows. Chunks are keyset pages on (date, id), never OFFSET, so a late chunk doesn't re-read the early
// ones. Three limits keep one request inside the plan, and the file says so when it stops at one of them:
// - EXPORT_MAX_ROWS Transactions a file: what a Member is told, and what keeps the D1 queries to about ten.
// - EXPORT_CHUNK_BYTES a chunk: far under the 2 MB D1 allows in one string, whatever the fields hold (the Sync fields have no
//   length limit yet). A chunk that would be longer is cut short, and the next starts where it ended.
// - EXPORT_MAX_BYTES a file: the CPU goes by bytes, so a history of long Notes stops sooner than the row limit.
// The Worker's CPU for this can't be seen from a test, so the limits are an estimate. Timed in a local workerd on a busy
// machine, the Worker's own steps for a 10,000-row export (1.1 MB: decoding the 21 D1 answers, then handing the text to a
// Response as a Blob) took 4 to 6 ms, 6 to 14 ms when joined into one string first and read back. That leaves too little of
// 10 ms once sign-in and D1's own overhead are added, so a file holds half as much: 5,000 rows is an estimated 2 to 3 ms.
// If requests start to fail with CPU errors (1102), lower EXPORT_MAX_ROWS and EXPORT_MAX_BYTES.
// It is built whole before any of it is sent, so a failure is an error and not a file that stops short and looks complete.
//
// The file, for a spreadsheet:
// - It starts with a UTF-8 byte order mark. Without one Excel on Windows reads a CSV as the local code page and garbles
//   macrons (Whāngārei, Māori). Programs that don't expect one, such as a script that reads the file as plain UTF-8, will see
//   it as an invisible first character in the first heading; Python wants encoding='utf-8-sig', and Google Sheets, LibreOffice,
//   Numbers and pandas drop it themselves.
// - Lines end CRLF (RFC 4180). A text cell with a comma, a quote or a line break is quoted, with quotes doubled. Dates are
//   YYYY-MM-DD NZ dates; an Amount is dollars with a minus sign for Money out, unquoted, so it is a number.
// - A text cell that starts with = + - @ tab or carriage return would run as a formula in a spreadsheet, so it gets a ' in front
//   (OWASP's CSV injection advice). The Date and Amount are written by this code and are never text, so they are not escaped.
// - Every bank field is a column, empty where the bank gave none (a bank file has no counterparty account, particulars, code or
//   card), so the layout doesn't change when Sync starts to fill them.
// - A Transaction with no Category says "Uncategorised", as the page does. A Category an Admin has really named "Uncategorised"
//   can't be told apart from it; that is the page's ambiguity too.
// - The totals follow the Transactions after a blank line, as label and value in the first two columns. The value isn't in the
//   Amount column, so adding up the Amount column still gives the Net, and a sort, filter or table in the spreadsheet stops
//   at the blank line instead of taking the totals with it.

/** The most Transactions in a file, and so the most the page tells a Member to expect. */
export const EXPORT_MAX_ROWS = 5_000
/** Transactions in one D1 query, at most. */
export const EXPORT_CHUNK_ROWS = 500
/** The most text in one D1 query's string, as the backup's CHUNK_BYTES is: an eighth of what D1 allows. */
export const EXPORT_CHUNK_BYTES = 262_144
/** About the most text in a file (it can overshoot by up to one chunk). 5,000 ordinary Transactions come to about 0.6 MB, so this is met only by long Notes. */
export const EXPORT_MAX_BYTES = 750_000

export const EXPORT_HEADER = [
  'Date',
  'Account',
  'Description',
  'Category',
  'Note',
  'Amount',
  'Bank type',
  'Bank memo',
  'Bank reference',
  'Bank counterparty account',
  'Bank particulars',
  'Bank payment code',
  'Bank card suffix',
] as const

/** The export's query string: the list's filters. */
export const exportQuery = z.object(filterFields).check(...filterChecks)

/** The file's name has the dates asked for and nothing else: not an Account, a Category or what was searched for. */
export function exportFilename({ from, to }: Filters): string {
  const range = from && to ? `${from}-to-${to}` : from ? `from-${from}` : to ? `to-${to}` : 'all'
  return `fernledger-transactions-${range}.csv`
}

/** Integer cents as dollars with two digits of cents, and a minus sign for money out: -123456 is "-1234.56". Whole numbers only, no floats. */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents)
  const rest = abs % 100
  return `${cents < 0 ? '-' : ''}${(abs - rest) / 100}.${String(rest).padStart(2, '0')}`
}

// The pieces of SQL below take the name of a column of the `page` query, or a constant written here. Nothing from a request is
// ever put in the SQL: the filters are bound, as everywhere else.

/** `'` if the text starts with a character a spreadsheet would run as a formula, else nothing. */
const formulaGuard = (c: string) => `CASE WHEN substr(${c}, 1, 1) IN ('=', '+', '-', '@', char(9), char(13)) THEN '''' ELSE '' END`

/** One text cell: empty if there is no text, quoted if it has a quote, comma or line break, and guarded against a formula. */
const textCell = (c: string) =>
  `CASE WHEN ${c} IS NULL OR ${c} = '' THEN ''
        WHEN ${c} GLOB ('*[",' || char(13) || char(10) || ']*') THEN '"' || ${formulaGuard(c)} || replace(${c}, '"', '""') || '"'
        ELSE ${formulaGuard(c)} || ${c} END`

/** Cents as the same text `centsToDecimal` gives, for the Transactions' own lines. */
const amountCell = (c: string) => `printf('%s%d.%02d', CASE WHEN ${c} < 0 THEN '-' ELSE '' END, abs(${c}) / 100, abs(${c}) % 100)`

/** Where a chunk starts: after this Transaction, in date and ID order. Before the first chunk, before all of them. */
export type After = { date: string; id: number }

/**
 * One chunk: up to `limit` Transactions that match the filters, after `after`, and no more of them than fit in `maxBytes` (but
 * always the first). It returns `fetched`, how many it found; `n`, how many of those are in `body` (the same, unless the bytes ran
 * out); `body`, their lines separated by CRLF; `bytes`, the length of those lines with their line ends; their Money in and Money
 * out in cents; and `lastKey`, the date and ID of the last (see `chunkEnd`), which is `after` for the next chunk.
 *
 * The lines are joined with `group_concat` over rows read in (date, id) order, which SQLite does not promise (the order of a
 * `group_concat` is "arbitrary" in its documentation). It follows the rows' order in every version we run on, as the backup's
 * does, and a test inserts out of order to catch the day it doesn't.
 */
export function exportChunk(filters: Filters, after: After, limit: number, maxBytes = EXPORT_CHUNK_BYTES): Statement {
  const category = effectiveCategory()
  const { conditions, binds } = buildFilter(filters, category)
  const where = [...conditions, '(t.date, t.id) > (?, ?)'].join(' AND ')
  // Whether a row fits the byte limit, which is the last value bound: the filters', the cursor's two, the row limit, then this.
  // (Named by number because it is used in several places; the others are anonymous and come first.)
  const kept = `(pos = 1 OR bytes <= ?${binds.length + 4})`
  const line = [
    'date',
    textCell('account'),
    textCell('description'),
    textCell('category'),
    textCell('note'),
    amountCell('cents'),
    textCell('type'),
    textCell('memo'),
    textCell('reference'),
    textCell('counterparty'),
    textCell('particulars'),
    textCell('code'),
    textCell('card'),
  ].join(` || ',' || `)
  return {
    sql: `WITH page AS (
            SELECT t.id, t.date, t.amount_cents AS cents, a.name AS account, t.description AS description,
                   COALESCE(${category.name}, 'Uncategorised') AS category, t.note AS note, t.bank_type AS type, t.bank_memo AS memo,
                   t.bank_reference AS reference, t.bank_counterparty_account AS counterparty, t.bank_particulars AS particulars,
                   t.bank_payment_code AS code, t.bank_card_suffix AS card
            FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
            WHERE ${where}
            ORDER BY t.date, t.id LIMIT ?
          ),
          sized AS (
            SELECT id, date, cents, line, row_number() OVER w AS pos, sum(length(CAST(line AS BLOB)) + 2) OVER w AS bytes
            FROM (SELECT id, date, cents, ${line} AS line FROM page)
            WINDOW w AS (ORDER BY date, id)
          )
          SELECT group_concat(CASE WHEN ${kept} THEN line END, char(13) || char(10)) AS body,
                 count(CASE WHEN ${kept} THEN 1 END) AS n,
                 count(*) AS fetched,
                 COALESCE(max(CASE WHEN ${kept} THEN bytes END), 0) AS bytes,
                 COALESCE(sum(CASE WHEN ${kept} AND cents > 0 THEN cents END), 0) AS moneyIn,
                 COALESCE(sum(CASE WHEN ${kept} AND cents < 0 THEN cents END), 0) AS moneyOut,
                 max(CASE WHEN ${kept} THEN date || ' ' || printf('%020d', id) END) AS lastKey
          FROM sized`,
    binds: [...binds, after.date, after.id, limit, maxBytes],
  }
}

/** A row of what `exportChunk` returns. */
export type Chunk = { body: string | null; n: number; fetched: number; bytes: number; moneyIn: number; moneyOut: number; lastKey: string | null }

/**
 * Where the next chunk starts: after the last Transaction this one wrote. SQL gives it as one value, 'YYYY-MM-DD' and the ID
 * padded to 20 digits, because a second pass over the chunk to find the last row costs D1 reads (ADR 0004).
 */
export const chunkEnd = (chunk: Pick<Chunk, 'lastKey'>): After => ({ date: chunk.lastKey!.slice(0, 10), id: Number(chunk.lastKey!.slice(11)) })

async function readChunk(db: D1Database, filters: Filters, after: After, limit: number): Promise<Chunk> {
  const { sql, binds } = exportChunk(filters, after, limit)
  const chunk = await db.prepare(sql).bind(...binds).first<Chunk>()
  if (!chunk) throw new Error('A read returned no row') // an aggregate always returns one
  return chunk
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const EOL = '\r\n'

/** The whole file, as the pieces of its text in order. */
async function writeCsv(db: D1Database, filters: Filters): Promise<string[]> {
  const parts = [BYTE_ORDER_MARK, EXPORT_HEADER.join(','), EOL]
  let after: After = { date: '', id: 0 }
  let rows = 0
  let bytes = 0
  let moneyIn = 0
  let moneyOut = 0
  let capped = false
  for (;;) {
    const limit = Math.min(EXPORT_CHUNK_ROWS, EXPORT_MAX_ROWS - rows)
    const chunk = await readChunk(db, filters, after, limit)
    if (chunk.n > 0) {
      parts.push(chunk.body!, EOL)
      rows += chunk.n
      bytes += chunk.bytes
      moneyIn += chunk.moneyIn
      moneyOut += chunk.moneyOut
      after = chunkEnd(chunk)
    }
    // Fewer found than asked for, and all of them written, is the end of what matched.
    if (chunk.fetched < limit && chunk.n === chunk.fetched) break
    if (rows >= EXPORT_MAX_ROWS || bytes >= EXPORT_MAX_BYTES) {
      capped = (await readChunk(db, filters, after, 1)).fetched > 0
      break
    }
  }
  parts.push(EOL, 'Totals', EOL, `Money in,${centsToDecimal(moneyIn)}`, EOL, `Money out,${centsToDecimal(moneyOut)}`, EOL, `Net,${centsToDecimal(moneyIn + moneyOut)}`, EOL, `Transactions,${rows}`, EOL)
  // Written by hand, so it is quoted by hand: it has a comma and no quote.
  if (capped) parts.push(`"Only the first ${rows.toLocaleString('en-NZ')} Transactions are in this file, and more match. The totals cover only those. Narrow the dates or filters, then export again."`, EOL)
  return parts
}

/** The download: the file, never kept by the browser or anything between, named by its dates. */
export async function exportResponse(db: D1Database, filters: Filters): Promise<Response> {
  // A Blob of the pieces, not one joined string: a string body is encoded to bytes in one go, and joining it first costs again.
  return new Response(new Blob(await writeCsv(db, filters)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(filters)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
