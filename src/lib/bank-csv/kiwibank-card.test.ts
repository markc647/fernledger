import { describe, expect, it } from 'vitest'
import card from '../../../test/fixtures/kiwibank/card.csv?raw'
import { parseBankCsv } from './index'
import { kiwibankCardAdapter, uniqueIdFor } from './kiwibank-card'
import { BankCsvError } from './types'

// Seam 2: the bank CSV adapters. The fixture is made up (docs/bank-formats/kiwibank.md).
const parse = (text: string) => kiwibankCardAdapter.parse(text)

describe('the Kiwibank credit card adapter', () => {
  it('is chosen for the card export by its column header, and not for the bank-account one', () => {
    expect(parseBankCsv(card).adapterId).toBe('kiwibank-card')
    expect(kiwibankCardAdapter.detect('Account number,Effective Date,Transaction Date,Description,Transaction Code,Particulars,Code,Reference,Other Party Name,Other Party Account Number,Other Party Particulars,Other Party Code,Other Party Reference,Amount,Balance')).toBe(false)
  })

  it('says the file names no Account and states no balance, because a card export has neither', () => {
    const result = parse(card)
    expect(result.accountNumber).toBeNull()
    expect(result.ledgerBalance).toBeNull()
  })

  it('covers the dates its rows run over', () => {
    expect(parse(card).dateRange).toEqual({ from: '2026-09-02', to: '2026-09-20' })
  })

  it('turns a row into the card it was spent on, with the amount in cents and no transaction type', () => {
    const { rows, errors } = parse(card)
    expect(errors).toEqual([])
    expect(rows[2]).toEqual({
      date: '2026-09-03',
      uniqueId: '2026-09-03:-12995:9999:1',
      tranType: '',
      chequeNumber: null,
      payee: 'EXAMPLE HARDWARE',
      bankMemo: 'EXAMPLE HARDWARE',
      amountCents: -12995,
      cardSuffix: '9999',
    })
    expect(rows[3]).toMatchObject({ payee: 'PAYMENT RECEIVED THANK YOU', amountCents: 25000 })
    expect(rows[4]).toMatchObject({ payee: 'EXAMPLE SHOP, TOWN', cardSuffix: '9998' }) // a quoted description keeps its comma
    expect(rows).toHaveLength(5)
  })

  // The point of counting occurrences: a card really does have two identical purchases in a day, and both must survive.
  it('keeps a day’s two identical purchases apart, so neither is taken for a duplicate of the other', () => {
    const { rows } = parse(card)
    expect([rows[0]!.uniqueId, rows[1]!.uniqueId]).toEqual(['2026-09-02:-450:9999:1', '2026-09-02:-450:9999:2'])
  })

  // What makes a re-import of an overlapping range add nothing twice (ADR 0003): the same file gives the same IDs.
  it('gives the same row the same ID every time, so a re-import recognises it', () => {
    expect(parse(card).rows.map((row) => row.uniqueId)).toEqual(parse(card).rows.map((row) => row.uniqueId))
  })

  it('names the fields in the ID and nothing else', () => {
    expect(uniqueIdFor('2026-09-02', -450, '9999', 2)).toBe('2026-09-02:-450:9999:2')
  })

  it('refuses a file whose header is not this layout', () => {
    expect(() => parse('Date,Description,Amount\n2026-09-02,EXAMPLE CAFE TOWN,-4.50')).toThrow(BankCsvError)
    expect(() => parse('')).toThrow(/column header/)
  })

  // A file with no row the adapter can read has no dates either, so there is no range to show and nothing to import; the
  // bank-account adapter refuses such a file for the same reason.
  it('refuses a file with no rows it could read, rather than importing nothing', () => {
    expect(() => parse('Date,Description,Card,Amount\n')).toThrow(/No Transactions/)
    expect(() => parse('Date,Description,Card,Amount\n2026-02-30,EXAMPLE SHOP,9999,-1.00')).toThrow(/No Transactions/)
  })

  it('skips a row it cannot read, names the field and the line, and keeps the rest', () => {
    const { rows, errors } = parse(
      ['Date,Description,Card,Amount', '2026-09-02,EXAMPLE CAFE TOWN,9999,-4.50', '2026-02-30,EXAMPLE SHOP,9999,-1.00', '2026-09-04,EXAMPLE SHOP,99,-1.00', '2026-09-05,EXAMPLE SHOP,9999,one dollar', '2026-09-06,EXAMPLE SHOP,9999'].join('\n'),
    )
    expect(rows).toHaveLength(1)
    expect(errors).toEqual([
      { line: 3, message: 'Invalid Date' },
      { line: 4, message: 'Invalid Card' },
      { line: 5, message: 'Invalid Amount' },
      { line: 6, message: 'Expected 4 columns but found 3' },
    ])
  })

  it('names no value from the file in an error, because those are transaction data', () => {
    const { errors } = parse(['Date,Description,Card,Amount', '2026-09-02,EXAMPLE CAFE TOWN,9999,-4.50', '2026-09-05,SECRET PAYEE,9999,one dollar'].join('\n'))
    expect(errors[0]!.message).not.toContain('SECRET PAYEE')
    expect(errors[0]!.message).not.toContain('one dollar')
  })
})
