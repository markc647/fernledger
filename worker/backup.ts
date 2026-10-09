// Weekly backup of every table in the database to R2, as NDJSON under a dated prefix plus a manifest.
//
// Free plan (ADR 0004): an invocation gets 10 ms of CPU and 50 subrequests/D1 queries, so one run can't
// assume it finishes in one invocation. The run is therefore a resumable cursor:
// - D1 builds each NDJSON line (json_object) and joins up to CHUNK_ROWS rows, so the Worker never loops
//   over rows; it hands a string to R2 and hashes it. Reads are keyset pages on rowid, never OFFSET.
// - Each chunk is its own R2 object (a "part"), so no part has to be held open between invocations.
// - An invocation stops at a fixed number of D1 and R2 operations AND at about INVOCATION_BYTES of NDJSON,
//   because encoding and hashing cost CPU in proportion to bytes. The cursor is saved after every part, so
//   an invocation killed part-way (CPU limit, outage) loses at most the chunk it was on.
// - The weekly cron starts a run; the other crons continue an unfinished one (a single get when idle).
// - Nothing here deletes anything: an abandoned run stays in the bucket, marked, without a manifest.
import { z } from 'zod/mini'
import { BackupFormatError, quote, sha256Hex, tableSchema, type Manifest, type ManifestTable, type SkippedTable } from './backup-format.ts'
import { logEvent } from './log.ts'

/** Must match the weekly entry in wrangler.jsonc (scripts/wrangler-config.test.mjs checks). */
export const BACKUP_CRON = '0 15 * * SUN'

export const CHUNK_ROWS = 1000
/** Kept far under the 2 MB D1 allows in one string, so a run of long Notes can't fail a read. */
export const CHUNK_BYTES = 262_144
/**
 * About 1 MB of NDJSON per invocation (it stops once it has written this much, so it can overshoot by one chunk).
 * Per MB the Worker does a UTF-8 encode, a SHA-256 and a put: roughly a millisecond each on native code, which
 * leaves most of the 10 ms CPU limit for everything else, Sync included on the daily crons. This is an estimate,
 * not a measurement: CPU time can't be observed from inside a test. Lower it if real invocations show CPU errors.
 */
export const INVOCATION_BYTES = 1_000_000
/** D1 queries plus R2 calls per invocation; the limit is 50 of each, and Sync shares the daily crons. */
export const WEEKLY_OPS = 40
export const CONTINUE_OPS = 20
/** A chunk costs one D1 read, one R2 put for the part and one R2 put for the cursor. */
export const OPS_PER_CHUNK = 3
/** Finishing a run costs the manifest and the final cursor. Kept in hand so a run can always finish. */
const OPS_TO_FINISH = 2

export const BACKUP_STATE_KEY = 'backups/run-state.json'

const runState = z.object({
  status: z.enum(['running', 'complete']),
  prefix: z.string(),
  createdAt: z.string(),
  migrations: z.array(z.string()),
  tables: z.array(tableSchema),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  previousIncomplete: z.optional(z.string()),
  /** Which table is being read, and the last rowid already written for it. */
  tableIndex: z.int().check(z.minimum(0)),
  after: z.int().check(z.minimum(0)),
})
type RunState = z.infer<typeof runState>

const nzDate = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(at)

/** The saved cursor, or null when there is none or it isn't one this code wrote (then the next weekly run starts afresh). */
async function readState(env: Env): Promise<RunState | null> {
  const saved = await env.BACKUPS.get(BACKUP_STATE_KEY)
  if (!saved) return null
  let json: unknown
  try {
    json = JSON.parse(await saved.text())
  } catch {
    json = undefined
  }
  const parsed = runState.safeParse(json)
  if (!parsed.success) {
    logEvent('backup.state_invalid')
    return null
  }
  return parsed.data
}

/**
 * Every table the database has now, read from its schema so a new migration needs no change here. Tables that
 * can't be paged by rowid (WITHOUT ROWID, virtual tables and their shadow tables) are listed as skipped instead.
 */
