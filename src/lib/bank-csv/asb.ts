// Layout reference: docs/bank-formats/asb.md
import { BankCsvError, type BankCsvAdapter, type BankCsvResult, type BankCsvRow, type BankCsvRowError } from './types'

const COLUMN_HEADER = 'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount'
/** The column header sits on this (1-based) line; both `detect` and `parse` rely on it. */
const COLUMN_HEADER_LINE = 7
const ACCOUNT_LINE_NUMBER = 2

const ACCOUNT_LINE = /^Bank (\d{2}); Branch (\d{4}); Account (\d{7})-(\d{2,3})(?:\s|$)/
const BALANCE_LINE = /^Ledger Balance : (-?\d+(?:\.\d{1,2})?) as of (\d{8})\s*$/
const AMOUNT = /^(-|\+)?(\d+)(?:\.(\d{1,2}))?$/

const splitLines = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\n|\r/)

/** The only date parser: `YYYYMMDD` (header) or `YYYY/MM/DD` (rows) to ISO `YYYY-MM-DD`, or null if not a real date. */
function parseDate(text: string): string | null {
  const parts = /^(\d{4})(\/?)(\d{2})\2(\d{2})$/.exec(text)
  if (!parts) return null
  const [, year, , month, day] = parts as unknown as [string, string, string, string, string]
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  const isRealDate =
    utc.getUTCFullYear() === Number(year) && utc.getUTCMonth() === Number(month) - 1 && utc.getUTCDate() === Number(day)
  return isRealDate ? `${year}-${month}-${day}` : null
}

function parseCents(text: string): number | null {
  const parts = AMOUNT.exec(text)
  if (!parts) return null
  const magnitude = Number(parts[2]) * 100 + Number((parts[3] ?? '').padEnd(2, '0'))
  return parts[1] === '-' && magnitude !== 0 ? -magnitude : magnitude
}

/** Splits one CSV line. Returns null if a quote is left open or text follows a closing quote. */
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

type RowResult = { ok: true; row: BankCsvRow } | { ok: false; message: string }

/** Error messages name the field only: values are transaction data and must not reach logs. */
function parseRow(fields: string[]): RowResult {
  if (fields.length !== 7) return { ok: false, message: `Expected 7 columns but found ${fields.length}` }
  const [dateText, uniqueId, tranType, chequeNumber, payee, bankMemo, amountText] = fields.map((f) => f.trim()) as [
    string, string, string, string, string, string, string,
  ]
  const date = parseDate(dateText)
  if (!date || dateText.length !== 10) return { ok: false, message: 'Invalid Date' }
  if (!uniqueId) return { ok: false, message: 'Missing Unique Id' }
  const amountCents = parseCents(amountText)
  if (amountCents === null) return { ok: false, message: 'Invalid Amount' }
  return { ok: true, row: { date, uniqueId, tranType, chequeNumber: chequeNumber || null, payee, bankMemo, amountCents } }
}

function parse(text: string): BankCsvResult {
  const lines = splitLines(text)

  const account = ACCOUNT_LINE.exec(lines[ACCOUNT_LINE_NUMBER - 1] ?? '')
  if (!account) {
    throw new BankCsvError('Expected the ASB account line ("Bank NN; Branch NNNN; Account ...")', ACCOUNT_LINE_NUMBER)
  }

  const headerDate = (index: number, label: string) => {
    const match = new RegExp(`^${label} (\\d{8})\\s*$`).exec(lines[index] ?? '')
    const date = match && parseDate(match[1]!)
    if (!date) throw new BankCsvError(`Expected "${label} YYYYMMDD"`, index + 1)
    return date
  }
  const from = headerDate(2, 'From date')
  const to = headerDate(3, 'To date')

  const balance = BALANCE_LINE.exec(lines[5] ?? '')
  const balanceDate = balance && parseDate(balance[2]!)
  if (!balance || !balanceDate) throw new BankCsvError('Expected "Ledger Balance : N.NN as of YYYYMMDD"', 6)

  if (lines[COLUMN_HEADER_LINE - 1]?.trim() !== COLUMN_HEADER) {
    throw new BankCsvError(`Expected the column header "${COLUMN_HEADER}"`, COLUMN_HEADER_LINE)
  }

  const rows: BankCsvRow[] = []
  const errors: BankCsvRowError[] = []
  for (let i = COLUMN_HEADER_LINE; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const fields = splitFields(line)
    const result: RowResult = fields ? parseRow(fields) : { ok: false, message: 'Unbalanced quotes' }
    if (result.ok) rows.push(result.row)
    else errors.push({ line: i + 1, message: result.message })
  }

  return {
    adapterId: 'asb',
    // A suffix like 099 is the same account as 99; the Worker normalises the same way, so the preview matches Accounts.
    accountNumber: `${account[1]}-${account[2]}-${account[3]}-${account[4]!.replace(/^0(\d{2})$/, '$1')}`,
    ledgerBalance: { cents: parseCents(balance[1]!)!, date: balanceDate },
    dateRange: { from, to },
    rows,
    errors,
  }
}

export const asbAdapter: BankCsvAdapter = {
  id: 'asb',
  name: 'ASB',
  detect: (text) => {
    const lines = splitLines(text)
    return (
      ACCOUNT_LINE.test(lines[ACCOUNT_LINE_NUMBER - 1] ?? '') && lines[COLUMN_HEADER_LINE - 1]?.trim() === COLUMN_HEADER
    )
  },
  parse,
}
