// Weekly backup of every table in the database to R2, as NDJSON under a dated prefix plus a manifest.
//
// Free plan (ADR 0004): an invocation gets 10 ms of CPU and 50 subrequests/D1 queries, so one run can't
// assume it finishes in one invocation. The run is therefore a resumable cursor:
// - D1 builds each NDJSON line (json_object) and joins up to CHUNK_ROWS rows, so the Worker never loops
//   over rows; it hands a string to R2 and hashes it. Reads are keyset pages on rowid, never OFFSET.
// - Each chunk is its own R2 object (a "part"), so no part has to be held open between invocations.
// - An invocation does at most a fixed number of D1 and R2 operations, then saves its cursor to R2.
//   The weekly cron starts a run; the other crons continue an unfinished one (a single get when idle).
// - Nothing here deletes anything: an abandoned run stays in the bucket without a manifest.
import { sha256Hex, type Manifest, type ManifestTable } from './backup-format.ts'
import { logEvent } from './log.ts'

/** Must match the weekly entry in wrangler.jsonc (scripts/wrangler-config.test.mjs checks). */
export const BACKUP_CRON = '0 15 * * SUN'

const CHUNK_ROWS = 1000
/** Kept well under the 2 MB D1 allows in one string, so a run of long Notes can't fail the read. */
const CHUNK_BYTES = 1_000_000
/** D1 queries plus R2 calls per invocation; the limit is 50 of each, and Sync shares the daily crons. */
const WEEKLY_OPS = 40
const CONTINUE_OPS = 20
/** What an invocation keeps back for writing its cursor and, on the last one, the manifest. */
const RESERVED_OPS = 2

const STATE_KEY = 'backups/run-state.json'

type RunState = {
  status: 'running' | 'complete'
  prefix: string
  createdAt: string
  migrations: string[]
  tables: ManifestTable[]
  /** Which table is being read, and the last rowid already written for it. */
  table: number
  after: number
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const nzDate = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(at)

/** Every table the database has now, read from its schema so a new migration needs no change here. */
async function readSchema(db: D1Database): Promise<ManifestTable[]> {
  const { results } = await db
    .prepare(
      `SELECT m.name AS tbl, m.sql AS sql, p.name AS col
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
          AND m.name <> 'd1_migrations'
        ORDER BY m.rowid, p.cid`,
    )
    .all<{ tbl: string; sql: string; col: string }>()
  const tables = new Map<string, ManifestTable>()
  for (const { tbl, sql, col } of results) {
    if (!tables.has(tbl)) tables.set(tbl, { name: tbl, createSql: sql, columns: [], rows: 0, parts: [] })
    tables.get(tbl)!.columns.push(col)
  }
  return [...tables.values()]
}

// A blob has no JSON form, so it is written as {"$blob": hex}.
const cell = (column: string) => `CASE WHEN typeof(${quote(column)}) = 'blob' THEN json_object('$blob', hex(${quote(column)})) ELSE ${quote(column)} END`

/** Reads the next page of a table as one NDJSON string, built by SQLite. Returns no body when the table is done. */
async function readChunk(db: D1Database, table: ManifestTable, after: number) {
  const line = `json_object(${table.columns.map((c) => `'${c.replaceAll("'", "''")}', ${cell(c)}`).join(', ')})`
  const row = await db
    .prepare(
      `SELECT group_concat(line, char(10)) AS body, count(*) AS n, max(r) AS last FROM (
         SELECT r, line FROM (
           SELECT r, line, row_number() OVER (ORDER BY r) AS pos, sum(length(CAST(line AS BLOB)) + 1) OVER (ORDER BY r) AS bytes FROM (
             SELECT rowid AS r, ${line} AS line FROM ${quote(table.name)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2
           )
         ) WHERE pos = 1 OR bytes <= ?3
       )`,
    )
    .bind(after, CHUNK_ROWS, CHUNK_BYTES)
    .first<{ body: string | null; n: number; last: number | null }>()
  return row && row.n > 0 && row.body !== null ? { body: row.body, n: row.n, last: row.last! } : null
}

/** Does as many chunks as the budget allows, then saves the cursor, or the manifest if every table is done. */
async function advance(env: Env, state: RunState, opsUsed: number, budget: number): Promise<void> {
  let ops = opsUsed
  let rowsThisInvocation = 0
  const save = () => env.BACKUPS.put(STATE_KEY, JSON.stringify(state))
  try {
    while (state.table < state.tables.length && ops + 2 <= budget - RESERVED_OPS) {
      const table = state.tables[state.table]!
      const chunk = await readChunk(env.DB, table, state.after)
      ops += 1
      if (!chunk) {
        state.table += 1
        state.after = 0
        continue
      }
      const bytes = new TextEncoder().encode(`${chunk.body}\n`)
      const key = `${state.prefix}/${encodeURIComponent(table.name)}.${String(table.parts.length + 1).padStart(6, '0')}.ndjson`
      await env.BACKUPS.put(key, bytes, { httpMetadata: { contentType: 'application/x-ndjson' } })
      ops += 1
      table.parts.push({ key, rows: chunk.n, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) })
      table.rows += chunk.n
      state.after = chunk.last
      rowsThisInvocation += chunk.n
    }
    if (state.table >= state.tables.length) {
      const manifest: Manifest = { version: 1, createdAt: state.createdAt, prefix: state.prefix, migrations: state.migrations, tables: state.tables }
      await env.BACKUPS.put(`${state.prefix}/manifest.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: 'application/json' } })
      state.status = 'complete'
      logEvent('backup.complete', { count: state.tables.reduce((sum, t) => sum + t.rows, 0) })
    } else {
      logEvent('backup.paused', { count: rowsThisInvocation })
    }
    await save()
  } catch (error) {
    logEvent('backup.failed', { error })
    await save().catch(() => undefined) // keep the chunks already written; the next run resumes after them
    throw error
  }
}

/** The weekly cron: starts a new run under the NZ date of the scheduled time. */
export async function startBackup(env: Env, scheduledTime: number): Promise<void> {
  const tables = await readSchema(env.DB)
  const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>().catch(() => ({ results: [] }))
  logEvent('backup.started', { count: tables.length })
  const state: RunState = {
    status: 'running',
    prefix: `backups/${nzDate(new Date(scheduledTime))}`,
    createdAt: new Date(scheduledTime).toISOString(),
    migrations: applied.results.map((m) => m.name),
    tables,
    table: 0,
    after: 0,
  }
  await advance(env, state, 2, WEEKLY_OPS)
}

/** Any other cron: carries on an unfinished run. Costs one R2 read when there is nothing to do. */
export async function continueBackup(env: Env): Promise<void> {
  const saved = await env.BACKUPS.get(STATE_KEY)
  if (!saved) return
  const state = (await saved.json()) as RunState
  if (state.status !== 'running') return
  await advance(env, state, 1, CONTINUE_OPS)
}
