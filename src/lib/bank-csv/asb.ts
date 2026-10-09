import { BankCsvError, type BankCsvAdapter, type BankCsvResult, type BankCsvRow, type BankCsvRowError } from './types'

const COLUMN_HEADER = 'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount'
const ACCOUNT_LINE = /^Bank (\d{2}); Branch (\d{4}); Account (\d{7})-(\d{2,3})(?:\s|$)/
const BALANCE_LINE = /^Ledger Balance : (-?\d+(?:\.\d{1,2})?) as of (\d{8})\s*$/
const AMOUNT = /^(-|\+)?(\d+)(?:\.(\d{1,2}))?$/

const splitLines = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\n|\r/)

/** Pure calendar check; returns ISO `YYYY-MM-DD` or null. */
function isoDate(y: string, m: string, d: string): string | null {
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return `${y}-${m}-${d}`
}

const compactDate = (s: string) => isoDate(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8))

function toCents(s: string): number | null {
  const m = AMOUNT.exec(s)
  if (!m) return null
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return m[1] === '-' ? -cents : cents
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

function parseRow(fields: string[]): BankCsvRow | string {
  if (fields.length !== 7) return `Expected 7 columns but found ${fields.length}`
  const [dateText, uniqueId, tranType, cheque, payee, memo, amountText] = fields.map((f) => f.trim()) as [
    string, string, string, string, string, string, string,
  ]
  const dm = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(dateText)
  const date = dm && isoDate(dm[1]!, dm[2]!, dm[3]!)
  if (!date) return `Invalid date "${dateText}"`
  if (!uniqueId) return 'Missing unique ID'
  const amountCents = toCents(amountText)
  if (amountCents === null) return `Invalid amount "${amountText}"`
  return { date, uniqueId, tranType, chequeNumber: cheque || null, payee, memo, amountCents }
}

function parse(text: string): BankCsvResult {
  const lines = splitLines(text)

  const account = ACCOUNT_LINE.exec(lines[1] ?? '')
  if (!account) throw new BankCsvError('Expected the ASB account line ("Bank NN; Branch NNNN; Account ...")', 2)

  const range = (index: number, label: string) => {
    const m = new RegExp(`^${label} (\\d{8})\\s*$`).exec(lines[index] ?? '')
    const date = m && compactDate(m[1]!)
    if (!date) throw new BankCsvError(`Expected "${label} YYYYMMDD"`, index + 1)
    return date
  }
  const from = range(2, 'From date')
  const to = range(3, 'To date')

  const balance = BALANCE_LINE.exec(lines[5] ?? '')
  const balanceDate = balance && compactDate(balance[2]!)
  if (!balance || !balanceDate) throw new BankCsvError('Expected "Ledger Balance : N.NN as of YYYYMMDD"', 6)

  if (lines[6]?.trim() !== COLUMN_HEADER) throw new BankCsvError(`Expected the column header "${COLUMN_HEADER}"`, 7)

  const rows: BankCsvRow[] = []
  const errors: BankCsvRowError[] = []
  for (let i = 7; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const fields = splitFields(line)
    const row = fields ? parseRow(fields) : 'Unbalanced quotes'
    if (typeof row === 'string') errors.push({ line: i + 1, message: row })
    else rows.push(row)
  }

  return {
    bank: 'asb',
    accountNumber: `${account[1]}-${account[2]}-${account[3]}-${account[4]}`,
    ledgerBalance: { cents: toCents(balance[1]!)!, date: balanceDate },
    dateRange: { from, to },
    rows,
    errors,
  }
}

export const asbAdapter: BankCsvAdapter = {
  id: 'asb',
  name: 'ASB',
  detect: (text) => {
    const head = splitLines(text).slice(0, 8)
    return ACCOUNT_LINE.test(head[1] ?? '') && head.some((l) => l.trim() === COLUMN_HEADER)
  },
  parse,
}
