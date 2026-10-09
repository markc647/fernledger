// Sample databases for the upgrade check (ADR 0009; docs/releasing.md has the procedure).
//
//   node scripts/sample-db.mjs capture vMAJOR.MINOR [--data extra.sql ...]
//
// builds a database from the migrations in migrations/, loads the made-up data in seed/*.sql plus any --data files,
// and writes test/sample-dbs/<name>.sql (a dump, with Wrangler's d1_migrations table so the migrations it already
// holds count as applied) and <name>.json (what the data looked like, and a hash of each migration). Run it on the
// release's own commit. A sample is history: it is never overwritten.
//
// scripts/sample-dbs.test.mjs then loads each sample into a fresh SQLite database, applies every later migration the
// way `wrangler d1 migrations apply` does, and checks that every table, column and row from the snapshot is still there.
// SQLite (node:sqlite) stands in for D1. Nothing here touches Cloudflare.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const SAMPLE_NAME = /^v\d+\.\d+$/
/** The table Wrangler keeps its applied migrations in. A fixed timestamp keeps dumps reproducible. */
const D1_MIGRATIONS = `CREATE TABLE d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`

const migrationFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
/** Line endings are normalised so a checkout with CRLF doesn't look like an edit. */
const hashOf = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
const quote = (name) => `"${name.replaceAll('"', '""')}"`
const userTables = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY rowid")
    .all()
    .map((r) => r.name)

/** Applies one migration file the way Wrangler does: all or nothing, then recorded. */
function applyMigration(db, dir, name) {
  db.exec('BEGIN')
  try {
    db.exec(readFileSync(join(dir, name), 'utf8'))
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-01-01 00:00:00')").run(name)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw new Error(`${name} failed to apply: ${error.message}`)
  }
}

/** A database with every migration in `dir` applied and recorded, then the data files run. */
export function buildDatabase(dir, dataFiles) {
  const db = new DatabaseSync(':memory:')
  db.exec(D1_MIGRATIONS)
  for (const name of migrationFiles(dir)) applyMigration(db, dir, name)
  for (const file of dataFiles) db.exec(readFileSync(file, 'utf8'))
  return db
}

const literal = (value) => {
  if (value === null) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
  return `'${String(value).replaceAll("'", "''")}'`
}
const jsonValue = (value) => (value instanceof Uint8Array ? { $blob: Buffer.from(value).toString('hex') } : typeof value === 'bigint' ? Number(value) : value)

const orderBy = (count) => (count ? ` ORDER BY ${Array.from({ length: count }, (_, i) => i + 1).join(', ')}` : '')
const columnsOf = (db, table) => db.prepare(`SELECT name FROM pragma_table_info(${literal(table)})`).all().map((r) => r.name)
const rowsOf = (db, table, columns) =>
  db.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}${orderBy(columns.length)}`).all()

/** The whole database as SQL: schema in creation order, then each table's rows. Loads with `exec`. */
export function dump(db) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid").all()
  const lines = ['-- A made-up Fernledger sample database (scripts/sample-db.mjs). Bank 99 and example.com data only.']
  lines.push(...schema.map((r) => `${r.sql};`))
  for (const table of [...userTables(db), 'd1_migrations']) {
    const columns = columnsOf(db, table)
    for (const row of rowsOf(db, table, columns)) {
      lines.push(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')});`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** What the data looked like: every table's columns and rows, and a hash of each migration it was built with. */
export function snapshot(db, dir) {
  const tables = {}
  for (const table of userTables(db)) {
    const columns = columnsOf(db, table)
    tables[table] = { columns, rows: rowsOf(db, table, columns).map((row) => columns.map((c) => jsonValue(row[c]))) }
  }
  const migrations = Object.fromEntries(
    db
      .prepare('SELECT name FROM d1_migrations ORDER BY id')
      .all()
      .map(({ name }) => [name, hashOf(readFileSync(join(dir, name), 'utf8'))]),
  )
  return { migrations, tables }
}

/**
 * Loads the sample into a fresh database, applies the migrations in `dir` that it lacks, and compares the result
 * with the snapshot. Returns one line per problem; empty means the upgrade kept everything. Lines name tables,
 * columns and row numbers, not values.
 */
