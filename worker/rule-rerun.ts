// Re-running the Rules over all the history on file: every Transaction is given the result of the Rules as they are now,
// including none, so a Rule that was changed, moved or removed shows in the past as well as in new Imports.
//
// Free plan (ADR 0004): an invocation gets 10 ms of CPU and 50 D1 queries, and a day 100k rows written and 5 million read, so
// 100,000 Transactions cannot be done in one request, and doing them must not use the day's rows up for everything else
// (once D1's daily allowance is gone every request fails, for every Member, until 00:00 UTC). The job is a resumable walk, as the
// backup is (backup.ts):
// - The walk is by Transaction ID, a chunk at a time (`chunkFor`: fewer when there are many Rules, since each Transaction is
//   checked against them), in SQL. The Worker never loops over a Transaction: it asks D1 for the end of the next chunk and hands
//   that range to one UPDATE.
// - Its place is the row in `data_migration_progress` (migrations/1401). The chunk's results and the new place are one D1 batch,
//   so they are saved together or not at all, and a chunk that fails (or an invocation that is killed) leaves the job where it
//   was. Two requests that take the same chunk at once cannot both move the place on: the move only happens if the place is
//   still the one they read, and a request that finds it is not does no work at all (WALK checks too).
// - A step is one chunk, from a browser request (POST /api/rules/rerun/step, repeated by the Rules page for as long as the page
//   is open) or from a cron run. The crons that are already there carry on a running job by a few chunks (CRON_CHUNKS; one
//   when a backup is also being carried on), so it finishes after the page is closed, and over days if the Admin never comes
//   back. No cron trigger was added for it.
// - Only the Transactions whose result changes are written (rows written are the scarcer limit: a changed row costs one to
//   three, a row that was already right none), and the results of Rules that now match nothing are cleared.
// - The job keeps its own tally of the rows D1 says it read and wrote today (UTC) and pauses, before a chunk that would pass
//   DAILY_READ_BUDGET or DAILY_WRITE_BUDGET, until the day changes. Both are under half of the free plan's day, which leaves the
//   rest for the Members using the app, an Import and the backup. A step that finds the job paused answers so and does nothing;
//   the next step or cron run after 00:00 UTC carries on.
//
// What a job does not touch: `override_category`, `note` and every other column. A Transaction's Category is its Override first
// (effective-category.ts), so the Admin's choice outranks whatever this stores.
//
// One job at a time (a unique index allows one running row of the kind). The Rules can change while it runs, and the Transactions
// it has been through were given results by the Rules as they were, so a change to the Rules sends the job back to the first
// Transaction (`restartRerun`, put in the same batch as the change). The alternative, finishing and then running again, spends
// the day's reads on work that is thrown away. A change that changes nothing (a Rule saved as it was) restarts nothing. The Admin
// can also stop a job (`stopRerun`); the Transactions it has been through keep the result they were given.
//
// After a restore from a backup a running job carries on from the place it was saved at, over data that may be older or newer than
// that place assumed. Restart it (change a Rule, or stop it and start it again) so every Transaction is looked at.
import type { Member } from './auth'
import { recordChange } from './changelog'
import { isDailyLimitError } from './d1-errors'
import { logEvent } from './log'
import { firstMatchingRule } from './rule-apply'

export const RERUN_KIND = 'rules-rerun'

/** The most Transactions one step looks at, and the fewest. */
export const RERUN_CHUNK = 1000
export const MIN_CHUNK = 100
/** Rows one step may read, roughly: it looks at as many Transactions as fit in this many reads. */
export const STEP_READS = 25_000
/**
 * Rows read for each Transaction beyond one for each Rule, at most. Measured (rule-rerun.test.ts pins it): a chunk reads each
 * Transaction in the walk (1, and 1 more to find where its chunk ends), and walks it past the Rules above the one that wins; one whose
 * result changes costs 6 more (the row the UPDATE finds, and its index entries). So 1,000 Transactions that all change read
 * 15,000 with 5 Rules, 40,000 with 30 and 110,000 with 100 when none matches early; one that needs no change costs 4 over the Rules.
 */
export const READS_PER_ROW = 10

/**
 * Transactions looked at by one step when there are `rules` Rules in use: STEP_READS / (rules + READS_PER_ROW), from RERUN_CHUNK
 * (up to 15 Rules) down to MIN_CHUNK (100 Rules gives 227), so a step is about 25,000 reads, at most 5 to 8 D1 queries, and the
 * Worker's own part is a few small objects, far inside 10 ms of CPU. A smaller chunk only multiplies the requests; a larger one
 * makes each wait longer and puts more in a failed chunk's way.
 */
