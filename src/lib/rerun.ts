import type { RerunJob } from '@/generated/api/rule-rerun'
import { formatDateTime } from './format'

// How the Rules page tells the Admin about applying the Rules to every Transaction (worker/rule-rerun.ts): how far it has got,
// when it last did something, and the few words a screen reader is given as it goes. Plain NZ English, with the thousands marked.
// The job is as the API lists it.

export type { RerunJob }

const count = new Intl.NumberFormat('en-NZ')
const transactions = (n: number) => `${count.format(n)} ${n === 1 ? 'Transaction' : 'Transactions'}`

/** How much of the way through, 0 to 100. Only a finished job reads 100: one that has looked at all it counted still has its last step to record. */
export function percentDone(job: RerunJob): number {
  if (job.status === 'done') return 100
  if (job.totalRows === 0) return 0
  return Math.min(99, Math.floor((job.doneRows / job.totalRows) * 100))
}

/** Where it is up to, or what it did. */
export function progressSentence(job: RerunJob): string {
  if (job.status === 'running') return `Looked at ${count.format(job.doneRows)} of ${transactions(job.totalRows)} (${percentDone(job)}%).`
  if (job.doneRows === 0) return 'Finished. There were no Transactions to look at.'
  // Transactions can be removed while it runs, so it says how many it looked at when that is not how many it counted to start with.
  const looked = job.doneRows !== job.totalRows ? transactions(job.doneRows) : job.totalRows === 1 ? 'the 1 Transaction' : `all ${transactions(job.totalRows)}`
  const updated = job.changedRows === 0 ? 'none of them' : job.doneRows === 1 ? 'it' : `${count.format(job.changedRows)} of them`
  return `Finished. Looked at ${looked} and updated ${updated}.`
}

/** When it last did something, or finished. */
export const updatedSentence = (job: RerunJob): string =>
  job.status === 'done' && job.finishedAt !== null ? `Finished ${formatDateTime(job.finishedAt)}.` : `Last updated ${formatDateTime(job.updatedAt)}.`

/** Said when the Rules changed while it ran and it went back to the first Transaction; null if they did not. */
export function restartNote(job: RerunJob): string | null {
  if (job.restarts === 0) return null
  return job.restarts === 1
    ? 'The Rules changed while this was running, so it started again from the first Transaction.'
    : `The Rules changed ${job.restarts} times while this was running, so it started again from the first Transaction each time.`
}

/**
 * The words for the page's live region. They change only when it starts (or starts again), at each quarter of the way, and when it
 * finishes, so a screen reader announces those and not every step.
 */
export function announcement(job: RerunJob): string {
  if (job.status === 'done') return progressSentence(job)
  const quarter = Math.floor(percentDone(job) / 25) * 25
  if (quarter > 0) return `${quarter}% done.`
  const going = `Going through ${transactions(job.totalRows)}.`
  return job.restarts > 0 ? `The Rules changed, so it started again. ${going}` : `Started. ${going}`
}