export function verifySample(sql, expected, dir) {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(sql)
    const problems = []
    const files = migrationFiles(dir)
    for (const [name, hash] of Object.entries(expected.migrations)) {
      if (!files.includes(name)) problems.push(`${name} is missing: a migration that a release has applied can't be removed`)
      else if (hashOf(readFileSync(join(dir, name), 'utf8')) !== hash) problems.push(`${name} was edited since this sample was taken: add a new migration instead`)
    }
    if (problems.length) return problems

    const applied = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name))
    for (const name of files.filter((f) => !applied.has(f))) {
      try {
        applyMigration(db, dir, name)
      } catch (error) {
        return [error.message]
      }
    }

    for (const [table, { columns, rows }] of Object.entries(expected.tables)) {
      const present = new Set(db.prepare(`SELECT name FROM pragma_table_info(${literal(table)})`).all().map((r) => r.name))
      if (!present.size) {
        problems.push(`${table}: the table is gone`)
        continue
      }
      const missing = columns.filter((c) => !present.has(c))
      if (missing.length) {
        problems.push(`${table}: column ${missing.join(', ')} is gone`)
        continue
      }
      const now = rowsOf(db, table, columns).map((row) => columns.map((c) => jsonValue(row[c])))
      if (now.length !== rows.length) problems.push(`${table}: had ${rows.length} rows, now ${now.length} rows`)
      else {
        const changed = now.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(rows[i]))
        if (changed >= 0) problems.push(`${table}: row ${changed + 1} differs`)
      }
    }
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') problems.push('the database fails SQLite integrity_check')
    const orphans = db.prepare('PRAGMA foreign_key_check').all().length
    if (orphans) problems.push(`${orphans} rows break a foreign key`)
    return problems
  } finally {
    db.close()
  }
}

/** Writes <outDir>/<name>.sql and .json from the migrations in `migrationsDir` plus the data files. */
export function captureSample({ name, migrationsDir, dataFiles, outDir }) {
  if (!SAMPLE_NAME.test(name)) throw new Error(`Sample name "${name}" should look like vMAJOR.MINOR, such as v0.2`)
  const sqlFile = join(outDir, `${name}.sql`)
  const jsonFile = join(outDir, `${name}.json`)
  if (existsSync(sqlFile) || existsSync(jsonFile)) throw new Error(`${name} already exists: a sample is history and is never overwritten`)
  const db = buildDatabase(migrationsDir, dataFiles)
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(sqlFile, dump(db))
    writeFileSync(jsonFile, `${JSON.stringify(snapshot(db, migrationsDir), null, 2)}\n`)
  } finally {
    db.close()
  }
}

/**
 * Housekeeping for the samples folder: each sample has both files, and from the first release on there is one for
 * the current minor release (package.json's version), so the next upgrade check has it.
 */
export function checkSamples({ samplesDir, version }) {
  const files = existsSync(samplesDir) ? readdirSync(samplesDir) : []
  const problems = []
  const names = new Set(files.map((f) => f.replace(/\.(sql|json)$/, '')))
  for (const name of names) {
    if (!SAMPLE_NAME.test(name)) problems.push(`${name}: sample databases are named vMAJOR.MINOR`)
    for (const ext of ['sql', 'json']) if (!files.includes(`${name}.${ext}`)) problems.push(`${name}.${ext} is missing`)
  }
  const [major, minor] = version.split('.').map(Number)
  if ((major > 0 || minor > 0) && !names.has(`v${major}.${minor}`)) {
    problems.push(`no sample database for ${major}.${minor}: run \`node scripts/sample-db.mjs capture v${major}.${minor}\` on the release commit`)
  }
  return problems
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const [command, name, ...rest] = process.argv.slice(2)
  const dataFiles = []
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== '--data' || !rest[i + 1]) {
      console.error('Usage: node scripts/sample-db.mjs capture vMAJOR.MINOR [--data extra.sql ...]')
      process.exit(2)
    }
    dataFiles.push(resolve(rest[i + 1]))
  }
  if (command !== 'capture' || !name) {
    console.error('Usage: node scripts/sample-db.mjs capture vMAJOR.MINOR [--data extra.sql ...]')
    process.exit(2)
  }
  const seeds = existsSync(join(root, 'seed')) ? readdirSync(join(root, 'seed')).filter((f) => f.endsWith('.sql')).sort() : []
  try {
    captureSample({ name, migrationsDir: join(root, 'migrations'), dataFiles: [...seeds.map((f) => join(root, 'seed', f)), ...dataFiles], outDir: join(root, 'test', 'sample-dbs') })
    console.log(`sample-db: wrote test/sample-dbs/${name}.sql and ${name}.json. Check the data is made up, then commit both.`)
  } catch (error) {
    console.error(`sample-db: ${error.message}`)
    process.exit(1)
  }
}
