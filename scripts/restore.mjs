// Restores a weekly backup from the R2 bucket into an empty D1 database that already has the schema
// (migrations applied). It downloads and verifies every part against the manifest's checksums before it
// writes anything, refuses a database that already holds rows, and checks the row counts afterwards.
// Usage: node scripts/restore.mjs <backup date, YYYY-MM-DD> [--database NAME] [--local] [--dry-run] [--yes]
//   --database  restore into this D1 database instead of the one in wrangler.jsonc (for a practice run)
//   --local     read and write Wrangler's local dev storage instead of the Cloudflare account
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackupFormatError, checkPart, insertStatements, parseManifest } from '../worker/backup-format.ts'
import { ScriptError, confirmAccount, createRunner, main, readResourceNames } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const local = args.includes('--local')
const flagValue = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const date = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--database')

const quote = (name) => `"${name.replaceAll('"', '""')}"`
// The rows of a `wrangler d1 execute --json` result.
const rowsOf = (result) => (Array.isArray(result) ? (result[0]?.results ?? []) : [])

await main(async () => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ScriptError('Usage: node scripts/restore.mjs <backup date, YYYY-MM-DD> [--database NAME] [--local] [--dry-run] [--yes]')
  }
  const names = readResourceNames()
  const database = flagValue('--database') ?? names.database
  const where = local ? ['--local'] : ['--remote']
  const prefix = `backups/${date}`

  const accountId = local ? undefined : await confirmAccount(createRunner({ dryRun }), { yes: args.includes('--yes') })
  const runner = createRunner({ dryRun, accountId })
  const work = mkdtempSync(join(tmpdir(), 'fernledger-restore-'))
  const download = (key, file) => runner.run(['r2', 'object', 'get', `${names.bucket}/${key}`, '--file', file, ...where], { note: 'downloads from the backup bucket' })
  try {
    const manifestFile = join(work, 'manifest.json')
    download(`${prefix}/manifest.json`, manifestFile)
    if (dryRun) {
      console.log(`\nDry run: a real run would next read the manifest, then for the database "${database}":`)
      console.log('  1. check it has every table in the manifest, and that they are all empty')
      console.log('  2. download every part and verify its size, checksum and row count, before changing anything')
      console.log('  3. load the parts with `wrangler d1 execute --file`, one file per part')
      console.log('  4. count the rows in each table and compare with the manifest')
      console.log('\nDry run only. Nothing was changed.')
      return
    }

    let manifest
    try {
      manifest = parseManifest(readFileSync(manifestFile, 'utf8'))
    } catch (e) {
      if (e instanceof BackupFormatError) throw new ScriptError(`Backup ${date}: ${e.message}`)
      throw new ScriptError(`Backup ${date} has no readable manifest. If it was an unfinished run, use another date.`)
    }
    if (manifest.tables.length === 0) throw new ScriptError(`Backup ${date} lists no tables.`)

    // The target must already have the schema, and be empty: a restore adds rows, it never overwrites any.
    const present = new Set(
      rowsOf(runner.json(['d1', 'execute', database, ...where, '--json', '--command', "SELECT name FROM sqlite_master WHERE type = 'table'"])).map((r) => r.name),
    )
    const missing = manifest.tables.filter((t) => !present.has(t.name)).map((t) => t.name)
    if (missing.length) {
      throw new ScriptError(`Database "${database}" has no table ${missing.join(', ')}. Apply the migrations to it first (the backup was made with: ${manifest.migrations.join(', ') || 'no migrations recorded'}).`)
    }
    const countSql = manifest.tables.map((t) => `SELECT '${t.name.replaceAll("'", "''")}' AS name, count(*) AS n FROM ${quote(t.name)}`).join(' UNION ALL ')
    const counts = () => new Map(rowsOf(runner.json(['d1', 'execute', database, ...where, '--json', '--command', countSql])).map((r) => [r.name, r.n]))
    const notEmpty = [...counts()].filter(([, n]) => n !== 0).map(([name]) => name)
    if (notEmpty.length) {
      throw new ScriptError(`Database "${database}" already has rows in ${notEmpty.join(', ')}. Restore into an empty database; nothing was changed.`)
    }

    // Everything is downloaded and verified first, so a damaged backup stops before the database is touched.
    const files = []
    for (const table of manifest.tables) {
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

    for (const [i, file] of files.entries()) {
      console.log(`Loading part ${i + 1} of ${files.length}`)
      runner.run(['d1', 'execute', database, ...where, '--file', file])
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
