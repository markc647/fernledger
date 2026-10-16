import { describe, expect, it } from 'vitest'
import { askToPrint, PRINT_REQUEST_LASTS_MS, takePrintRequest } from './print-request'

const READS = ['account', 'from', 'to'] as const
const open = (search: string, pathname = '/reports/spending') => ({ pathname, search })
const HREF = '/reports/spending?account=2&from=2026-10-01&to=2026-10-31'

describe('a request to print a Report when it is shown', () => {
  it('is answered yes once, for the Report asked for', () => {
    askToPrint(HREF, 1000)
    expect(takePrintRequest(open('?account=2&from=2026-10-01&to=2026-10-31'), READS, 1500)).toBe(true)
    expect(takePrintRequest(open('?account=2&from=2026-10-01&to=2026-10-31'), READS, 1500)).toBe(false) // used up
  })

  it('is the same Report whatever order its choices are written in, or if the address carries what the Report does not read', () => {
    askToPrint(HREF, 1000)
    expect(takePrintRequest(open('?to=2026-10-31&from=2026-10-01&account=2&print=x'), READS, 1100)).toBe(true)
  })

  it('is answered no for another Report, or the same Report with other choices, and is then gone, so a Report shown later does not print', () => {
    askToPrint(HREF, 1000)
    expect(takePrintRequest(open('?account=2&from=2026-10-01&to=2026-10-31', '/reports/loans'), READS, 1100)).toBe(false)
    expect(takePrintRequest(open('?account=2&from=2026-10-01&to=2026-10-31'), READS, 1100)).toBe(false)

    askToPrint(HREF, 1000)
    expect(takePrintRequest(open('?account=3&from=2026-10-01&to=2026-10-31'), READS, 1100)).toBe(false)
  })

  it('lapses: a Report that arrives long after it was asked for is not printed', () => {
    askToPrint(HREF, 1000)
    expect(takePrintRequest(open('?account=2&from=2026-10-01&to=2026-10-31'), READS, 1000 + PRINT_REQUEST_LASTS_MS + 1)).toBe(false)
    askToPrint(HREF, 1000)
    expect(takePrintRequest(open('?account=2&from=2026-10-01&to=2026-10-31'), READS, 1000 + PRINT_REQUEST_LASTS_MS)).toBe(true)
  })

  it('is no when nothing was asked for', () => {
    expect(takePrintRequest(open('?from=2026-10-01&to=2026-10-31'), READS, 1000)).toBe(false)
  })

  it('is for the last Report asked for', () => {
    askToPrint('/reports/spending?from=2026-09-01&to=2026-09-30', 1000)
    askToPrint('/reports/spending?from=2026-10-01&to=2026-10-31', 1010)
    expect(takePrintRequest(open('?from=2026-09-01&to=2026-09-30'), READS, 1100)).toBe(false)
  })
})
