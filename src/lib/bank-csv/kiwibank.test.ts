import { describe, expect, it } from 'vitest'
import everyday from '../../../test/fixtures/kiwibank/everyday.csv?raw'
import malformed from '../../../test/fixtures/kiwibank/malformed-rows.csv?raw'
import asbSavings from '../../../test/fixtures/asb/savings.csv?raw'
import { BankCsvError, parseBankCsv } from './index'
import { uniqueIdFor } from './kiwibank'

describe('parseBankCsv with a Kiwibank export', () => {
  it('is told apart from an ASB export by its column header', () => {
    expect(parseBankCsv(everyday).adapterId).toBe('kiwibank')
    expect(parseBankCsv(asbSavings).adapterId).toBe('asb')
  })

  it('takes the account number from the rows, there being no header block', () => {
    expect(parseBankCsv(everyday).accountNumber).toBe('99-9999-9999999-00')
  })

  // Kiwibank states no balance of its own: the newest row's running balance is the file's, and the export is oldest first.
  it('takes the ledger balance from the last row, and the range from the first and last', () => {
    const { ledgerBalance, dateRange } = parseBankCsv(everyday)
    expect(ledgerBalance).toEqual({ cents: 161402, date: '2026-09-30' })
    expect(dateRange).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('reads a row, using the other party as the payee and keeping the description', () => {
    const { rows, errors } = parseBankCsv(everyday)
    expect(errors).toEqual([])
    expect(rows[0]).toEqual({
      date: '2026-09-01',
      uniqueId: '2026-09-01:-25000:175000',
      tranType: 'TRANSFER',
      // The Worker writes this to bank_reference, which is what Kiwibank's Reference is.
      chequeNumber: 'SEP',
      payee: 'EXAMPLE SAVINGS',
      bankMemo: 'TRANSFER TO SAVINGS',
      amountCents: -25000,
      particulars: 'SAVING',
      paymentCode: 'MONTHLY',
      counterpartyAccount: '99-9999-9999999-01',
    })
  })

  it('leaves the payment details null when the bank printed none', () => {
    expect(parseBankCsv(everyday).rows[1]).toMatchObject({ particulars: null, paymentCode: null, counterpartyAccount: null })
  })

  it('falls back to the description as the payee when there is no other party', () => {
    const row = parseBankCsv(everyday).rows[4]!
    expect(row).toMatchObject({ payee: 'CREDIT INTEREST', bankMemo: 'CREDIT INTEREST', amountCents: 92, chequeNumber: null })
  })

  it('reads a quoted field holding a comma and a doubled quote', () => {
    const row = parseBankCsv(everyday).rows[3]!
    expect(row).toMatchObject({ bankMemo: 'EXAMPLE, SMITH & CO', chequeNumber: 'REF "A1"' })
  })

  // The case the unique ID exists for: the same amount twice on one day, which no other field tells apart.
  it('gives two identical same-day Transactions different IDs, because the balance differs', () => {
    const [, second, third] = parseBankCsv(everyday).rows
    expect(second!.amountCents).toBe(third!.amountCents)
    expect(second!.date).toBe(third!.date)
    expect(second!.uniqueId).not.toBe(third!.uniqueId)
    expect(second!.uniqueId).toBe('2026-09-02:-820:174180')
    expect(third!.uniqueId).toBe('2026-09-02:-820:173360')
  })

  // A re-import of an overlapping range must recognise the rows it already holds, which is what the ID is for (ADR 0003).
  it('gives the same row the same ID every time, so a re-import is not a duplicate', () => {
    expect(parseBankCsv(everyday).rows.map((r) => r.uniqueId)).toEqual(parseBankCsv(everyday).rows.map((r) => r.uniqueId))
  })

  it('builds the ID from the date, the amount in cents and the balance in cents', () => {
    expect(uniqueIdFor('2026-09-01', -25000, 175000)).toBe('2026-09-01:-25000:175000')
  })

  it('reports a bad row by line and keeps the good ones', () => {
    const { rows, errors } = parseBankCsv(malformed)
    expect(rows.map((r) => r.bankMemo)).toEqual(['GOOD ROW', 'LAST GOOD ROW'])
    expect(errors).toEqual([
      { line: 3, message: 'Invalid Effective Date' },
      { line: 4, message: 'Invalid Amount' },
      { line: 5, message: 'Expected 15 columns but found 6' },
      { line: 6, message: 'Unbalanced quotes' },
      { line: 7, message: 'Invalid Account number' },
    ])
  })

  it('names no value in an error, because a value is transaction data', () => {
    const text = parseBankCsv(malformed)
      .errors.map((e) => e.message)
      .join('\n')
    for (const value of ['twelve', 'BAD AMOUNT', 'not-an-account', '2026-02-30']) expect(text).not.toContain(value)
  })

  it('refuses a file holding more than one account, rather than importing it into one', () => {
    const mixed = everyday.replace('99-9999-9999999-00,2026-09-02', '99-9999-9999999-01,2026-09-02')
    expect(() => parseBankCsv(mixed)).toThrow(BankCsvError)
  })

  it('refuses a file with no usable column header', () => {
    expect(() => parseBankCsv(everyday.split('\n').slice(1).join('\n'))).toThrow(BankCsvError)
  })

  it('refuses a file with a header and no Transactions', () => {
    expect(() => parseBankCsv(`${everyday.split('\n')[0]!}\n`)).toThrow(BankCsvError)
  })
})
