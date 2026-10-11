// Restores a weekly backup from the R2 bucket into an empty D1 database that already has the schema
// (migrations applied). It downloads and verifies every part against the manifest's checksums before it
// writes anything, refuses a database that already holds rows or lacks a backed-up column, and checks the
// row counts afterwards.
// Usage: node scripts/restore.mjs <backup date, YYYY-MM-DD, or a final backup folder, YYYY-MM-DD-final-<time>> [--database NAME] [--local] [--dry-run] [--yes]
//   --database  restore into this D1 database instead of the one in wrangler.jsonc (for a practice run)
//   --local     read and write Wrangler's local dev storage instead of the Cloudflare account
//   --dry-run   does everything except load the database: downloads the backup (read-only), verifies it,
//               checks the target, and prints the load commands it would run
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackupFormatError, checkPart, insertStatements, loadOrder, parseManifest, quote } from '../worker/backup-format.ts'
import { ScriptError, confirmAccount, createRunner, main, readResourceNames } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const local = args.includes('--local')
const flagValue = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const date = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--database')

// A backup folder name under backups/: an NZ date, or a teardown's final backup (backup-run.mjs finalBackupPrefix). Nothing else, so no path separators.
const BACKUP_FOLDER = /^\d{4}-\d{2}-\d{2}(-final-\d{8}T\d{9}Z)?$/

// Tables a migration fills with starter rows (migrations/1101_categories.sql), so a freshly migrated database holds some.
const SEEDED_TABLES = ['categories']

// The rows of a `wrangler d1 execute --json` result.
const rowsOf = (result) => (Array.isArray(result) ? (result[0]?.results ?? []) : [])

