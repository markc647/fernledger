import { afterEach, describe, expect, it, vi } from 'vitest'
import { logEvent } from './log'

function capture() {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => void lines.push(args.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args.join(' ')))
  return lines
}
afterEach(() => vi.restoreAllMocks())

describe('logEvent', () => {
  it('logs the event with its ID and count', () => {
    const lines = capture()
    logEvent('import.finished', { id: 42, count: 500 })
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'import.finished', id: 42, count: 500 }])
  })

  it('logs an error as its class only, never its message or stack', () => {
    const lines = capture()
    logEvent('sync.failed', { error: new RangeError('bad row for mum@leak.test token=abc123') })
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'sync.failed', errorClass: 'RangeError' }])
    expect(lines.join()).not.toMatch(/leak|abc123/)
  })

  it('reports a thrown non-error as UnknownError', () => {
    const lines = capture()
    logEvent('sync.failed', { error: 'mum@leak.test' })
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'sync.failed', errorClass: 'UnknownError' }])
  })

  it('logs a code that is a fixed ERR_ constant, and drops anything else that could carry a value', () => {
    const lines = capture()
    logEvent('auth.refused.bad-token', { code: 'ERR_JWT_EXPIRED' })
    logEvent('auth.refused.bad-token', { code: 'token for mum@leak.test' })
    logEvent('auth.refused.bad-token', { code: 'err_jwt_expired' })
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'auth.refused.bad-token', code: 'ERR_JWT_EXPIRED' }, { event: 'auth.refused.bad-token' }, { event: 'auth.refused.bad-token' }])
    expect(lines.join()).not.toContain('leak')
  })

  it('drops an ID or count that is not a whole number', () => {
    const lines = capture()
    // The types stop this, but a runtime guard still stops a string (an email, a token) sneaking in.
    logEvent('x.y', { id: 'mum@leak.test' as never, count: 1.5 })
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'x.y' }])
  })

  it('replaces an event name that could carry data', () => {
    const lines = capture()
    logEvent('import failed for mum@leak.test')
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'invalid-event' }])
  })

  it('ignores extra fields passed past the types', () => {
    const lines = capture()
    logEvent('x.y', { id: 1, email: 'mum@leak.test' } as never)
    expect(lines.join()).not.toContain('leak')
  })
})
