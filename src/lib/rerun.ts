import type { RerunJob } from '@/generated/api/rule-rerun'
import { formatDateTime } from './format'

// How the Rules page tells the Admin about applying the Rules to every Transaction (worker/rule-rerun.ts): how far it has got,
// how long it has to go, when it last did something, and the few words a screen reader is given as it goes. Plain NZ English, with the
// thousands marked. The job is as the API lists it.

export type { RerunJob }

const count = new Intl.NumberFormat('en-NZ')
const transactions = (n: number) => `${count.format(n)} ${n === 1 ? 'Transaction' : 'Transactions'}`

/** Where it is up to, or what it did. The total is the most there could be (a Transaction's ID, not a count), so it says "up to". */
export function progressSentence(job: RerunJob): string {
  if (job.status === 'running') return `Looked at ${count.format(job.doneRows)} of up to ${transactions(job.totalRows)} (${job.percent}%).`
  if (job.status === 'stopped') {
    if (job.doneRows === 0) return 'Stopped before it looked at any Transaction. Nothing was changed.'
    return `Stopped. Looked at ${transactions(job.doneRows)} and updated ${job.changedRows === 0 ? 'none' : count.format(job.changedRows)} of them. Those keep the result they were given and the rest are as they were.`
  }
  if (job.doneRows === 0) return 'Finished. There were no Transactions to look at.'
  // IDs have gaps, so it can look at fewer than the most there could be: it says how many it looked at when that is not the total.
  const looked = job.doneRows !== job.totalRows ? transactions(job.doneRows) : job.totalRows === 1 ? 'the 1 Transaction' : `all ${transactions(job.totalRows)}`
  const updated = job.changedRows === 0 ? 'none of them' : job.doneRows === 1 ? 'it' : `${count.format(job.changedRows)} of them`
  return `Finished. Looked at ${looked} and updated ${updated}.`
}

/** When it last did something, or ended. */
export const updatedSentence = (job: RerunJob): string =>
  job.status === 'done' && job.finishedAt !== null
    ? `Finished ${formatDateTime(job.finishedAt)}.`
    : job.status === 'stopped' && job.finishedAt !== null
      ? `Stopped ${formatDateTime(job.finishedAt)}.`
      : `Last updated ${formatDateTime(job.updatedAt)}.`

/** Said when the Rules changed while it ran and it went back to the first Transaction; null if they did not. */
export function restartNote(job: RerunJob): string | null {
  if (job.restarts === 0) return null
  return job.restarts === 1
    ? 'The Rules changed while this was running, so it started again from the first Transaction.'
    : `The Rules changed ${job.restarts} times while this was running, so it started again from the first Transaction each time.`
}

/** Said when it has used its share of the free plan's day (or the plan said the day's allowance is gone): what happens next. */
export const pausedSentence = () => 'It carries on by itself after the daily allowance resets, around midday NZ time. Open this page then to finish sooner.'

/**
 * How long it has to go, from what is left (the most there could be, less what it has looked at): in steps if the page stays open and in
 * days if it is closed, when only the Worker's crons carry on, a few steps a day. Null when there is nothing left to say it of.
 */
export function estimateSentence(job: RerunJob): string | null {
  const left = job.totalRows - job.doneRows
  if (job.status !== 'running' || job.paused || left <= 0) return null
  const steps = Math.ceil(left / job.stepRows)
  const days = Math.ceil(left / job.cronRowsPerDay)
  return `About ${steps} more ${steps === 1 ? 'step' : 'steps'} if you keep this page open, or ${days <= 1 ? 'less than a day' : `about ${days} days`} if you close it. Keep this page open to finish sooner.`
}

/** When the free plan's day changes: D1 counts it in UTC, so the next 00:00 UTC (1 pm in New Zealand in summer, midday in winter). */
export const nextAllowanceReset = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))

/**
 * The words for the page's live region. They change only when it starts (or starts again, which is new words each time), at each
 * quarter of the way, when it pauses, and when it ends, so a screen reader announces those and not every step.
 */
export function announcement(job: RerunJob): string {
  if (job.status !== 'running') return progressSentence(job)
  if (job.paused) return 'Paused until the daily allowance resets, around midday NZ time.'
  const quarter = Math.floor(job.percent / 25) * 25
  if (quarter > 0) return `${quarter}% done.`
  const going = `Going through up to ${transactions(job.totalRows)}.`
  if (job.restarts === 0) return `Started. ${going}`
  return job.restarts === 1 ? `The Rules changed, so it started again. ${going}` : `The Rules changed again, so it started again (${job.restarts} times). ${going}`
}
