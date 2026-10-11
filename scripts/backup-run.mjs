// Takes a complete backup on demand, for `npm run deploy` (before migrations) and `npm run teardown` (the final backup).
//
// The Worker can't be asked for a backup: it starts one only from its weekly cron, and its /api is behind
// Cloudflare Access. So this runs the Worker's own backup code (worker/backup.ts) here, and gives it a D1 and an
// R2 that talk to your account through Wrangler. The format, the cursor and the manifest are exactly the cron's,
// so the Worker's other crons carry on the same run and scripts/restore.mjs reads it like any other backup.
// Nothing here knows how a backup is laid out; it only hands the code its database and bucket and waits.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { BackupFormatError, checkPart, parseManifest, quote } from '../worker/backup-format.ts'
import { backupPrefix, continueBackup, startBackup } from '../worker/backup.ts'
import { ScriptError } from './wrangler-cli.mjs'

// One round is one Worker invocation's worth (about 1 MB). The weekly cron's limit of 15 MB means 15 or so rounds.
const MAX_ROUNDS = 400

// Wrangler's message when an R2 object isn't there (code 10007). Anything else is a real failure, never "no such backup".
const noSuchObject = (r) => /10007|specified key does not exist/i.test(r.stdout + r.stderr)

// The few D1 and R2 methods worker/backup.ts uses, over Wrangler. Values bound to a query are whole numbers only,
// so they are written into the SQL (Wrangler has no way to bind parameters).
function remoteEnv(runner, { database, bucket }, work) {
  let n = 0
  const rows = (sql) => {
    const result = runner.json(['d1', 'execute', database, '--remote', '--json', '--command', sql], { quiet: true })
    return Array.isArray(result) ? (result[0]?.results ?? []) : []
  }
  const prepare = (sql) => {
    const make = (params) => ({
      bind: (...more) => make(more),
      all: async () => ({ results: rows(bind(sql, params)) }),
      first: async () => rows(bind(sql, params))[0] ?? null,
    })
    return make([])
  }
  const bind = (sql, params) =>
    sql.replace(/\?(\d+)/g, (_, i) => {
      const value = params[Number(i) - 1]
      if (!Number.isSafeInteger(value)) throw new ScriptError('A backup query was given a value other than a whole number.')
      return String(value)
    })

  const fetchObject = (key) => {
    const file = join(work, `object-${++n}`)
    const r = runner.run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, '--remote'], { allowFailure: true, quiet: true })
    if (r.status === 0) return file
    if (noSuchObject(r)) return null
    throw new ScriptError(`Could not read ${key} from the R2 bucket "${bucket}" (exit ${r.status}).`)
  }
  return {
    DB: { prepare },
    BACKUPS: {
      async get(key) {
        const file = fetchObject(key)
        return file ? { text: async () => readFileSync(file, 'utf8') } : null
      },
      async head(key) {
        return fetchObject(key) ? {} : null
      },
      async put(key, value, options) {
        const file = join(work, `object-${++n}`)
        writeFileSync(file, value)
        const type = options?.httpMetadata?.contentType
        runner.run(['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, ...(type ? ['--content-type', type] : []), '--remote'], { quiet: true })
      },
    },
  }
}

// The tables the backup looks at: the ones worker/backup.ts reads, plus those it skips.
const OWN_TABLES = "type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'"

const queryRows = (runner, database, sql) => {
  const result = runner.json(['d1', 'execute', database, '--remote', '--json', '--command', sql], { quiet: true })
  return Array.isArray(result) ? (result[0]?.results ?? []) : []
}

/** Does the database hold any table of its own? False on a first deploy, when there is nothing to lose. undefined in a dry run. */
export function databaseHasTables(runner, database) {
  const result = runner.json(['d1', 'execute', database, '--remote', '--json', '--command', `SELECT count(*) AS n FROM sqlite_master WHERE ${OWN_TABLES}`], {
    note: 'looks for tables to back up',
  })
  if (!result) return undefined
  const n = result[0]?.results?.[0]?.n
  if (typeof n !== 'number') throw new ScriptError(`Could not tell whether D1 database "${database}" has any tables.`)
  return n > 0
}

/** A folder of its own for one final backup, so it can't be an older backup that happens to share the NZ date. */
export const finalBackupPrefix = (at) => `${backupPrefix(at)}-final-${new Date(at).toISOString().replace(/[-:.]/g, '')}`

/**
 * Backs the database up to the bucket with the Worker's backup code and waits until the manifest is written.
 * By default it resumes an unfinished run of the same NZ date and leaves a finished backup of that date alone
 * (a backup of today already exists, so it isn't repeated). That suits a deploy, where the restore point covers
 * anything written since. With `fresh` it always takes a new backup in a folder of its own, which the
 * teardown needs: it deletes the database, and an older backup would miss later writes.
 * Throws a ScriptError if it can't finish. Returns { prefix, manifest, existed }.
 */
export async function takeBackup(runner, { database, bucket, fresh = false, log = console.log, now = Date.now }) {
  const work = mkdtempSync(join(tmpdir(), 'fernledger-backup-')) // holds copies of your data until the end
  try {
    const env = remoteEnv(runner, { database, bucket }, work)
    const at = now()
    const prefix = fresh ? finalBackupPrefix(at) : backupPrefix(at)
    const manifestKey = `${prefix}/manifest.json`
    const existed = !fresh && Boolean(await env.BACKUPS.head(manifestKey))
    if (existed) {
      log(`A complete backup for ${prefix.slice('backups/'.length)} already exists in the bucket, so it is used as it is. Rows written since it was taken are not in it; the restore point recorded next covers them.`)
    } else {
      log(`Backing up "${database}" to the R2 bucket "${bucket}" (${prefix}) with the Worker's backup code. This can take a few minutes.`)
      await startBackup(env, at, prefix)
      for (let round = 1; !(await env.BACKUPS.head(manifestKey)); round++) {
        if (round >= MAX_ROUNDS) throw new ScriptError(`The backup did not finish after ${MAX_ROUNDS} rounds.`)
        log(`  still backing up (round ${round})`)
        await continueBackup(env)
      }
    }
    const manifest = parseManifest(await (await env.BACKUPS.get(manifestKey)).text(), prefix)
    const rowCount = manifest.tables.reduce((sum, t) => sum + t.rows, 0)
    log(`Backup ${prefix} is complete: ${rowCount} rows in ${manifest.tables.length} tables.`)
    if (manifest.skipped.length) {
      log(`Not backed up: ${manifest.skipped.map((s) => s.name).join(', ')} (the manifest says why).`)
    }
    return { prefix, manifest, existed }
  } catch (e) {
    if (e instanceof BackupFormatError) throw new ScriptError(e.message)
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Where a part is saved: its key under the backup's folder, inside `outDir`. The manifest came from the bucket, so a
 * key that climbs out (..), is absolute or uses a backslash is refused before any path is built from it.
 */
export function localPath(outDir, prefix, key) {
  const rest = key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : ''
  const segments = rest.split('/')
  if (!rest || rest.includes('\\') || isAbsolute(rest) || segments.some((s) => s === '' || s === '.' || s === '..' || /^[a-zA-Z]:/.test(s))) {
    throw new ScriptError(`Part ${key} is outside the backup, so nothing was downloaded from it.`)
  }
  return join(outDir, ...segments)
}

/**
 * Compares a finished backup with the database as it is now. Returns what differs (empty means the backup holds
 * every row the database holds): a table whose row count isn't the manifest's, or a table the manifest doesn't
 * list at all. Names and counts only, never values.
 */
export function liveDifferences(runner, database, manifest) {
  const problems = []
  if (manifest.tables.length) {
    const literal = (name) => `'${name.replaceAll("'", "''")}'`
    const sql = manifest.tables.map((t) => `SELECT ${literal(t.name)} AS name, count(*) AS n FROM ${quote(t.name)}`).join(' UNION ALL ')
    const live = new Map(queryRows(runner, database, sql).map((r) => [r.name, r.n]))
    for (const t of manifest.tables) {
      if (live.get(t.name) !== t.rows) problems.push(`${t.name} (backup ${t.rows} rows, database ${live.get(t.name) ?? 'unreadable'})`)
    }
  }
  const known = new Set([...manifest.tables, ...manifest.skipped].map((t) => t.name))
  for (const { name } of queryRows(runner, database, `SELECT name FROM sqlite_master WHERE ${OWN_TABLES}`)) {
    if (!known.has(name)) problems.push(`${name} (a table the backup doesn't have)`)
  }
  return problems
}

/**
 * Downloads a finished backup into `outDir` (manifest.json and one file per part, named as in the bucket, minus the
 * date folder) and checks every part against the manifest. Removes the folder again if anything fails to verify.
 */
export async function downloadBackup(runner, { bucket, prefix, outDir, log = console.log }) {
  mkdirSync(outDir, { recursive: true })
  const get = (key, file) => runner.run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, '--remote'], { quiet: true })
  try {
    const manifestFile = join(outDir, 'manifest.json')
    get(`${prefix}/manifest.json`, manifestFile)
    const manifest = parseManifest(readFileSync(manifestFile, 'utf8'), prefix)
    let parts = 0
    for (const table of manifest.tables) {
      for (const part of table.parts) {
        const file = localPath(outDir, prefix, part.key)
        get(part.key, file)
        await checkPart(part, readFileSync(file))
        parts++
      }
    }
    log(`Downloaded the manifest and ${parts} parts, and checked each against the manifest.`)
    return manifest
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true }) // a backup that didn't verify is not one to keep
    if (e instanceof BackupFormatError) throw new ScriptError(e.message)
    throw e
  }
}
