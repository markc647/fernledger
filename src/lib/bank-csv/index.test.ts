import { describe, expect, it } from 'vitest'
import savings from '../../../test/fixtures/asb/savings.csv?raw'
import malformed from '../../../test/fixtures/asb/malformed-rows.csv?raw'
import negative from '../../../test/fixtures/asb/negative-balance.csv?raw'
import { BankCsvError, parseBankCsv, type BankCsvAdapter } from './index'

describe('parseBankCsv with an ASB export', () => {
  it('reads the account, ledger balance and date range from the header', () => {
    const result = parseBankCsv(savings)
    expect(result.bank).toBe('asb')
    expect(result.accountNumber).toBe('99-9999-9999999-99')
    expect(result.ledgerBalance).toEqual({ cents: 559397, date: '2026-10-02' })
    expect(result.dateRange).toEqual({ from: '2019-10-02', to: '2026-10-02' })
  })

  it('turns data rows into trimmed rows with amounts in cents', () => {
    const { rows, errors } = parseBankCsv(savings)
    expect(errors).toEqual([])
    expect(rows[0]).toEqual({
      date: '2019-10-31',
      uniqueId: '2019103101',
      tranType: 'INT',
      chequeNumber: null,
      payee: 'ASB BANK - INTEREST',
      memo: 'CR.INT TO 31/10/2019',
      amountCents: 120,
    })
    expect(rows[1]).toMatchObject({ date: '2019-10-04', payee: 'EXAMPLE CAFE TOWN', amountCents: -820 })
    expect(rows).toHaveLength(6)
  })

  it('handles commas and doubled quotes inside quoted fields', () => {
    const row = parseBankCsv(savings).rows[2]
    expect(row).toMatchObject({ payee: 'EXAMPLE, SMITH & CO', memo: 'ref "A1"', amountCents: -123450 })
  })

  it('keeps cheque numbers and reads whole-dollar and one-decimal amounts exactly', () => {
    const { rows } = parseBankCsv(savings)
    expect(rows[3]).toMatchObject({ chequeNumber: '000123', payee: 'J BLOGGS', amountCents: -5000 })
    expect(rows[4]?.amountCents).toBe(-5)
    expect(rows[5]?.amountCents).toBe(250050)
  })

  it('reads a negative ledger balance and a three-digit account suffix', () => {
    const result = parseBankCsv(negative)
    expect(result.accountNumber).toBe('99-9999-9999999-100')
    expect(result.ledgerBalance).toEqual({ cents: -125075, date: '2026-10-02' })
  })

  it('gives the same result for Windows line endings and a byte order mark', () => {
    const crlf = '﻿' + savings.replace(/\n/g, '\r\n')
    expect(parseBankCsv(crlf)).toEqual(parseBankCsv(savings))
  })

  it('reports malformed rows with their line numbers and keeps the good rows', () => {
    const { rows, errors } = parseBankCsv(malformed)
    expect(rows.map((r) => r.uniqueId)).toEqual(['2019100401', '2019100501'])
    expect(errors).toEqual([
      { line: 10, message: 'Invalid date "2019/13/45"' },
      { line: 11, message: 'Expected 7 columns but found 6' },
      { line: 12, message: 'Invalid amount "abc"' },
      { line: 13, message: 'Unbalanced quotes' },
    ])
  })
})

describe('parseBankCsv with files it cannot use', () => {
  it('rejects an unknown format with a clear error', () => {
    expect(() => parseBankCsv('Date,Description,Amount\n2026-01-01,Coffee,-4.50\n')).toThrow(
      /Unrecognised bank file format.*ASB/,
    )
    expect(() => parseBankCsv('')).toThrow(BankCsvError)
  })

  it('rejects an ASB file whose header is damaged, naming the line', () => {
    const noBalance = savings.replace('Ledger Balance : 5593.97 as of 20261002', 'Ledger Balance : n/a')
    expect(() => parseBankCsv(noBalance)).toThrow('Line 6: Expected "Ledger Balance')
    const badDate = savings.replace('To date 20261002', 'To date 20261302')
    expect(() => parseBankCsv(badDate)).toThrow('Line 4: Expected "To date YYYYMMDD"')
  })

  it('uses the first adapter in the registry whose detect matches', () => {
    const fake: BankCsvAdapter = {
      id: 'fake',
      name: 'Fake',
      detect: (t) => t.startsWith('FAKE'),
      parse: () => ({ ...parseBankCsv(savings), bank: 'fake' }),
    }
    expect(parseBankCsv('FAKE file', [fake]).bank).toBe('fake')
    expect(() => parseBankCsv(savings, [fake])).toThrow(/Supported formats: Fake/)
  })
})
