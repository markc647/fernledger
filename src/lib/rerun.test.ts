import { describe, expect, it } from 'vitest'
import { announcement, percentDone, progressSentence, restartNote, updatedSentence, type RerunJob } from './rerun'

const job = (over: Partial<RerunJob> = {}): RerunJob => ({
  id: 1,
  status: 'running',
  startedAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:30.000Z',
  finishedAt: null,
  totalRows: 20_000,
  doneRows: 4_000,
  changedRows: 1_234,
  restarts: 0,
  ...over,
})

describe('how far a re-run has got', () => {
  it.each([
    [0, 20_000, 'running', 0],
    [4_000, 20_000, 'running', 20],
    [19_999, 20_000, 'running', 99], // never reads 100% until it is done
    [20_000, 20_000, 'running', 99], // the last step has not been recorded yet
    [20_000, 20_000, 'done', 100],
    [19_500, 20_000, 'done', 100], // some were removed while it ran: done is done
    [0, 0, 'running', 0],
    [0, 0, 'done', 100],
  ] as const)('%i of %i, %s, is %i%%', (doneRows, totalRows, status, percent) => {
    expect(percentDone(job({ doneRows, totalRows, status }))).toBe(percent)
  })
})

describe('what the Admin reads', () => {
  it('says how many have been looked at, in plain words with the thousands marked', () => {
    expect(progressSentence(job())).toBe('Looked at 4,000 of 20,000 Transactions (20%).')
    expect(progressSentence(job({ doneRows: 0, totalRows: 1 }))).toBe('Looked at 0 of 1 Transaction (0%).')
  })

  it('says, when it is done, how many it looked at and how many it updated', () => {
    expect(progressSentence(job({ status: 'done', doneRows: 20_000, changedRows: 1_234 }))).toBe('Finished. Looked at all 20,000 Transactions and updated 1,234 of them.')
    expect(progressSentence(job({ status: 'done', doneRows: 1, totalRows: 1, changedRows: 1 }))).toBe('Finished. Looked at the 1 Transaction and updated it.')
    expect(progressSentence(job({ status: 'done', doneRows: 2, totalRows: 2, changedRows: 0 }))).toBe('Finished. Looked at all 2 Transactions and updated none of them.')
    expect(progressSentence(job({ status: 'done', doneRows: 0, totalRows: 0, changedRows: 0 }))).toBe('Finished. There were no Transactions to look at.')
    // Some were removed while it ran: it says what it did, not what it planned.
    expect(progressSentence(job({ status: 'done', doneRows: 19_500, totalRows: 20_000, changedRows: 5 }))).toBe('Finished. Looked at 19,500 Transactions and updated 5 of them.')
  })

  it('says when it last did something, in New Zealand time', () => {
    expect(updatedSentence(job())).toBe('Last updated Sun 11 Oct 2026, 3:00 pm.') // 02:00:30 UTC is 15:00 in NZDT
    expect(updatedSentence(job({ status: 'done', finishedAt: '2026-10-11T02:05:00.000Z', updatedAt: '2026-10-11T02:05:00.000Z' }))).toBe('Finished Sun 11 Oct 2026, 3:05 pm.')
  })

  it('says when the Rules changed under it, and only then', () => {
    expect(restartNote(job())).toBeNull()
    expect(restartNote(job({ restarts: 1 }))).toBe('The Rules changed while this was running, so it started again from the first Transaction.')
    expect(restartNote(job({ restarts: 3 }))).toBe('The Rules changed 3 times while this was running, so it started again from the first Transaction each time.')
  })
})

describe('what a screen reader is told', () => {
  // The words change only at a few points, so a screen reader announces a few times and not at every step.
  it('says nothing new while the percentage moves within a quarter', () => {
    const said = new Set([0, 4_000, 4_999].map((doneRows) => announcement(job({ doneRows, totalRows: 20_000 }))))
    expect(said.size).toBe(1)
    expect([...said][0]).toBe('Started. Going through 20,000 Transactions.')
  })

  it.each([
    [5_000, '25% done.'],
    [10_000, '50% done.'],
    [15_000, '75% done.'],
  ])('says %i is "%s"', (doneRows, words) => {
    expect(announcement(job({ doneRows }))).toBe(words)
  })

  it('says it started again when the Rules changed, until the next quarter', () => {
    expect(announcement(job({ doneRows: 0, restarts: 1 }))).toBe('The Rules changed, so it started again. Going through 20,000 Transactions.')
    expect(announcement(job({ doneRows: 5_000, restarts: 1 }))).toBe('25% done.')
  })

  it('says it is finished, with the counts', () => {
    expect(announcement(job({ status: 'done', doneRows: 20_000, changedRows: 1_234 }))).toBe('Finished. Looked at all 20,000 Transactions and updated 1,234 of them.')
  })
})
