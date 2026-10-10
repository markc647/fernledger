// Re-running the Rules over all the history on file: every Transaction is given the result of the Rules as they are now,
// including none, so a Rule that was changed, moved or removed shows in the past as well as in new Imports.
//
// Free plan (ADR 0004): an invocation gets 10 ms of CPU and 50 D1 queries, and a day 100k rows written and 5 million read, so
// 100,000 Transactions cannot be done in one request. The job is a resumable walk, as the backup is (backup.ts):
// - The walk is by Transaction ID, RERUN_CHUNK Transactions at a time, in SQL. The Worker never loops over a Transaction: it
//   asks D1 for the end of the next chunk and hands that range to one UPDATE.
// - Its place is the row in `data_migration_progress` (migrations/1401). The chunk's results and the new place are one D1 batch,
//   so they are saved together or not at all, and a chunk that fails (or an invocation that is killed) leaves the job where it
//   was. Two requests that take the same chunk at once cannot both move the place on: the move only happens if the place is
//   still the one they read.
// - A step is one chunk, from a browser request (POST /api/rules/rerun/step, repeated by the Rules page for as long as the page
//   is open) or from a cron run. The crons that are already there carry on a running job by a few chunks (CRON_CHUNKS), so it
//   finishes after the page is closed, and over days if the Admin never comes back. No cron trigger was added for it.
// - Only the Transactions whose result changes are written (rows written are the scarcer limit: a changed row costs about
//   two, a row that was already right none), and the results of Rules that now match nothing are cleared.
//
// What a job does not touch: `override_category`, `note` and every other column. A Transaction's Category is its Override first
// (effective-category.ts), so the Admin's choice outranks whatever this stores.
//
// One job at a time (a unique index allows one running row of the kind). The Rules can change while it runs, and the Transactions
// it has been through were given results by the Rules as they were, so a change to the Rules sends the job back to the first
// Transaction (`restartRerun`, put in the same batch as the change). The alternative, finishing and then running again, spends
// the day's reads on work that is thrown away. A change that changes nothing (a Rule saved as it was) restarts nothing.
import type { Member } from './auth'
import { recordChange } from './changelog'
import { isDailyLimitError } from './d1-errors'
import { logEvent } from './log'
import { firstMatchingRule } from './rule-apply'

export const RERUN_KIND = 'rules-rerun'

/**
 * Transactions looked at by one step. Measured (rule-rerun.test.ts pins it): a chunk reads each Transaction twice and walks it past
 * the Rules above the one that wins, and writes only the ones whose result changes (a table row, and an index entry when it has a
 * Category). A step reads about the Rules plus 6 rows for each Transaction: 11,000 with 5 Rules, 106,000 with 100 (the most there can
 * be) when none matches early, and writes at most 2,000; it is 4 to 7 D1 queries, and the Worker's own part is a few small
 * objects, far inside 10 ms of CPU. A smaller chunk only multiplies the requests; a larger one makes each wait longer and puts
 * more in a failed chunk's way.
 */
export const RERUN_CHUNK = 1000

/**
 * Chunks one cron run does. A chunk is 3 queries, so a run is at most 13 of the 50 the invocation may make, which leaves room for
 * the backup's continuation (20 of the 50) and Sync, which share the daily crons. Not done on the weekly cron: the backup starts there and
 * spends 40.
 */
export const CRON_CHUNKS = 3

type JobRow = {
  id: number
  status: 'running' | 'done'
  cursor: number
  end_id: number
  total_rows: number
  done_rows: number
  changed_rows: number
  restarts: number
  started_by: string
  started_at: string
  updated_at: string
  finished_at: string | null
}

/** A job as the API gives it. The times are UTC, ISO 8601. */
export type RerunJob = {
  id: number
  status: 'running' | 'done'
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  /** How many Transactions the job looks at, and how many it has so far (both start again from nothing if the job restarts). */
  totalRows: number
  doneRows: number
  /** Of those looked at, how many it had to write because their result was different. */
  changedRows: number
  /** How many times it went back to the first Transaction because the Rules changed while it ran. */
  restarts: number
}

const view = (row: JobRow): RerunJob => ({
  id: row.id,
  status: row.status,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
  totalRows: row.total_rows,
  doneRows: row.done_rows,
  changedRows: row.changed_rows,
  restarts: row.restarts,
})

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const COLUMNS = 'id, status, cursor, end_id, total_rows, done_rows, changed_rows, restarts, started_by, started_at, updated_at, finished_at'