await main(async () => {
  if (!date || !BACKUP_FOLDER.test(date)) {
    throw new ScriptError('Usage: node scripts/restore.mjs <backup date, YYYY-MM-DD, or a final backup folder, YYYY-MM-DD-final-<time>> [--database NAME] [--local] [--dry-run] [--yes]')
  }
  const names = readResourceNames()
  const database = flagValue('--database') ?? names.database
  const where = local ? ['--local'] : ['--remote']
  const prefix = `backups/${date}`

  // Even a dry run reads the bucket and the target database, so it needs the account. Only the load is printed, not run.
  const accountId = local ? undefined : await confirmAccount(createRunner({ dryRun: false }), { yes: args.includes('--yes') })
  const reader = createRunner({ dryRun: false, accountId })
  const loader = createRunner({ dryRun, accountId })
  const work = mkdtempSync(join(tmpdir(), 'fernledger-restore-'))
  const download = (key, file) => reader.run(['r2', 'object', 'get', `${names.bucket}/${key}`, '--file', file, ...where], { note: 'downloads from the backup bucket' })
  const query = (sql) => rowsOf(reader.json(['d1', 'execute', database, ...where, '--json', '--command', sql]))
  try {
    const manifestFile = join(work, 'manifest.json')
    download(`${prefix}/manifest.json`, manifestFile)
    let manifest
    try {
      manifest = parseManifest(readFileSync(manifestFile, 'utf8'), prefix)
    } catch (e) {
      if (e instanceof BackupFormatError) throw new ScriptError(`Backup ${date}: ${e.message}`)
      throw e
    }
    if (manifest.tables.length === 0) throw new ScriptError(`Backup ${date} lists no tables.`)
    if (manifest.skipped.length) {
      console.log(`Not backed up, so not restored: ${manifest.skipped.map((s) => s.name).join(', ')} (the manifest says why).`)
    }
    if (manifest.previousIncomplete) console.log(`Note: the run before this one (${manifest.previousIncomplete}) never finished.`)

    // The target must already have the schema, and be empty: a restore adds rows, it never overwrites any.
    const columns = new Map()
    for (const { tbl, col } of query("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'")) {
      if (!columns.has(tbl)) columns.set(tbl, new Set())
      columns.get(tbl).add(col)
    }
    const missing = manifest.tables.filter((t) => !columns.has(t.name)).map((t) => t.name)
    if (missing.length) {
      throw new ScriptError(`Database "${database}" has no table ${missing.join(', ')}. Apply the migrations to it first (the backup was made with: ${manifest.migrations.join(', ') || 'no migrations recorded'}).`)
    }
    // A newer schema may have extra columns (migrations only add). A column the backup has and the target lacks would lose data.
    const lacking = manifest.tables.flatMap((t) => t.columns.filter((c) => !columns.get(t.name).has(c)).map((c) => `${t.name}.${c}`))
    if (lacking.length) throw new ScriptError(`Database "${database}" lacks ${lacking.join(', ')}, which the backup has. It is on an older schema: apply the migrations first.`)
    const countSql = manifest.tables.map((t) => `SELECT '${t.name.replaceAll("'", "''")}' AS name, count(*) AS n FROM ${quote(t.name)}`).join(' UNION ALL ')
    const counts = () => new Map(query(countSql).map((r) => [r.name, r.n]))
    // A migration may seed a table (the starter Categories), so a freshly migrated database isn't quite empty. If every other
    // table is empty, nothing the Admin did can be in the seeded ones (any Admin change leaves a Change Log row), so they hold
    // only the seed and the restore replaces them with the backup's own rows. A backup that predates the seeded table leaves
    // the seed alone. Deleting seed rows can't break a foreign key: a table that refers to them must be empty too, even when
    // the backup doesn't include it.
    const references = query("SELECT m.name AS tbl, f.\"table\" AS ref FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'").map((r) => [r.tbl, r.ref])
    const notEmpty = [...counts()].filter(([name, n]) => n !== 0 && !SEEDED_TABLES.includes(name)).map(([name]) => name)
    const clearSeeded = manifest.tables.filter((t) => SEEDED_TABLES.includes(t.name) && counts().get(t.name) !== 0).map((t) => t.name)
    const referrers = new Set(references.filter(([table, ref]) => table !== ref && clearSeeded.includes(ref)).map(([table]) => table))
    for (const table of referrers) {
      if (!notEmpty.includes(table) && query(`SELECT 1 AS found FROM ${quote(table)} LIMIT 1`).length) notEmpty.push(table)
    }
    if (notEmpty.length) {
      throw new ScriptError(`Database "${database}" already has rows in ${notEmpty.join(', ')}. Restore into an empty database; nothing was changed.`)
    }

    // Tables load in foreign-key order, read from the target (which enforces the keys), not in the backup's table order:
    // sqlite_master lists tables in the order they were created, and a later migration can add a table that an earlier one
    // refers to (transactions.override_category -> categories). Doing it here also covers backups made before this existed.
    let loadTables
    try {
      loadTables = loadOrder(manifest.tables, references)
    } catch (e) {
      if (e instanceof BackupFormatError) throw new ScriptError(`${e.message} Nothing was changed.`)
      throw e
    }

    // Everything is downloaded and verified first, so a damaged backup stops before the database is touched.
    const files = []
    for (const table of loadTables) {
      for (const part of table.parts) {
        const partFile = join(work, `part-${files.length + 1}.ndjson`)
        download(part.key, partFile)
        try {
          const bytes = readFileSync(partFile)
          await checkPart(part, bytes)
          const sqlFile = join(work, `part-${files.length + 1}.sql`)
          writeFileSync(sqlFile, insertStatements(table, bytes.toString('utf8'), part.key).join('\n') + '\n')
          files.push(sqlFile)
        } catch (e) {
          if (e instanceof BackupFormatError) throw new ScriptError(`${e.message} Nothing was changed.`)
          throw e
        }
      }
    }
    console.log(`Verified ${files.length} parts against the manifest.`)

    if (clearSeeded.length) {
      const clearFile = join(work, 'clear-seeded.sql')
      writeFileSync(clearFile, clearSeeded.map((name) => `DELETE FROM ${quote(name)};`).join('\n') + '\n')
      console.log(`${dryRun ? 'Would clear' : 'Clearing'} the starter rows in ${clearSeeded.join(', ')}, which the backup replaces`)
      loader.run(['d1', 'execute', database, ...where, '--file', clearFile])
    }
    for (const [i, file] of files.entries()) {
      console.log(`${dryRun ? 'Would load' : 'Loading'} part ${i + 1} of ${files.length}`)
      loader.run(['d1', 'execute', database, ...where, '--file', file])
    }
    if (dryRun) {
      console.log('\nDry run only. Nothing was changed.')
      return
    }

    const after = counts()
    const wrong = manifest.tables.filter((t) => after.get(t.name) !== t.rows).map((t) => t.name)
    if (wrong.length) {
      throw new ScriptError(`Restored, but the row counts for ${wrong.join(', ')} don't match the manifest. Empty the database and try again.`)
    }
    console.log(`\nRestored ${manifest.tables.reduce((sum, t) => sum + t.rows, 0)} rows in ${manifest.tables.length} tables into "${database}". Row counts match the manifest.`)
  } finally {
    rmSync(work, { recursive: true, force: true }) // the downloads hold your data
  }
})
