import { describe, expect, it } from 'vitest'
import { badRowField, serialiseRows } from './import-rows'

const row = { date: '2026-10-01', uniqueId: 'ID1', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -100 }

/** What a bank may print beside a Transaction: the payment's details, and the card it was spent on. A row from a bank that prints none of them is serialised with all four null. */
const noDetails = { particulars: null, paymentCode: null, counterpartyAccount: null, cardSuffix: null }

describe('serialiseRows', () => {
  it('keeps only the known fields of each row, so an oversized extra field never reaches the database', () => {
    const json = serialiseRows([{ ...row, junk: 'x'.repeat(10_000) } as typeof row])

    expect(JSON.parse(json)).toEqual([{ ...row, ...noDetails }])
    expect(json.length).toBeLessThan(1000)
  })

  // The SQL reads the same field for every row, so a row that leaves them out must still serialise all four.
  it('writes the payment details as null when the adapter left them out', () => {
    expect(JSON.parse(serialiseRows([row]))).toEqual([{ ...row, ...noDetails }])
  })

  it('keeps the payment details an adapter did supply', () => {
    const detailed = { ...row, particulars: 'GROCERIES', paymentCode: 'WEEKLY', counterpartyAccount: '99-9999-9999999-01', cardSuffix: null }
    expect(JSON.parse(serialiseRows([detailed]))).toEqual([detailed])
  })

  // A credit card export prints the card and none of the payment details (docs/bank-formats/kiwibank.md).
  it('keeps the card a row was spent on', () => {
    expect(JSON.parse(serialiseRows([{ ...row, tranType: '', cardSuffix: '9999' }]))).toEqual([{ ...row, tranType: '', ...noDetails, cardSuffix: '9999' }])
  })
})

describe('badRowField', () => {
  it('accepts a good row', () => {
    expect(badRowField([row])).toBeNull()
  })
})