const RUNNING = `SELECT ${COLUMNS} FROM data_migration_progress WHERE kind = ? AND status = 'running'`
const LATEST = `SELECT ${COLUMNS} FROM data_migration_progress WHERE kind = ? ORDER BY id DESC LIMIT 1`

const runningJob = (db: D1Database) => db.prepare(RUNNING).bind(RERUN_KIND).first<JobRow>()
const latestJob = (db: D1Database) => db.prepare(LATEST).bind(RERUN_KIND).first<JobRow>()

// The end of the next chunk: how many Transactions there are from ?1 (exclusive) to ?2 (inclusive), up to ?3, and the highest ID
// among them. Reads at most ?3 rows. IDs have gaps (Replace removes rows), so a chunk is a count of Transactions, not a span of IDs.
const EDGE = `SELECT COUNT(*) AS n, MAX(id) AS last FROM (SELECT id FROM transactions WHERE id > ?1 AND id <= ?2 ORDER BY id LIMIT ?3)`

// One chunk, ?1 (exclusive) to ?2 (inclusive): finds the Rule that wins for each Transaction and stores its result, or clears the
// stored one when none wins. `IS NOT` makes NULL equal NULL, so a Transaction whose result is already right is not updated.
// What it reads (`meta.rows_read`, pinned in rule-rerun.test.ts): `NOT INDEXED` makes the walk an ID range; each Transaction is read
// there and again as the row the UPDATE finds; and the Rules are walked by `firstMatchingRule`.
const WALK = `
  WITH walked AS (
    SELECT t.id AS id, ${firstMatchingRule('t')} AS rule_id
    FROM transactions t NOT INDEXED
    WHERE t.id > ?1 AND t.id <= ?2
  )
  UPDATE transactions
  SET rule_id = hit.id, rule_category = hit.category_id, rule_transfer = CASE WHEN hit.is_transfer = 1 THEN 1 END
  FROM walked LEFT JOIN rules hit ON hit.id = walked.rule_id
  WHERE transactions.id = walked.id
    AND (transactions.rule_id IS NOT hit.id
      OR transactions.rule_category IS NOT hit.category_id
      OR transactions.rule_transfer IS NOT (CASE WHEN hit.is_transfer = 1 THEN 1 END))`

// Moves the job's place on, after WALK in the same batch. It moves only a running job that is still where this request saw it
// (?2), so a step that lost a race, or a job that went back to the start meanwhile, is left alone; the new row is returned.
// `changes()` is how many rows WALK just updated.
const ADVANCE = `
  UPDATE data_migration_progress
  SET cursor = ?3, done_rows = done_rows + ?4, changed_rows = changed_rows + changes(), updated_at = ${NOW}
  WHERE id = ?1 AND status = 'running' AND cursor = ?2
  RETURNING ${COLUMNS}`

// Ends a job, if nothing has moved it since this request saw it (?2 its place, ?3 where it ends).
const FINISH = `
  UPDATE data_migration_progress SET status = 'done', finished_at = ${NOW}, updated_at = ${NOW}
  WHERE id = ?1 AND status = 'running' AND cursor = ?2 AND end_id = ?3`

// Sends a running job back to the first Transaction, with a fresh count of what there is to look at. `restarts` counts only a
// job that had got somewhere. Not a read when there is no running job: the subqueries run only for a row that matches.
const RESTART = `
  UPDATE data_migration_progress
  SET restarts = restarts + (cursor > 0), cursor = 0, done_rows = 0, changed_rows = 0, updated_at = ${NOW},
      end_id = (SELECT COALESCE(MAX(id), 0) FROM transactions), total_rows = (SELECT COUNT(*) FROM transactions)
  WHERE kind = ? AND status = 'running'`

const INSERT = `INSERT INTO data_migration_progress (kind, status, end_id, total_rows, started_by) VALUES (?, 'running', ?, ?, ?)`

const number = new Intl.NumberFormat('en-NZ')

/**
 * The statement that sends a running job back to the start. Put it in the batch of any change to what the Rules would give
 * (`recordChange(db, [change, restartRerun(db)], …)`), so the change and the restart commit together. It does nothing when
 * no job is running.
 */