export const chunkFor = (rules: number) => Math.min(RERUN_CHUNK, Math.max(MIN_CHUNK, Math.floor(STEP_READS / (rules + READS_PER_ROW))))

/**
 * The job's own share of D1 Free's day (5 million rows read, 100,000 written; ADR 0004), counted from what D1 reports for each of
 * its queries. A little under half of each, so the Members, an Import and the backup keep the rest. The day is the UTC day, which
 * is when D1's allowance resets (about midday in New Zealand).
 */
export const DAILY_READ_BUDGET = 2_500_000
export const DAILY_WRITE_BUDGET = 40_000
// What a chunk is taken to cost before it is run, to see whether it fits in what is left of the day. Reads: a step is sized to
// STEP_READS whatever the Rules, so this much with a margin. Writes: the most a changed Transaction can cost, for the most Transactions a
// step looks at: a table row, and the rule_category index entry out and in. (The local database counts a Category that changes to
// another as 2 writes, and a Category it did not have as 2 too; the estimate is 3 in case D1 bills an index entry that changes as a
// delete and an insert.)
export const ESTIMATED_STEP_READS = STEP_READS + 5_000
export const ESTIMATED_WRITES_PER_ROW = 3

/**
 * Chunks one cron run does. The queries of a run are 1 to find the job, 4 for each chunk (the end of the chunk, the batch of 2, the
 * day's tally) and 3 more to end the job, which is `CRON_QUERIES` at most. The backup's continuation spends up to 20 of the same 50
 * (backup.ts), and Sync shares the daily crons, so a cron run that is also carrying a backup on does one chunk (`BACKUP_CHUNKS`).
 * Not done on the weekly cron: the backup starts there and spends 40.
 */
export const CRON_CHUNKS = 3
export const BACKUP_CHUNKS = 1
export const QUERIES_PER_CHUNK = 4
export const QUERIES_TO_FINISH = 3
export const cronQueries = (chunks: number) => 1 + chunks * QUERIES_PER_CHUNK + QUERIES_TO_FINISH

type JobRow = {
  id: number
  status: 'running' | 'done' | 'stopped'
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
  usage_day: string | null
  day_rows_read: number
  day_rows_written: number
  /** Rules in use, which sets the size of a chunk: read only by the queries that answer the page (`RULES_IN_USE`). */
  rule_count?: number
}

/** A job as the API gives it. The times are UTC, ISO 8601. */
export type RerunJob = {
  id: number
  status: 'running' | 'done' | 'stopped'
  startedAt: string
  updatedAt: string
  /** When it ended, done or stopped; null while it runs. */
  finishedAt: string | null
  /**
   * The most Transactions it can look at: the highest Transaction ID when it started. IDs have gaps, and counting the Transactions would
   * read every one, so the page says "up to".
   */
  totalRows: number
  doneRows: number
  /** Of those looked at, how many it had to write because their result was different. */
  changedRows: number
  /** How far along the IDs, 0 to 100 (100 only for a job that is done). */
  percent: number
  /** How many times it went back to the first Transaction because the Rules changed while it ran. */
  restarts: number
  /** Transactions one step looks at now, and how many the crons would do in a day if nobody has the page open. */
  stepRows: number
  cronRowsPerDay: number
  /** Running but waiting for D1's day to change, because the next chunk would pass the job's share of the day. */
  paused: boolean
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const COLUMNS = `id, status, cursor, end_id, total_rows, done_rows, changed_rows, restarts, started_by, started_at, updated_at, finished_at,
  usage_day, day_rows_read, day_rows_written`
// The number of Rules in use, at most 100 reads. Only the queries that answer the page ask for it, so a cron run that finds nothing to do
// reads one table.
const RULES_IN_USE = `(SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) AS rule_count`

/** The UTC day a moment is in, as D1 counts a day. */
export const utcDay = (now: Date) => now.toISOString().slice(0, 10)

/** Whether the next chunk of a running job would pass its share of today's rows. A job that has done nothing today never is. */
export function isPaused(job: JobRow, now: Date): boolean {
  if (job.status !== 'running') return false
  const today = job.usage_day === utcDay(now)
  const reads = today ? job.day_rows_read : 0
  const writes = today ? job.day_rows_written : 0
  return reads + ESTIMATED_STEP_READS > DAILY_READ_BUDGET || writes + RERUN_CHUNK * ESTIMATED_WRITES_PER_ROW > DAILY_WRITE_BUDGET
}

function view(row: JobRow, rules: number, now = new Date()): RerunJob {
  const stepRows = chunkFor(rules)
  const along = row.end_id === 0 ? 0 : Math.floor((row.cursor / row.end_id) * 100)
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    totalRows: row.total_rows,
    doneRows: row.done_rows,
    changedRows: row.changed_rows,
    percent: row.status === 'done' ? 100 : Math.min(row.status === 'running' ? 99 : 100, along),
    restarts: row.restarts,
    stepRows,
    cronRowsPerDay: 2 * CRON_CHUNKS * stepRows,
    paused: isPaused(row, now),
  }
}

