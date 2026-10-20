import { describe, expect, it } from 'vitest'
import { badRowField, serialiseRows } from './import-rows'

const row = { date: '2026-10-01', uniqueId: 'ID1', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -100 }

/** The payment details a bank may print beside a Transaction. A row from a bank that prints none of them is serialised with all three null. */
const noDetails = { particulars: null, paymentCode: null, counterpartyAccount: null }

describe('serialiseRows', () => {
  it('keeps only the known fields of each row, so an oversized extra field never reaches the database', () => {
    const json = serialiseRows([{ ...row, junk: 'x'.repeat(10_000) } as typeof row])

    expect(JSON.parse(json)).toEqual([{ ...row, ...noDetails }])
    expect(json.length).toBeLessThan(1000)
  })

  // The SQL reads the same field for every row, so a row that leaves them out must still serialise all three.
  it('writes the payment details as null when the adapter left them out', () => {
    expect(JSON.parse(serialiseRows([row]))).toEqual([{ ...row, ...noDetails }])
  })

  it('keeps the payment details an adapter did supply', () => {
    const detailed = { ...row, particulars: 'GROCERIES', paymentCode: 'WEEKLY', counterpartyAccount: '99-9999-9999999-01' }
    expect(JSON.parse(serialiseRows([detailed]))).toEqual([detailed])
  })
})

describe('badRowField', () => {
  it('accepts a good row', () => {
    expect(badRowField([row])).toBeNull()
  })
})
