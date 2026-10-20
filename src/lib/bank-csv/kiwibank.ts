// Layout reference: docs/bank-formats/kiwibank.md
//
// Kiwibank's bank-account export. Unlike ASB's it has no header block: line 1 is the column header and every row carries its own
// account number and running balance. Two consequences shape this adapter:
//
// - **There is no unique ID.** ASB gives one and `bank_unique_id` is what stops a re-import of an overlapping range adding every
//   row a second time (ADR 0003). Kiwibank gives nothing, so one is made from the row: see `uniqueIdFor`.
// - **The balance is per row, not in a header.** The file's ledger balance is therefore the newest row's, which is the last one:
//   the export is oldest first.
//
// The credit card export is a different format (four columns, no account number, no balance) and is not this adapter.
import { BankCsvError, type BankCsvAdapter, type BankCsvResult, type BankCsvRow, type BankCsvRowError } from './types'

const COLUMN_HEADER =
  'Account number,Effective Date,Transaction Date,Description,Transaction Code,Particulars,Code,Reference,Other Party Name,Other Party Account Number,Other Party Particulars,Other Party Code,Other Party Reference,Amount,Balance'

const COLUMNS = COLUMN_HEADER.split(',')
const ACCOUNT_NUMBER = /^\d{2}-\d{4}-\d{7}-\d{2,3}$/
const AMOUNT = /^(-|\+)?(\d+)(?:\.(\d{1,2}))?$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const splitLines = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\n|\r/)

/** `YYYY-MM-DD` to itself, or null when it is not a real day (the 30th of February). The only date parser here. */
function parseDate(text: string): string | null {
  const parts = ISO_DATE.exec(text)
  if (!parts) return null
  const [, year, month, day] = parts as unknown as [string, string, string, string]
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  const real = utc.getUTCFullYear() === Number(year) && utc.getUTCMonth() === Number(month) - 1 && utc.getUTCDate() === Number(day)
  return real ? `${year}-${month}-${day}` : null
}

function parseCents(text: string): number | null {
  const parts = AMOUNT.exec(text)
  if (!parts) return null
  const magnitude = Number(parts[2]) * 100 + Number((parts[3] ?? '').padEnd(2, '0'))
  return parts[1] === '-' && magnitude !== 0 ? -magnitude : magnitude
}

/** Splits one CSV line. Returns null if a quote is left open or text follows a closing quote. (Same reader as the ASB adapter's.) */
function splitFields(line: string): string[] | null {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = ''
      i++
      for (;;) {
        if (i >= line.length) return null
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i++
          break
        }
        value += line[i++]
      }
      if (i < line.length && line[i] !== ',') return null
      fields.push(value)
    } else {
      const end = line.indexOf(',', i)
      const stop = end === -1 ? line.length : end
      fields.push(line.slice(i, stop))
      i = stop
    }
    i++ // skip the comma
  }
  return fields
}

/**
 * The unique ID Kiwibank does not give, made from the row itself: its date, its amount and the account's balance after it.
 *
 * Why those three and nothing else. The balance is what makes it unique: two Transactions of the same amount on the same day
 * leave the account at different balances, because each one moves it. Within an Account the three together can repeat only for a
 * row that is identical in every way that matters, which is a genuine duplicate the bank has issued twice.
 *
 * Why not the description, particulars or payee. They would add nothing to uniqueness, and they are the parts a bank is most
 * likely to re-word between exports: a re-import would then look like new Transactions instead of the ones already held. The
 * three fields used here are arithmetic, and the bank cannot restate them without the balance history being wrong.
 *
 * It is a composite, not a hash: it cannot collide by chance, it is the same every time without a hash function to agree on, and
 * when something does go wrong it can be read. Cents are used, so no decimal point is in it.
 */
export const uniqueIdFor = (date: string, amountCents: number, balanceCents: number) => `${date}:${amountCents}:${balanceCents}`

type RowResult = { ok: true; row: BankCsvRow; accountNumber: string; balanceCents: number; date: string } | { ok: false; message: string }

