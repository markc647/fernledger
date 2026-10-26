// Layout reference: docs/bank-formats/kiwibank.md (Credit cards)
//
// Kiwibank's credit card export: four columns, `Date,Description,Card,Amount`, with no account number and no balance. Both
// absences are what ticket 39 is about:
//
// - **Nothing in the file identifies the account.** The card number is not it — a card is reissued on fraud or expiry, and one
//   sample held three card numbers for one account over two years — so the file carries no `accountNumber` at all and the Import
//   asks the Admin which Account it is for ([ADR 0017](../../../docs/adr/0017-account-number-is-the-accounts-key.md)). The `Card`
//   column goes to `bank_card_suffix`, per Transaction, where it says which card was used, including across a reissue.
// - **There is no balance**, so there is no ledger balance and a card Account gets no Balance Check from an Import. Nothing is
//   added up from the Transactions to stand in for one.
//
// The dates and amounts are read by the bank-account adapter's parsers (kiwibank.ts): the same bank, a different layout. How a
// line and its fields are split is shared by every adapter (read.ts).
import { parseCents, parseDate } from './kiwibank'
import { splitFields, splitLines } from './read'
import { BankCsvError, type BankCsvAdapter, type BankCsvResult, type BankCsvRow, type BankCsvRowError } from './types'

const COLUMN_HEADER = 'Date,Description,Card,Amount'
const COLUMNS = COLUMN_HEADER.split(',')
/** The last four digits of the card used. */
const CARD = /^\d{4}$/

/**
 * The unique ID Kiwibank does not give, which here cannot be made the way the bank-account adapter makes one: that uses the
 * running balance, and this export has no balance column.
 *
 * So the row's date, its amount in cents, the card used, and which occurrence of those three this row is in the file. The first
 * three are what the bank cannot restate without being wrong about the money; the occurrence separates a day's identical
 * purchases, which a card really does have (two $4.50 coffees at the same shop), so both survive instead of one being taken for
 * a duplicate of the other. A later export that has gained a row of some other amount does not shift them, because only rows
 * sharing all three are counted.
 *
 * The description is left out on purpose, as it is in the bank-account adapter: it is the part a bank is most likely to re-word
 * between exports, and a re-import would then look like new Transactions rather than the ones already held.
 */
export const uniqueIdFor = (date: string, amountCents: number, card: string, occurrence: number) => `${date}:${amountCents}:${card}:${occurrence}`

type RowResult = { ok: true; date: string; amountCents: number; card: string; description: string } | { ok: false; message: string }

/** Error messages name the field only: values are transaction data and must not reach a log or a screen. */
function parseRow(fields: string[]): RowResult {
  if (fields.length !== COLUMNS.length) return { ok: false, message: `Expected ${COLUMNS.length} columns but found ${fields.length}` }
  const value = (name: string) => fields[COLUMNS.indexOf(name)]!.trim()

  const date = parseDate(value('Date'))
  if (!date) return { ok: false, message: 'Invalid Date' }

  const amountCents = parseCents(value('Amount'))
  if (amountCents === null) return { ok: false, message: 'Invalid Amount' }

  const card = value('Card')
  if (!CARD.test(card)) return { ok: false, message: 'Invalid Card' }

  return { ok: true, date, amountCents, card, description: value('Description') }
}

function parse(text: string): BankCsvResult {
  const lines = splitLines(text)
  if (lines[0]?.trim() !== COLUMN_HEADER) throw new BankCsvError(`Expected the column header "${COLUMN_HEADER}"`, 1)

  const rows: BankCsvRow[] = []
  const errors: BankCsvRowError[] = []
  // How many rows of each date, amount and card have been seen, so the next one of the same three gets the next occurrence.
  const seen = new Map<string, number>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const fields = splitFields(line)
    const result: RowResult = fields ? parseRow(fields) : { ok: false, message: 'Unbalanced quotes' }
    if (!result.ok) {
      errors.push({ line: i + 1, message: result.message })
      continue
    }
    const { date, amountCents, card, description } = result
    const key = `${date}:${amountCents}:${card}`
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    rows.push({
      date,
      uniqueId: uniqueIdFor(date, amountCents, card, occurrence),
      // The bank prints no transaction type on a card export; the column holds '' for a row that has none, as it always has.
      tranType: '',
      chequeNumber: null,
      // The description is the only text the export gives, so it is both what the list shows and what the bank said.
      payee: description,
      bankMemo: description,
      amountCents,
      cardSuffix: card,
    })
  }

  if (rows.length === 0) throw new BankCsvError('No Transactions in this file')
  // The rows are not re-ordered (the occurrence in a unique ID is the file's own order), so the range is the dates' own extremes.
  const dates = rows.map((row) => row.date)

  return {
    adapterId: 'kiwibank-card',
    accountNumber: null,
    ledgerBalance: null,
    dateRange: { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) },
    rows,
    errors,
  }
}

export const kiwibankCardAdapter: BankCsvAdapter = {
  id: 'kiwibank-card',
  name: 'Kiwibank credit card',
  detect: (text) => splitLines(text)[0]?.trim() === COLUMN_HEADER,
  parse,
}