async function readSchema(db: D1Database): Promise<{ tables: ManifestTable[]; skipped: SkippedTable[] }> {
  const { results } = await db
    .prepare(
      `SELECT m.name AS tbl, m.sql AS sql, tl.type AS kind, tl.wr AS withoutRowid, p.name AS col
         FROM sqlite_master m
         JOIN pragma_table_list tl ON tl.name = m.name AND tl.schema = 'main'
         JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
          AND m.name <> 'd1_migrations'
        ORDER BY m.rowid, p.cid`,
    )
    .all<{ tbl: string; sql: string | null; kind: string; withoutRowid: number; col: string }>()
  const tables = new Map<string, ManifestTable>()
  const skipped = new Map<string, SkippedTable>()
  for (const { tbl, sql, kind, withoutRowid, col } of results) {
    const reason =
      kind === 'virtual'
        ? 'virtual table: its content is rebuilt from other tables, not copied'
        : kind === 'shadow'
          ? 'internal table of a virtual table'
          : withoutRowid
            ? 'WITHOUT ROWID table: it can only be paged by its primary key, which the backup does not do'
            : null
    if (reason) skipped.set(tbl, { name: tbl, reason })
    else {
      if (!tables.has(tbl)) tables.set(tbl, { name: tbl, createSql: sql ?? '', columns: [], rows: 0, parts: [] })
      tables.get(tbl)!.columns.push(col)
    }
  }
  return { tables: [...tables.values()], skipped: [...skipped.values()] }
}

// A blob has no JSON form, so it is written as {"$blob": hex}.
const cell = (column: string) => {
  const c = quote(column)
  return `CASE WHEN typeof(${c}) = 'blob' THEN json_object('$blob', hex(${c})) ELSE ${c} END`
}
// A whole number above 2^53 or an infinity would be changed by JSON, so the backup refuses it.
const unrepresentable = (column: string) => {
  const c = quote(column)
  return `(typeof(${c}) = 'integer' AND (${c} > 9007199254740991 OR ${c} < -9007199254740991)) OR (typeof(${c}) = 'real' AND (${c} = 1e999 OR ${c} = -1e999))`
}

/**
 * Reads the next page of a table as one NDJSON string, built by SQLite. `done` is true when the page ends
 * the table, which a page shorter than CHUNK_ROWS does, so no further (empty) read is needed.
 */
async function readChunk(db: D1Database, table: ManifestTable, after: number) {
  const line = `json_object(${table.columns.map((c) => `'${c.replaceAll("'", "''")}', ${cell(c)}`).join(', ')})`
  const bad = `CASE WHEN ${table.columns.map(unrepresentable).join(' OR ')} THEN 1 ELSE 0 END`
  const kept = 'pos = 1 OR bytes <= ?3' // always at least the first row, then as many as fit in the byte cap
  const row = await db
    .prepare(
      `SELECT group_concat(CASE WHEN ${kept} THEN line END, char(10)) AS body,
              count(CASE WHEN ${kept} THEN 1 END) AS n,
              max(CASE WHEN ${kept} THEN r END) AS last,
              count(*) AS fetched,
              sum(bad) AS bad
         FROM (
           SELECT r, line, bad, row_number() OVER (ORDER BY r) AS pos, sum(length(CAST(line AS BLOB)) + 1) OVER (ORDER BY r) AS bytes FROM (
             SELECT rowid AS r, ${line} AS line, ${bad} AS bad FROM ${quote(table.name)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2
           )
         )`,
    )
    .bind(after, CHUNK_ROWS, CHUNK_BYTES)
    .first<{ body: string | null; n: number; last: number | null; fetched: number; bad: number | null }>()
  if (!row) throw new Error('A read returned no row')
  if (row.bad) {
    throw new BackupFormatError(`Table ${table.name} has ${row.bad} row(s) with a value a backup can't hold exactly (a whole number above 2^53, or infinity).`)
  }
  return { body: row.n > 0 ? row.body : null, n: row.n, last: row.last ?? after, done: row.fetched < CHUNK_ROWS && row.n === row.fetched }
}

