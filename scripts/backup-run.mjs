// Takes a complete backup on demand, for `npm run deploy` (before migrations) and `npm run teardown` (the final export).
//
// The Worker can't be asked for a backup: it starts one only from its weekly cron, and its /api is behind
// Cloudflare Access. So this runs the Worker's own backup code (worker/backup.ts) here, and gives it a D1 and an
// R2 that talk to your account through Wrangler. The format, the cursor and the manifest are exactly the cron's,
// so the Worker's other crons carry on the same run and scripts/restore.mjs reads it like any other backup.
// Nothing here knows how a backup is laid out; it only hands the code its database and bucket and waits.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackupFormatError, checkPart, parseManifest } from '../worker/backup-format.ts'
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

/** Does the database hold any table of its own? False on a first deploy, when there is nothing to lose. undefined in a dry run. */
export function databaseHasTables(runner, database) {
  const result = runner.json(
    [
      'd1', 'execute', database, '--remote', '--json', '--command',
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'",
    ],
    { note: 'looks for tables to back up' },
  )
  if (!result) return undefined
  const n = result[0]?.results?.[0]?.n
  if (typeof n !== 'number') throw new ScriptError(`Could not tell whether D1 database "${database}" has any tables.`)
  return n > 0
}

/**
 * Backs the database up to the bucket with the Worker's backup code and waits until the manifest is written.
 * Resumes an unfinished run of the same NZ date, and leaves a finished backup of that date alone (a backup of
 * today already exists, so it isn't repeated). Throws a ScriptError if it can't finish.
 * Returns { prefix, manifest, existed }.
 */
export async function takeBackup(runner, { database, bucket, log = console.log, now = Date.now }) {
  const work = mkdtempSync(join(tmpdir(), 'fernledger-backup-')) // holds copies of your data until the end
  try {
    const env = remoteEnv(runner, { database, bucket }, work)
    const prefix = backupPrefix(now())
    const manifestKey = `${prefix}/manifest.json`
    const existed = Boolean(await env.BACKUPS.head(manifestKey))
    if (existed) {
      log(`A complete backup for ${prefix.slice('backups/'.length)} already exists in the bucket, so it is used as it is.`)
    } else {
      log(`Backing up "${database}" to the R2 bucket "${bucket}" (${prefix}) with the Worker's backup code. This can take a few minutes.`)
      await startBackup(env, now())
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
        const file = join(outDir, part.key.slice(prefix.length + 1))
        get(part.key, file)
        await checkPart(part, readFileSync(file))
        parts++
      }
    }
    log(`Downloaded the manifest and ${parts} parts, and checked each against the manifest.`)
    return manifest
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true }) // an export that didn't verify is not one to keep
    if (e instanceof BackupFormatError) throw new ScriptError(e.message)
    throw e
  }
}
