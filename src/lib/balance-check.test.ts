import { describe, expect, it } from 'vitest'
import { balanceDiffersMessage, describeBalanceCheck } from './balance-check'

describe('balanceDiffersMessage', () => {
  it('names the amount and the date the bank and the Transactions last agreed', () => {
    expect(balanceDiffersMessage(1234, '2026-10-08')).toBe('Balance differs from bank by $12.34 since Thu 8 Oct 2026')
  })

  it('writes the size of the difference, whichever way it goes, with no sign', () => {
    expect(balanceDiffersMessage(-123456, '2026-10-08')).toBe('Balance differs from bank by $1,234.56 since Thu 8 Oct 2026')
  })
})

describe('describeBalanceCheck', () => {
  it('warns of a difference, and says which way, in plain words', () => {
    const higher = describeBalanceCheck({ status: 'differs', asOfDate: '2026-10-15', since: '2026-10-08', differenceCents: 500 })
    expect(higher).toMatchObject({ tone: 'warning', headline: 'Balance differs from bank by $5.00 since Thu 8 Oct 2026' })
    expect(higher.detail).toBe("The bank's balance is higher than the Transactions add up to. Some money in may be missing, or some money out counted twice.")
    const lower = describeBalanceCheck({ status: 'differs', asOfDate: '2026-10-15', since: '2026-10-08', differenceCents: -500 })
    expect(lower.detail).toBe("The bank's balance is lower than the Transactions add up to. Some money out may be missing, or some money in counted twice.")
  })

  it('says the balance agrees, as of the date checked', () => {
    expect(describeBalanceCheck({ status: 'matched', asOfDate: '2026-10-15', since: '2026-10-08', differenceCents: 0 })).toMatchObject({
      tone: 'success',
      headline: 'Balance matches the bank as of Thu 15 Oct 2026',
    })
  })

  it('says why there was nothing to compare, without alarm', () => {
    expect(describeBalanceCheck({ status: 'alone', asOfDate: '2026-10-15', since: null, differenceCents: null })).toMatchObject({
      tone: 'neutral',
      headline: 'Balance not checked yet',
    })
    expect(describeBalanceCheck({ status: 'after-cutover', asOfDate: '2026-10-15', since: null, differenceCents: null }).detail).toContain('Cutover Date')
    expect(describeBalanceCheck({ status: 'file-ends-early', asOfDate: '2026-10-15', since: null, differenceCents: null }).detail).toContain('Thu 15 Oct 2026')
  })
})