/** Does as many chunks as the budgets allow, saving the cursor after each, or finishes with the manifest. */
async function advance(env: Env, state: RunState, opsUsed: number, budget: number, persisted: boolean): Promise<void> {
  let ops = opsUsed
  let bytes = 0
  let rows = 0
  let saved = persisted
  const save = async () => {
    await env.BACKUPS.put(BACKUP_STATE_KEY, JSON.stringify(state))
    ops += 1
    saved = true
  }
  try {
    while (state.tableIndex < state.tables.length && bytes < INVOCATION_BYTES && ops + OPS_PER_CHUNK + OPS_TO_FINISH <= budget) {
      const table = state.tables[state.tableIndex]!
      const chunk = await readChunk(env.DB, table, state.after)
      ops += 1
      if (chunk.body !== null) {
        const encoded = new TextEncoder().encode(`${chunk.body}\n`)
        const key = `${state.prefix}/${encodeURIComponent(table.name)}.${String(table.parts.length + 1).padStart(6, '0')}.ndjson`
        await env.BACKUPS.put(key, encoded, { httpMetadata: { contentType: 'application/x-ndjson' } })
        ops += 1
        table.parts.push({ key, rows: chunk.n, bytes: encoded.byteLength, sha256: await sha256Hex(encoded) })
        table.rows += chunk.n
        state.after = chunk.last
        bytes += encoded.byteLength
        rows += chunk.n
      }
      if (chunk.done) {
        state.tableIndex += 1
        state.after = 0
      }
      saved = false
      if (chunk.body !== null) await save()
    }
    if (state.tableIndex >= state.tables.length) {
      const manifest: Manifest = {
        version: 1,
        createdAt: state.createdAt,
        prefix: state.prefix,
        migrations: state.migrations,
        tables: state.tables,
        skipped: state.skipped,
        previousIncomplete: state.previousIncomplete,
      }
      await env.BACKUPS.put(`${state.prefix}/manifest.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: 'application/json' } })
      state.status = 'complete'
      await save()
      logEvent('backup.complete', { count: state.tables.reduce((sum, t) => sum + t.rows, 0) })
    } else {
      if (!saved) await save()
      logEvent('backup.paused', { count: rows })
    }
  } catch (error) {
    logEvent('backup.failed', { error })
    if (!saved) await save().catch(() => undefined) // keep the table the run had just moved past
    throw error
  }
}

/** The weekly cron: starts a new run under the NZ date of the scheduled time, unless that date is already backed up. */
export async function startBackup(env: Env, scheduledTime: number): Promise<void> {
  const prefix = `backups/${nzDate(new Date(scheduledTime))}`
  const earlier = await readState(env)
  let ops = 1
  // Only a manifest makes a backup complete, so a finished backup of this date is never overwritten.
  if (await env.BACKUPS.head(`${prefix}/manifest.json`)) {
    logEvent('backup.skipped')
    return
  }
  ops += 1
  if (earlier?.status === 'running' && earlier.prefix === prefix) {
    await advance(env, earlier, ops, WEEKLY_OPS, true)
    return
  }
  let previousIncomplete: string | undefined
  if (earlier?.status === 'running') {
    // The new week's run replaces one that never finished. Mark it in R2 and say so in the next manifest.
    const rowsWritten = earlier.tables.reduce((sum, t) => sum + t.rows, 0)
    await env.BACKUPS.put(`${earlier.prefix}/incomplete.json`, JSON.stringify({ abandonedAt: new Date(scheduledTime).toISOString(), rowsWritten }))
    ops += 1
    previousIncomplete = earlier.prefix
    logEvent('backup.abandoned', { count: rowsWritten })
  }
  const { tables, skipped } = await readSchema(env.DB)
  const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>().catch(() => ({ results: [] }))
  ops += 2 // the schema and the applied migrations
  logEvent('backup.started', { count: tables.length })
  if (skipped.length) logEvent('backup.tables_skipped', { count: skipped.length })
  const state: RunState = {
    status: 'running',
    prefix,
    createdAt: new Date(scheduledTime).toISOString(),
    migrations: applied.results.map((m) => m.name),
    tables,
    skipped,
    previousIncomplete,
    tableIndex: 0,
    after: 0,
  }
  await advance(env, state, ops, WEEKLY_OPS, false)
}

/** Any other cron: carries on an unfinished run. Costs one R2 read when there is nothing to do. */
export async function continueBackup(env: Env): Promise<void> {
  const state = await readState(env)
  if (state?.status !== 'running') return
  await advance(env, state, 1, CONTINUE_OPS, true)
}
