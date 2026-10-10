import { describe, expect, it } from 'vitest'
import { announcement, estimateSentence, nextAllowanceReset, pausedSentence, progressSentence, restartNote, updatedSentence, type RerunJob } from './rerun'

const job = (over: Partial<RerunJob> = {}): RerunJob => ({
  id: 1,
  status: 'running',
  startedAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:30.000Z',
  finishedAt: null,
  totalRows: 20_000,
  doneRows: 4_000,
  changedRows: 1_234,
  percent: 20,
  restarts: 0,
  stepRows: 1_000,
  cronRowsPerDay: 6_000,
  paused: false,
  ...over,
})

describe('what the Admin reads', () => {
  it('says how many have been looked at, of the most there can be, with the thousands marked', () => {
    expect(progressSentence(job())).toBe('Looked at 4,000 of up to 20,000 Transactions (20%).')
    expect(progressSentence(job({ doneRows: 0, totalRows: 1, percent: 0 }))).toBe('Looked at 0 of up to 1 Transaction (0%).')
  })

  it('says, when it is done, how many it looked at and how many it updated', () => {
    expect(progressSentence(job({ status: 'done', doneRows: 20_000, changedRows: 1_234, percent: 100 }))).toBe('Finished. Looked at all 20,000 Transactions and updated 1,234 of them.')
    expect(progressSentence(job({ status: 'done', doneRows: 1, totalRows: 1, changedRows: 1, percent: 100 }))).toBe('Finished. Looked at the 1 Transaction and updated it.')
    expect(progressSentence(job({ status: 'done', doneRows: 2, totalRows: 2, changedRows: 0, percent: 100 }))).toBe('Finished. Looked at all 2 Transactions and updated none of them.')
    expect(progressSentence(job({ status: 'done', doneRows: 0, totalRows: 0, changedRows: 0, percent: 100 }))).toBe('Finished. There were no Transactions to look at.')
    // Transaction IDs have gaps, so it can look at fewer than the most there could be: it says what it did.
    expect(progressSentence(job({ status: 'done', doneRows: 12_500, totalRows: 20_000, changedRows: 5, percent: 100 }))).toBe('Finished. Looked at 12,500 Transactions and updated 5 of them.')
  })

  it('says, when it was stopped, what it did and that the rest are as they were', () => {
    expect(progressSentence(job({ status: 'stopped', doneRows: 7_000, changedRows: 300 }))).toBe(
      'Stopped. Looked at 7,000 Transactions and updated 300 of them. Those keep the result they were given and the rest are as they were.',
    )
    expect(progressSentence(job({ status: 'stopped', doneRows: 0, changedRows: 0 }))).toBe('Stopped before it looked at any Transaction. Nothing was changed.')
  })

  it('says when it last did something, or ended, in New Zealand time', () => {
    expect(updatedSentence(job())).toBe('Last updated Sun 11 Oct 2026, 3:00 pm.') // 02:00:30 UTC is 15:00 in NZDT
    expect(updatedSentence(job({ status: 'done', finishedAt: '2026-10-11T02:05:00.000Z', updatedAt: '2026-10-11T02:05:00.000Z' }))).toBe('Finished Sun 11 Oct 2026, 3:05 pm.')
    expect(updatedSentence(job({ status: 'stopped', finishedAt: '2026-10-11T02:07:00.000Z' }))).toBe('Stopped Sun 11 Oct 2026, 3:07 pm.')
  })

  it('says when the Rules changed under it, and only then', () => {
    expect(restartNote(job())).toBeNull()
    expect(restartNote(job({ restarts: 1 }))).toBe('The Rules changed while this was running, so it started again from the first Transaction.')
    expect(restartNote(job({ restarts: 3 }))).toBe('The Rules changed 3 times while this was running, so it started again from the first Transaction each time.')
  })

  it('says, when it is waiting for the day to change, that it carries on by itself and that opening the page then is quicker', () => {
    expect(pausedSentence()).toBe(
      'It carries on by itself after the daily allowance resets, around midday NZ time. Open this page then to finish sooner.',
    )
  })
})