const RUNNING = (columns: string) => `SELECT ${columns} FROM data_migration_progress WHERE kind = ? AND status = 'running'`
const LATEST = (columns: string) => `SELECT ${columns} FROM data_migration_progress WHERE kind = ? ORDER BY id DESC LIMIT 1`
const WITH_RULES = `${COLUMNS}, ${RULES_IN_USE}`

const runningJob = (db: D1Database) => db.prepare(RUNNING(COLUMNS)).bind(RERUN_KIND).first<JobRow>()
const latestJob = (db: D1Database) => db.prepare(LATEST(COLUMNS)).bind(RERUN_KIND).first<JobRow>()
/** The job as the page is told of it: with the number of Rules, which says how big a step is. */
const latestForPage = async (db: D1Database) => {
  const row = await db.prepare(LATEST(WITH_RULES)).bind(RERUN_KIND).first<JobRow>()
  return row ? view(row, row.rule_count!) : null
}

// The end of the next chunk: how many Transactions there are from ?1 (exclusive) to ?2 (inclusive), up to `size`, and the highest ID
// among them. Reads at most `size` rows. IDs have gaps (Replace removes rows), so a chunk is a count of Transactions, not a span of IDs.
// `size` is `chunkFor` worked out in the same query from the Rules in use, so no query of its own is spent on counting them
// (rule-rerun.test.ts checks the two agree): ?3 is the fewest, ?4 the most, ?5 the reads for a step and ?6 the reads for a Transaction.
const EDGE = `
  WITH size AS (
    SELECT MAX(CAST(?3 AS INTEGER), MIN(CAST(?4 AS INTEGER), CAST(?5 AS INTEGER) / ((SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) + CAST(?6 AS INTEGER)))) AS n
  )
  SELECT COUNT(*) AS n, MAX(id) AS last, (SELECT n FROM size) AS size
  FROM (SELECT id FROM transactions WHERE id > ?1 AND id <= ?2 ORDER BY id LIMIT (SELECT n FROM size))`