/** Error messages name the field only: values are transaction data and must not reach a log or a screen. */
function parseRow(fields: string[]): RowResult {
  if (fields.length !== COLUMNS.length) return { ok: false, message: `Expected ${COLUMNS.length} columns but found ${fields.length}` }
  const value = (name: string) => fields[COLUMNS.indexOf(name)]!.trim()

  const accountNumber = value('Account number')
  if (!ACCOUNT_NUMBER.test(accountNumber)) return { ok: false, message: 'Invalid Account number' }

  // The Effective Date is the Transaction's date: it is the one the running balance is ordered by, which the Balance Check
  // depends on. Kiwibank also gives a Transaction Date; in every sample seen the two are the same.
  const date = parseDate(value('Effective Date'))
  if (!date) return { ok: false, message: 'Invalid Effective Date' }

  const amountCents = parseCents(value('Amount'))
  if (amountCents === null) return { ok: false, message: 'Invalid Amount' }

  const balanceCents = parseCents(value('Balance'))
  if (balanceCents === null) return { ok: false, message: 'Invalid Balance' }

  // `payee` is what the Transaction list shows, so the other party's name when the bank gives one and its own description when
  // it does not (a fee, interest, a card purchase). `bankMemo` keeps the description either way, so nothing is lost.
  const description = value('Description')
  const payee = value('Other Party Name') || description

  return {
    ok: true,
    accountNumber,
    balanceCents,
    date,
    row: {
      date,
      uniqueId: uniqueIdFor(date, amountCents, balanceCents),
      tranType: value('Transaction Code'),
      // The Worker writes this column to `bank_reference` (worker/imports.ts: INSERT_ROWS). ASB has only a cheque number to put
      // there; Kiwibank has the payment's own Reference, which is what that column is for.
      chequeNumber: value('Reference') || null,
      payee,
      bankMemo: description,
      amountCents,
    },
  }
}

function parse(text: string): BankCsvResult {
  const lines = splitLines(text)
  if (lines[0]?.trim() !== COLUMN_HEADER) throw new BankCsvError('Expected the Kiwibank column header', 1)

  const rows: BankCsvRow[] = []
  const errors: BankCsvRowError[] = []
  let accountNumber: string | null = null
  let last: { balanceCents: number; date: string } | null = null
  let from: string | null = null

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const fields = splitFields(line)
    const result: RowResult = fields ? parseRow(fields) : { ok: false, message: 'Unbalanced quotes' }
    if (!result.ok) {
      errors.push({ line: i + 1, message: result.message })
      continue
    }
    // One file is one Account. A file holding more than one would import another Account's Transactions into this one, so it is
    // refused outright rather than partly imported. The message names no account number: that is the Deployer's own data.
    if (accountNumber === null) accountNumber = result.accountNumber
    else if (result.accountNumber !== accountNumber) throw new BankCsvError('This file holds more than one account number', i + 1)
    rows.push(result.row)
    from ??= result.date
    last = { balanceCents: result.balanceCents, date: result.date }
  }

  if (accountNumber === null || last === null || from === null) throw new BankCsvError('No Transactions in this file')

  return {
    adapterId: 'kiwibank',
    // A suffix like 099 is the same Account as 99, as the Worker normalises it.
    accountNumber: accountNumber.replace(/-0(\d{2})$/, '-$1'),
    // Kiwibank states no balance of its own: the file's ledger balance is the balance after its newest Transaction, and the
    // export runs oldest first, so that is the last row's. A file whose rows are out of order would give the wrong one; the rows
    // are not re-sorted, because a file that is not in the bank's own order is not a file this adapter should trust.
    ledgerBalance: { cents: last.balanceCents, date: last.date },
    dateRange: { from, to: last.date },
    rows,
    errors,
  }
}

export const kiwibankAdapter: BankCsvAdapter = {
  id: 'kiwibank',
  name: 'Kiwibank',
  detect: (text) => splitLines(text)[0]?.trim() === COLUMN_HEADER,
  parse,
}