describe('how long it has to go', () => {
  it('estimates steps if the page stays open and days if it is closed, from what is left', () => {
    // 16,000 left: 16 steps of 1,000; the crons do 6,000 a day, so 3 days.
    expect(estimateSentence(job())).toBe('About 16 more steps if you keep this page open, or about 3 days if you close it. Keep this page open to finish sooner.')
  })

  it('says a step in the singular, and "less than a day" when the crons would do what is left in one', () => {
    expect(estimateSentence(job({ doneRows: 19_500, totalRows: 20_000 }))).toBe('About 1 more step if you keep this page open, or less than a day if you close it. Keep this page open to finish sooner.')
    expect(estimateSentence(job({ doneRows: 14_000, totalRows: 20_000 }))).toBe('About 6 more steps if you keep this page open, or less than a day if you close it. Keep this page open to finish sooner.')
    expect(estimateSentence(job({ doneRows: 13_999, totalRows: 20_000 }))).toBe('About 7 more steps if you keep this page open, or about 2 days if you close it. Keep this page open to finish sooner.')
  })

  it('bases it on the steps the Rules allow, which are smaller when there are many', () => {
    expect(estimateSentence(job({ doneRows: 0, totalRows: 4_540, stepRows: 227, cronRowsPerDay: 1_362 }))).toBe(
      'About 20 more steps if you keep this page open, or about 4 days if you close it. Keep this page open to finish sooner.',
    )
  })

  it('has nothing to say when there is nothing left, when it has ended, or when it is waiting for the day to change', () => {
    expect(estimateSentence(job({ doneRows: 20_000 }))).toBeNull()
    expect(estimateSentence(job({ status: 'done' }))).toBeNull()
    expect(estimateSentence(job({ status: 'stopped' }))).toBeNull()
    expect(estimateSentence(job({ paused: true }))).toBeNull()
  })
})

describe('when the free plan\'s day changes', () => {
  // D1 Free counts its day in UTC: the allowance resets at 00:00 UTC, which is 1 pm in NZ in summer and midday in winter.
  it('is the next 00:00 UTC', () => {
    expect(nextAllowanceReset(new Date('2026-10-11T02:00:30.000Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(nextAllowanceReset(new Date('2026-10-11T23:59:59.999Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(nextAllowanceReset(new Date('2026-10-12T00:00:00.000Z')).toISOString()).toBe('2026-10-13T00:00:00.000Z')
    expect(nextAllowanceReset(new Date('2026-12-31T20:00:00.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('what a screen reader is told', () => {
  // The words change only at a few points, so a screen reader announces a few times and not at every step.
  it('says nothing new while the percentage moves within a quarter', () => {
    const said = new Set([0, 4_000, 4_999].map((doneRows) => announcement(job({ doneRows, percent: Math.floor((doneRows / 20_000) * 100) }))))
    expect(said.size).toBe(1)
    expect([...said][0]).toBe('Started. Going through up to 20,000 Transactions.')
  })

  it.each([
    [25, '25% done.'],
    [50, '50% done.'],
    [99, '75% done.'],
  ])('says %i%% is "%s"', (percent, words) => {
    expect(announcement(job({ percent }))).toBe(words)
  })

  it('says it started again when the Rules changed, each time, until the next quarter', () => {
    expect(announcement(job({ percent: 0, doneRows: 0, restarts: 1 }))).toBe('The Rules changed, so it started again. Going through up to 20,000 Transactions.')
    expect(announcement(job({ percent: 0, doneRows: 0, restarts: 2 }))).toBe('The Rules changed again, so it started again (2 times). Going through up to 20,000 Transactions.')
    expect(announcement(job({ percent: 25, restarts: 1 }))).toBe('25% done.')
    // A restart at 50% takes it back to the first announcement, which is new words.
    expect(announcement(job({ percent: 0, doneRows: 0, restarts: 1 }))).not.toBe(announcement(job({ percent: 50 })))
  })

  it('says it is paused, and why it will carry on', () => {
    expect(announcement(job({ paused: true }))).toBe('Paused until the daily allowance resets, around midday NZ time.')
  })

  it('says it is finished or stopped, with the counts', () => {
    expect(announcement(job({ status: 'done', doneRows: 20_000, changedRows: 1_234, percent: 100 }))).toBe('Finished. Looked at all 20,000 Transactions and updated 1,234 of them.')
    expect(announcement(job({ status: 'stopped', doneRows: 7_000, changedRows: 300 }))).toBe(
      'Stopped. Looked at 7,000 Transactions and updated 300 of them. Those keep the result they were given and the rest are as they were.',
    )
  })
})
