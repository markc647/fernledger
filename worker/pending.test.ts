import { describe, expect, it } from 'vitest'
import { toPendingRows } from './pending'

// Reading Akahu's pending money into rows. What the Sync itself does with them — one call a run, replaced whole, never reaching
// the Transactions — is in worker/sync.test.ts, against the database.

const ids = new Map([
  ['acc_linked000000000000001', 7],
  ['acc_linked000000000000002', 9],
])

const pending = (over: Record<string, unknown> = {}) => ({
  _account: 'acc_linked000000000000001',
  date: '2026-10-20T11:00:00.000Z',
  description: 'PENDING CAFE',
  amount: -4.5,
  type: 'EFTPOS',
  updated_at: '2026-10-20T20:00:00.000Z',
  ...over,
})

describe('reading Akahu’s pending money', () => {
  it('keeps dollars as integer cents, on the NZ date, against the Account it belongs to', () => {
    expect(toPendingRows([pending()], ids)).toEqual([
      {
        accountId: 7,
        // 11:00 UTC is NZ midnight the next day in NZDT, as a settled Transaction's date is read.
        date: '2026-10-21',
        amountCents: -450,
        description: 'PENDING CAFE',
        bankType: 'EFTPOS',
        updatedAt: '2026-10-20T20:00:00.000Z',
      },
    ])
  })

  it('does not drift on a sum a binary float cannot hold exactly', () => {
    expect(toPendingRows([pending({ amount: -12.34 })], ids)[0]!.amountCents).toBe(-1234)
  })

  it('drops a row for an account nobody linked, as the Transactions do (spec 31)', () => {
    expect(toPendingRows([pending({ _account: 'acc_notlinked00000000001' }), pending()], ids)).toHaveLength(1)
  })

  it('keeps what Akahu did not say as nothing, rather than refusing the row', () => {
    const [row] = toPendingRows([{ _account: 'acc_linked000000000000002', date: '2026-10-20T11:00:00.000Z', description: 'PENDING', amount: 25 }], ids)
    expect(row).toEqual({ accountId: 9, date: '2026-10-21', amountCents: 2500, description: 'PENDING', bankType: null, updatedAt: null })
  })
})
