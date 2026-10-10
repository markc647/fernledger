import { describe, expect, it } from 'vitest'
import { accountLabel, describeRange, generatedLine, reportHeading } from './report-frame'

describe('describeRange', () => {
  it('writes both ends the way the rest of the app writes a date', () => {
    expect(describeRange('2026-10-01', '2026-10-31')).toBe('Thu 1 Oct 2026 to Sat 31 Oct 2026')
  })
  it('writes a single day once', () => {
    expect(describeRange('2026-10-08', '2026-10-08')).toBe('Thu 8 Oct 2026')
  })
})

describe('generatedLine', () => {
  it('says when and by whom, with the time in NZ whatever the device\'s zone', () => {
    expect(generatedLine(new Date('2026-10-08T02:42:00.000Z'), 'admin@example.com')).toBe('Generated Thu 8 Oct 2026 at 3:42 pm by admin@example.com')
  })
})

describe('accountLabel', () => {
  it('names the Account and gives its bank number', () => {
    expect(accountLabel({ name: 'Example savings', accountNumber: '99-9999-9999999-99' })).toBe('Example savings (99-9999-9999999-99)')
  })
})

describe('reportHeading', () => {
  it('carries the app title, the Report, the Account and the dates, in the order a file name wants them', () => {
    expect(reportHeading({ appTitle: "Mum's finances", name: 'Transaction listing', accounts: 'Example savings', range: 'Thu 1 Oct 2026 to Sat 31 Oct 2026' })).toBe(
      "Mum's finances – Transaction listing – Example savings – Thu 1 Oct 2026 to Sat 31 Oct 2026",
    )
  })
})
