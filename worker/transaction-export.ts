import * as z from 'zod/mini'
import { effectiveCategory } from './effective-category'
import { buildFilter, filterChecks, filterFields, type Filters, type Statement } from './transaction-search'

// The CSV export (GET /api/transactions/export.csv): every Transaction the list's filters keep, oldest first, as a file for a
// spreadsheet. It takes the list's filters and nothing else (no sort, no paging), and builds its SQL from the list's `buildFilter`,
// so the two can't disagree about what a filter means.
//
// Free plan (ADR 0004): an invocation gets 10 ms of CPU and 50 D1 queries, and parsing and formatting rows in JS costs about
// 2 microseconds a row, so a 50,000-row export would be ten times the budget. As the backup does (worker/backup.ts), D1 builds
// the text: each query returns up to EXPORT_CHUNK_ROWS Transactions as one finished string, so the Worker only passes strings
// along and its cost goes by bytes, not rows. Chunks are keyset pages on (date, id), never OFFSET, so a late chunk doesn't
// re-read the early ones. The file stops at EXPORT_MAX_ROWS, and says so, rather than risk a CPU error that would give the
// Member nothing. It is built whole before any of it is sent, so a failure is an error and not a file that stops short and
// looks complete.
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
// - The totals follow the Transactions after a blank line, as label and value in the first two columns. The value isn't in the
//   Amount column, so adding up the Amount column still gives the Net, and a sort, filter or table in the spreadsheet stops
//   at the blank line instead of taking the totals with it.

/** The most Transactions in a file. An Import is at most 10,000 rows, and about 1 MB of text, the same as one backup invocation. */
export const EXPORT_MAX_ROWS = 10_000
/**
 * Transactions in one D1 query: 20 queries (and one more to find out whether there were more) for the most, of the 50 an
 * invocation gets. Even rows of the longest fields, all quotes, come to under half of the 2 MB D1 allows in one string.
 */
export const EXPORT_CHUNK_ROWS = 500

export const EXPORT_HEADER = ['Date', 'Account', 'Description', 'Category', 'Note', 'Amount', 'Bank type', 'Bank reference'] as const

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
 * One chunk: up to `limit` Transactions that match the filters, after `after`, as `body` (their lines, separated by CRLF), how many
 * there were (`n`), their Money in and Money out in cents, and the date and ID of the last, which is `after` for the next chunk.
 */
export function exportChunk(filters: Filters, after: After, limit: number): Statement {
  const category = effectiveCategory()
  const { conditions, binds } = buildFilter(filters, category)
  const where = [...conditions, '(t.date, t.id) > (?, ?)'].join(' AND ')
  const line = [
    'date',
    textCell('account'),
    textCell('description'),
    textCell('category'),
    textCell('note'),
    amountCell('cents'),
    textCell('type'),
    textCell('reference'),
  ].join(` || ',' || `)
  return {
    sql: `WITH page AS (
            SELECT t.id, t.date, t.amount_cents AS cents, a.name AS account, t.description AS description,
                   COALESCE(${category.name}, 'Uncategorised') AS category, t.note AS note, t.bank_type AS type, t.bank_reference AS reference
            FROM transactions t JOIN accounts a ON a.id = t.account_id ${category.joins}
            WHERE ${where}
            ORDER BY t.date, t.id LIMIT ?
          )
          SELECT group_concat(${line}, char(13) || char(10)) AS body,
                 count(*) AS n,
                 COALESCE(sum(CASE WHEN cents > 0 THEN cents END), 0) AS moneyIn,
                 COALESCE(sum(CASE WHEN cents < 0 THEN cents END), 0) AS moneyOut,
                 (SELECT date FROM page ORDER BY date DESC, id DESC LIMIT 1) AS lastDate,
                 (SELECT id FROM page ORDER BY date DESC, id DESC LIMIT 1) AS lastId
          FROM page`,
    binds: [...binds, after.date, after.id, limit],
  }
}

type Chunk = { body: string | null; n: number; moneyIn: number; moneyOut: number; lastDate: string | null; lastId: number | null }

async function readChunk(db: D1Database, filters: Filters, after: After, limit: number): Promise<Chunk> {
  const { sql, binds } = exportChunk(filters, after, limit)
  const chunk = await db.prepare(sql).bind(...binds).first<Chunk>()
  if (!chunk) throw new Error('A read returned no row') // an aggregate always returns one
  return chunk
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const EOL = '\r\n'

/** The whole file as text. */
async function writeCsv(db: D1Database, filters: Filters): Promise<string> {
  const parts = [BYTE_ORDER_MARK, EXPORT_HEADER.join(','), EOL]
  let after: After = { date: '', id: 0 }
  let rows = 0
  let moneyIn = 0
  let moneyOut = 0
  let capped = false
  for (;;) {
    const limit = Math.min(EXPORT_CHUNK_ROWS, EXPORT_MAX_ROWS - rows)
    const chunk = await readChunk(db, filters, after, limit)
    if (chunk.n > 0) {
      parts.push(chunk.body!, EOL)
      rows += chunk.n
      moneyIn += chunk.moneyIn
      moneyOut += chunk.moneyOut
      after = { date: chunk.lastDate!, id: chunk.lastId! }
    }
    if (chunk.n < limit) break
    if (rows >= EXPORT_MAX_ROWS) {
      capped = (await readChunk(db, filters, after, 1)).n > 0
      break
    }
  }
  parts.push(EOL, 'Totals', EOL, `Money in,${centsToDecimal(moneyIn)}`, EOL, `Money out,${centsToDecimal(moneyOut)}`, EOL, `Net,${centsToDecimal(moneyIn + moneyOut)}`, EOL, `Transactions,${rows}`, EOL)
  // Written by hand, so it is quoted by hand: it has a comma and no quote.
  if (capped) parts.push(`"Only the first ${EXPORT_MAX_ROWS.toLocaleString('en-NZ')} Transactions are in this file, and more match. The totals cover only those. Narrow the dates or filters, then export again."`, EOL)
  return parts.join('')
}

/** The download: the file, never kept by the browser or anything between, named by its dates. */
export async function exportResponse(db: D1Database, filters: Filters): Promise<Response> {
  return new Response(await writeCsv(db, filters), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(filters)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
