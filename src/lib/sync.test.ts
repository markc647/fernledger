import { describe, expect, it } from 'vitest'
import { accountNote, runSummary, totalWritten, type AccountOutcome, type SyncRunOutcome } from './sync'

// What the Admin reads after "Run a Sync now". The two things worth pinning: nothing new is a success and never reads as a
// failure, and every failure names a cause and something to do (the Admin runs a Sync by hand precisely to find that out).
const done = (accountId: number, written: number): AccountOutcome => ({ accountId, written, complete: true })
const run = (accounts: AccountOutcome[], success = accounts.every((a) => a.complete)): SyncRunOutcome => ({ ran: true, success, accounts })

describe('runSummary', () => {
  it('calls a quiet day a success, without a count that reads as a failure', () => {
    expect(runSummary(run([done(1, 0), done(2, 0)]))).toEqual({ tone: 'success', text: 'Sync finished. There was nothing new to bring in.' })
  })

  it('counts what came in, and says "Transaction" for one', () => {
    expect(runSummary(run([done(1, 3), done(2, 1)])).text).toBe('Sync finished and brought in 4 Transactions.')
    expect(runSummary(run([done(1, 1)])).text).toBe('Sync finished and brought in 1 Transaction.')
  })

  it('is a warning when some Accounts finished and a danger when none did', () => {
    const partly = run([done(1, 2), { accountId: 2, written: 0, complete: false, failure: 'refused' }])
    expect(runSummary(partly)).toEqual({ tone: 'warning', text: 'Sync did not finish. It brought in 2 Transactions; each Account is below.' })
    const none = run([{ accountId: 1, written: 0, complete: false, failure: 'refused' }])
    expect(runSummary(none)).toEqual({ tone: 'danger', text: 'Sync did not finish, and nothing was brought in. Each Account is below.' })
  })

  it('says there was nothing to sync when no Account is linked', () => {
    expect(runSummary({ ran: false, success: false, accounts: [] })).toEqual({ tone: 'neutral', text: 'No Account is linked to Akahu, so there was nothing to sync.' })
  })
})

describe('accountNote', () => {
  it('names a cause and an action for every failure', () => {
    for (const failure of ['refused', 'unreachable', 'unreadable', 'no-window'] as const) {
      const { tone, text } = accountNote({ accountId: 1, written: 0, complete: false, failure })
      expect(tone, failure).not.toBe('success')
      expect(text, failure).toMatch(/Akahu|Cutover Date/)
      expect(text, failure).toMatch(/\.$/)
    }
  })

  it('does not offer another run as the fix for the page cap, which would ask the same window again', () => {
    const { tone, text } = accountNote({ accountId: 1, written: 500, complete: false })
    expect(tone).toBe('warning')
    expect(text).toContain('500 Transactions')
    expect(text).not.toContain('again')
  })

  it('reads an Account that finished as finished, with or without anything new', () => {
    expect(accountNote(done(1, 0))).toEqual({ tone: 'success', text: 'Finished. Nothing new to bring in.' })
    expect(accountNote(done(1, 12))).toEqual({ tone: 'success', text: 'Finished and brought in 12 Transactions.' })
  })
})

it('totalWritten adds up the Accounts', () => {
  expect(totalWritten(run([done(1, 2), done(2, 40), { accountId: 3, written: 0, complete: false, failure: 'unreachable' }]))).toBe(42)
})
