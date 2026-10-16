import { describe, expect, it } from 'vitest'
import { balanceDiffersMessage, checkedAmount, checkedBy, describeBalanceCheck, noBalanceHint, noBalanceReason } from './balance-check'

describe('noBalanceHint', () => {
  it('says what the Admin can do, for each reason an Account can have no balance', () => {
    expect(noBalanceHint('after-cutover')).toBe('The Admin can import a file with a bank balance dated before the Cutover Date, or change the Cutover Date in Settings.')
    expect(noBalanceHint('file-ends-early')).toBe('The Admin can import a file that runs to its balance date.')
    expect(noBalanceHint('alone')).toBe('The Admin can import a bank file to give it one.')
    expect(noBalanceHint(null)).toBe('The Admin can import a bank file to give it one.')
  })
})

describe('noBalanceReason', () => {
  it('says why an Account has no balance, in the words the Summary and the balances Report share', () => {
    expect(noBalanceReason('after-cutover')).toBe('The bank balance we have is after the Cutover Date')
    expect(noBalanceReason('file-ends-early')).toBe('The file ended before its bank balance date')
    expect(noBalanceReason('alone')).toBe('No bank balance yet')
    expect(noBalanceReason(null)).toBe('No bank balance yet')
  })
})

describe('balanceDiffersMessage', () => {
  it('names the amount and the date of the previous bank balance', () => {
    expect(balanceDiffersMessage(1234, '2026-10-08')).toBe('Balance differs from bank by $12.34 since Thu 8 Oct 2026')
  })

  it('writes the size of the difference, whichever way it goes, with no sign', () => {
    expect(balanceDiffersMessage(-123456, '2026-10-08')).toBe('Balance differs from bank by $1,234.56 since Thu 8 Oct 2026')
  })
})

describe('checkedBy', () => {
  const difference = (accountId: number, differenceCents: number, asOfDate: string) => ({ accountId, accountName: `Account ${accountId}`, asOfDate, since: '2026-09-30', differenceCents })
  const latest = (accountId: number, status: string | null) => ({ accountId, accountName: `Account ${accountId}`, asOfDate: status === null ? null : '2026-10-15', status })

  it('is OK for an Account whose latest Balance Check agrees with the bank', () => {
    expect(checkedBy({ differences: [], accounts: [latest(1, 'matched')] })(1)).toEqual({ kind: 'ok' })
  })

  it('is Check, with the differences newest first, for an Account where one disagrees, whatever its latest check says', () => {
    const newest = difference(2, 500, '2026-10-15')
    const older = difference(2, -250, '2026-10-08')
    expect(checkedBy({ differences: [newest, older], accounts: [latest(2, 'differs')] })(2)).toEqual({ kind: 'check', differences: [newest, older] })
    // An older span that still disagrees is a Check although the latest balance matched the one before it.
    expect(checkedBy({ differences: [older], accounts: [latest(2, 'matched')] })(2)).toEqual({ kind: 'check', differences: [older] })
  })

  it('is none for an Account that has not been checked: no balance, one balance on its own, or one the check could not use', () => {
    const none = { kind: 'none' }
    const checks = { differences: [], accounts: [latest(3, null), latest(4, 'alone'), latest(5, 'after-cutover'), latest(6, 'file-ends-early')] }
    for (const id of [3, 4, 5, 6, 99]) expect(checkedBy(checks)(id), String(id)).toEqual(none) // 99 is an Account the answer does not list at all
  })

  it('keeps each Account to its own differences', () => {
    const one = difference(1, 100, '2026-10-15')
    const two = difference(2, 200, '2026-10-15')
    const checked = checkedBy({ differences: [one, two], accounts: [latest(1, 'differs'), latest(2, 'differs'), latest(3, 'matched')] })
    expect(checked(1)).toEqual({ kind: 'check', differences: [one] })
    expect(checked(2)).toEqual({ kind: 'check', differences: [two] })
    expect(checked(3)).toEqual({ kind: 'ok' })
  })
})

describe('checkedAmount', () => {
  const d = (differenceCents: number) => ({ differenceCents })

  it('says how far the newest difference is, whichever way it goes, with no sign', () => {
    expect(checkedAmount([d(500)])).toBe('by $5.00')
    expect(checkedAmount([d(-123456)])).toBe('by $1,234.56')
  })

  it('says how many earlier ones there are', () => {
    expect(checkedAmount([d(500), d(-250)])).toBe('by $5.00 (and 1 earlier)')
    expect(checkedAmount([d(500), d(-250), d(10)])).toBe('by $5.00 (and 2 earlier)')
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