// One chunk, ?1 (exclusive) to ?2 (inclusive): finds the Rule that wins for each Transaction and stores its result, or clears the
// stored one when none wins. `IS NOT` makes NULL equal NULL, so a Transaction whose result is already right is not updated.
// The end of the range is the guard for a step that lost a race: it is ?2 only while the job (?3) is still running and still at ?1,
// the place this step read, and otherwise the range is empty. Without it a step that had lost to another would still read the whole
// chunk to find nothing to change. (It is the end of the range and not a condition on each row, so it is worked out once: as a
// condition on each row it was measured at 4 more reads for every Transaction.)
// What it reads (`meta.rows_read`, pinned in rule-rerun.test.ts): `NOT INDEXED` makes the walk an ID range; each Transaction is read
// there and again as the row the UPDATE finds; and the Rules are walked by `firstMatchingRule`.
const WALK = `
  WITH walked AS (
    SELECT t.id AS id, ${firstMatchingRule('t')} AS rule_id
    FROM transactions t NOT INDEXED
    WHERE t.id > ?1
      AND t.id <= (SELECT CASE WHEN EXISTS (SELECT 1 FROM data_migration_progress WHERE id = ?3 AND status = 'running' AND cursor = ?1) THEN ?2 ELSE ?1 END)
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

// Adds what a step cost to today's tally, starting the tally again if it is a new UTC day (?2). ?3 and ?4 are the rows D1 reported.
const TALLY = `
  UPDATE data_migration_progress
  SET day_rows_read = (CASE WHEN usage_day = ?2 THEN day_rows_read ELSE 0 END) + ?3,
      day_rows_written = (CASE WHEN usage_day = ?2 THEN day_rows_written ELSE 0 END) + ?4,
      usage_day = ?2
  WHERE id = ?1
  RETURNING ${COLUMNS}`

// Ends a job, if nothing has moved it since this request saw it (?2 its place, ?3 where it ends).
const FINISH = `
  UPDATE data_migration_progress SET status = 'done', finished_at = ${NOW}, updated_at = ${NOW}
  WHERE id = ?1 AND status = 'running' AND cursor = ?2 AND end_id = ?3`

// The Admin ends a job early.
const STOP = `
  UPDATE data_migration_progress SET status = 'stopped', finished_at = ${NOW}, updated_at = ${NOW}
  WHERE id = ?1 AND status = 'running'`

// Sends a running job back to the first Transaction, with the end moved to the highest ID now. (Not a count of the Transactions,
// which would read every one: the highest ID is one read.) `restarts` counts only a job that had got somewhere, and the day's
// tally is kept: what was read is read. Not a read at all when there is no running job: the subqueries run only for a row that matches.
const RESTART = `
  UPDATE data_migration_progress
  SET restarts = restarts + (cursor > 0), cursor = 0, done_rows = 0, changed_rows = 0, updated_at = ${NOW},
      end_id = (SELECT COALESCE(MAX(id), 0) FROM transactions), total_rows = (SELECT COALESCE(MAX(id), 0) FROM transactions)
  WHERE kind = ? AND status = 'running'`

// A new job takes up the day's tally where the last job left it, when that was today (?4, the UTC day): the day's share of rows is the
// app's, not a job's, so stopping a job and starting another, or finishing one and applying the Rules again, does not spend it twice.
const INSERT = `
  WITH counted AS (
    SELECT usage_day, day_rows_read, day_rows_written FROM data_migration_progress WHERE kind = ?1 AND usage_day = ?4 ORDER BY id DESC LIMIT 1
  )
  INSERT INTO data_migration_progress (kind, status, end_id, total_rows, started_by, usage_day, day_rows_read, day_rows_written)
  VALUES (?1, 'running', ?2, ?2, ?3, (SELECT usage_day FROM counted), COALESCE((SELECT day_rows_read FROM counted), 0), COALESCE((SELECT day_rows_written FROM counted), 0))`

const number = new Intl.NumberFormat('en-NZ')

/**
 * The statement that sends a running job back to the start. Put it in the batch of any change to what the Rules would give
 * (`recordChange(db, [change, restartRerun(db)], …)`), so the change and the restart commit together. It does nothing when
 * no job is running.
 */
export const restartRerun = (db: D1Database) => db.prepare(RESTART).bind(RERUN_KIND)

/** The latest job, running or ended, or null if there has never been one. */
export const latestRerun = (db: D1Database): Promise<RerunJob | null> => latestForPage(db)

/**
 * Starts a job: records where it ends and a Change Log entry, in one batch. Null when one is already running. It looks at nothing
 * yet; the steps do.
 */
export async function startRerun(db: D1Database, actor: Member): Promise<RerunJob | null> {
  if (await runningJob(db)) return null
  // The highest ID, which is one read; counting the Transactions would read every one.
  const { last } = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM transactions').first<{ last: number }>())!
  try {
    await recordChange(db, db.prepare(INSERT).bind(RERUN_KIND, last, actor.email, utcDay(new Date())), {
      actor,
      type: 'rule',
      summary: last === 0 ? 'Started applying the Rules to all Transactions (there are none yet)' : `Started applying the Rules to up to ${number.format(last)} Transactions`,
      after: { transactionsUpTo: last },
    })
  } catch (error) {
    // Another request started one after the check above: the unique index let only one in, and its entry went with it.
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return null
    throw error
  }
  logEvent('rerun.started', { count: last })
  return (await latestForPage(db))!
}

const counts = (job: JobRow) => ({
  transactionsLookedAt: job.done_rows,
  transactionsUpdated: job.changed_rows,
  ...(job.restarts > 0 ? { startedAgain: job.restarts } : {}),
})
const countsSentence = (job: JobRow) => `${number.format(job.done_rows)} looked at, ${number.format(job.changed_rows)} updated`

/**
 * The Admin ends the running job. The Transactions it has been through keep the result they were given; the others are as they
 * were. Null when none is running (or it ended before this did, in which case nothing is written).
 */
export async function stopRerun(db: D1Database, actor: Member): Promise<RerunJob | null> {
  const job = await runningJob(db)
  if (!job) return null
  const [stopped] = await recordChange(db, db.prepare(STOP).bind(job.id), {
    actor,
    type: 'rule',
    summary: `Stopped applying the Rules to all Transactions: ${countsSentence(job)}`,
    after: counts(job),
    onlyIfChanged: true,
  })
  if (stopped!.meta.changes === 0) return null
  logEvent('rerun.stopped', { id: job.id, count: job.done_rows })
  return (await latestForPage(db))!
}

/** Records the end of a job, once however many requests get here, and returns the job as it is then. */
async function finish(db: D1Database, job: JobRow): Promise<JobRow> {
  // Recorded for the Admin who started it, who is not necessarily who (or what) is running the last step: a cron run is nobody.
  // The entry is written only if this request is the one that ended the job: not if another got there first, and not if the job
  // went back to the start (the Rules changed) after this request read it.
  const [ended] = await recordChange(db, db.prepare(FINISH).bind(job.id, job.cursor, job.end_id), {
    actor: { email: job.started_by, role: 'admin' },
    type: 'rule',
    summary: `Finished applying the Rules to all Transactions: ${countsSentence(job)}`,
    after: counts(job),
    onlyIfChanged: true,
  })
  if (ended!.meta.changes > 0) logEvent('rerun.finished', { id: job.id, count: job.done_rows })
  return (await latestJob(db))!
}

/**
 * One chunk of a running job, then the job as it is. At most 8 queries: the end of the chunk, the batch of 2, the day's tally,
 * and when it ends the Change Log batch of 2 and a read. A job that is paused is returned as it is, having cost nothing.
 */
async function advance(db: D1Database, job: JobRow): Promise<JobRow> {
  const now = new Date()
  if (isPaused(job, now)) return job
  const edge = await db.prepare(EDGE).bind(job.cursor, job.end_id, MIN_CHUNK, RERUN_CHUNK, STEP_READS, READS_PER_ROW).all<{ n: number; last: number | null; size: number }>()
  const { n, last, size } = edge.results[0]!
  if (last === null) return finish(db, job) // nothing is left, whether the walk reached the end or the rest was removed
  const [walk, moved] = await db.batch([db.prepare(WALK).bind(job.cursor, last, job.id), db.prepare(ADVANCE).bind(job.id, job.cursor, last, n)])
  const advanced = moved!.results[0] as JobRow | undefined
  // Someone else took this chunk, or the Rules changed and the job went back to the start, or it was stopped: it is whatever it is
  // now, and this request did no work (WALK checks the same thing).
  if (!advanced) return (await latestJob(db))!
  logEvent('rerun.step', { id: job.id, count: n })
  const read = edge.meta.rows_read + walk!.meta.rows_read + moved!.meta.rows_read
  const written = walk!.meta.rows_written + moved!.meta.rows_written
  const next = (await db.prepare(TALLY).bind(job.id, utcDay(now), read, written).first<JobRow>())!
  // A short chunk, or one that reached the end, is the last. (If the job restarted with a different end meanwhile, only its own end counts.)
  const lastChunk = next.cursor >= next.end_id || (n < size && next.end_id === job.end_id)
  return lastChunk ? finish(db, next) : next
}

/**
 * Does one chunk of the running job, if there is one and it is not paused, and answers with the latest job (null if there never
 * was one). The browser calls this until the job is done; a step on a job that is not running changes nothing.
 */
export async function stepRerun(db: D1Database): Promise<RerunJob | null> {
  const running = await db.prepare(RUNNING(WITH_RULES)).bind(RERUN_KIND).first<JobRow>()
  if (running) return view(await advance(db, running), running.rule_count!)
  return latestForPage(db)
}

/**
 * The cron run: carries on a running job by up to `chunks` chunks (CRON_CHUNKS, or BACKUP_CHUNKS when a backup is being carried
 * on too), or costs one query when there is none or it is paused. When D1 says the day's allowance is used up it stops without
 * failing the run, because the job is where it was and the next run carries on.
 */
export async function continueRerun(db: D1Database, chunks = CRON_CHUNKS): Promise<void> {
  let job = await runningJob(db)
  try {
    for (let done = 0; job && done < chunks && !isPaused(job, new Date()); done++) {
      const next = await advance(db, job)
      job = next.status === 'running' ? next : null
    }
  } catch (error) {
    if (!isDailyLimitError(error)) throw error
    logEvent('rerun.daily-limit')
  }
}