export const restartRerun = (db: D1Database) => db.prepare(RESTART).bind(RERUN_KIND)

/** The latest job, running or done, or null if there has never been one. */
export async function latestRerun(db: D1Database): Promise<RerunJob | null> {
  const row = await latestJob(db)
  return row ? view(row) : null
}

/**
 * Starts a job: records where it ends, how many Transactions it will look at, and a Change Log entry, in one batch.
 * Null when one is already running. It looks at nothing yet; the steps do.
 */
export async function startRerun(db: D1Database, actor: Member): Promise<RerunJob | null> {
  if (await runningJob(db)) return null
  const { total, last } = (await db.prepare('SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS last FROM transactions').first<{ total: number; last: number }>())!
  try {
    await recordChange(db, db.prepare(INSERT).bind(RERUN_KIND, last, total, actor.email), {
      actor,
      type: 'rule',
      summary: `Started applying the Rules to all ${number.format(total)} Transactions`,
      after: { transactionsToCheck: total },
    })
  } catch (error) {
    // Another request started one after the check above: the unique index let only one in, and its entry went with it.
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return null
    throw error
  }
  logEvent('rerun.started', { count: total })
  return view((await latestJob(db))!)
}

/** Records the end of a job and returns it as it is then. */
async function finish(db: D1Database, job: JobRow): Promise<JobRow> {
  // Recorded for the Admin who started it, who is not necessarily who (or what) is running the last step: a cron run is nobody.
  await recordChange(db, db.prepare(FINISH).bind(job.id, job.cursor, job.end_id), {
    actor: { email: job.started_by, role: 'admin' },
    type: 'rule',
    summary: `Finished applying the Rules to all Transactions: ${number.format(job.done_rows)} looked at, ${number.format(job.changed_rows)} changed`,
    after: { transactionsChecked: job.done_rows, transactionsChanged: job.changed_rows, ...(job.restarts > 0 ? { startedAgain: job.restarts } : {}) },
  })
  logEvent('rerun.finished', { id: job.id, count: job.done_rows })
  return (await latestJob(db))!
}

/** One chunk of a running job, then the job as it is. At most 7 queries: the edge, the batch of 2, and when it ends the Change Log batch of 2 and a read. */
async function advance(db: D1Database, job: JobRow): Promise<JobRow> {
  const edge = (await db.prepare(EDGE).bind(job.cursor, job.end_id, RERUN_CHUNK).first<{ n: number; last: number | null }>())!
  if (edge.last === null) return finish(db, job) // nothing is left, whether the walk reached the end or the rest was removed
  const [, moved] = await db.batch([db.prepare(WALK).bind(job.cursor, edge.last), db.prepare(ADVANCE).bind(job.id, job.cursor, edge.last, edge.n)])
  const next = moved!.results[0] as JobRow | undefined
  // Someone else took this chunk, or the Rules changed and the job went back to the start: it is whatever it is now.
  if (!next) return (await latestJob(db))!
  logEvent('rerun.step', { id: job.id, count: edge.n })
  // A short chunk, or one that reached the end, is the last. (If the job restarted with a different end meanwhile, only its own end counts.)
  const last = next.cursor >= next.end_id || (edge.n < RERUN_CHUNK && next.end_id === job.end_id)
  return last ? finish(db, next) : next
}

/**
 * Does one chunk of the running job, if there is one, and answers with the latest job (null if there never was one).
 * The browser calls this until the job is done; a step on a job that is not running changes nothing.
 */
export async function stepRerun(db: D1Database): Promise<RerunJob | null> {
  const running = await runningJob(db)
  if (running) return view(await advance(db, running))
  return latestRerun(db)
}

/**
 * The cron run: carries on a running job by up to CRON_CHUNKS chunks, or costs one query when there is none. When D1 says the
 * day's allowance is used up it stops without failing the run, because the job is where it was and the next run carries on.
 */
export async function continueRerun(db: D1Database): Promise<void> {
  let job = await runningJob(db)
  try {
    for (let chunks = 0; job && chunks < CRON_CHUNKS; chunks++) {
      const next = await advance(db, job)
      job = next.status === 'running' ? next : null
    }
  } catch (error) {
    if (!isDailyLimitError(error)) throw error
    logEvent('rerun.daily-limit')
  }
}
