// Run with `npm run test:scripts`. ADR 0009 / spec stories 112 and 113: every earlier minor release's database
// upgrades to the latest, and the data is still there. test/sample-dbs/ holds a made-up database per minor release
// (docs/releasing.md says how to add one). SQLite (node:sqlite) stands in for D1; nothing here touches Cloudflare.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { buildDatabase, captureSample, checkSamples, verifySample } from './sample-db.mjs'

const root = resolve(import.meta.dirname, '..')
const migrationsDir = join(root, 'migrations')
const samplesDir = join(root, 'test', 'sample-dbs')

const cleanup = []
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-samples-'))
  cleanup.push(dir)
  return dir
}
/** A private copy of migrations/ that a test can add to or damage. */
const migrationsCopy = () => {
  const dir = join(tempDir(), 'migrations')
  cpSync(migrationsDir, dir, { recursive: true })
  return dir
}
const sample = (name) => ({
  sql: readFileSync(join(samplesDir, `${name}.sql`), 'utf8'),
  snapshot: JSON.parse(readFileSync(join(samplesDir, `${name}.json`), 'utf8')),
})

const sampleNames = readdirSync(samplesDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.slice(0, -4))

test('there is at least one sample database, and each is a made-up bank 99 database', () => {
  assert.ok(sampleNames.length > 0)
  for (const name of sampleNames) {
    const { sql } = sample(name)
    assert.doesNotMatch(sql, /\b(?!99-)\d{2}-\d{4}-\d{7}-\d{2,3}\b/, `${name}: an account number that is not bank 99`)
    assert.doesNotMatch(sql, /@(?!example\.com)[\w.-]+\.\w+/, `${name}: an email that is not example.com`)
  }
})

for (const name of sampleNames) {
  test(`${name} upgrades to the latest schema with its data intact`, () => {
    const { sql, snapshot } = sample(name)
    assert.deepEqual(verifySample(sql, snapshot, migrationsDir), [])
  })
}

test('a later add-only migration keeps the data: the upgrade applies it and the check passes', () => {
  const dir = migrationsCopy()
  writeFileSync(join(dir, '0999_later.sql'), 'ALTER TABLE accounts ADD COLUMN akahu_account_id TEXT;\nCREATE INDEX accounts_name ON accounts (name);\n')
  const { sql, snapshot } = sample(sampleNames[0])
  assert.deepEqual(verifySample(sql, snapshot, dir), [])
})

test('a migration that loses data fails the check', () => {
  const dir = migrationsCopy()
  writeFileSync(join(dir, '0999_oops.sql'), 'DELETE FROM transactions WHERE amount_cents < 0;\n')
  const { sql, snapshot } = sample(sampleNames[0])
  const problems = verifySample(sql, snapshot, dir)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /transactions: .*rows/)
})

test('a migration that changes a value fails the check', () => {
  const dir = migrationsCopy()
  writeFileSync(join(dir, '0999_oops.sql'), "UPDATE settings SET value = 'changed';\n")
  const { sql, snapshot } = sample(sampleNames[0])
  assert.match(verifySample(sql, snapshot, dir).join('\n'), /settings: row \d+ differs/)
})

test('a migration that removes a column fails the check', () => {
  const dir = migrationsCopy()
  writeFileSync(join(dir, '0999_oops.sql'), 'ALTER TABLE accounts DROP COLUMN name;\n')
  const { sql, snapshot } = sample(sampleNames[0])
  assert.match(verifySample(sql, snapshot, dir).join('\n'), /accounts: .*name/)
})

test('a migration that fails to apply fails the check, naming the file', () => {
  const dir = migrationsCopy()
  writeFileSync(join(dir, '0999_broken.sql'), 'ALTER TABLE no_such_table ADD COLUMN x TEXT;\n')
  const { sql, snapshot } = sample(sampleNames[0])
  assert.match(verifySample(sql, snapshot, dir).join('\n'), /0999_broken\.sql/)
})

test('editing or removing a migration that an earlier release applied fails the check', () => {
  const edited = migrationsCopy()
  const file = join(edited, readdirSync(edited).sort()[0])
  writeFileSync(file, readFileSync(file, 'utf8') + '\n-- a harmless-looking edit\n')
  const { sql, snapshot } = sample(sampleNames[0])
  assert.match(verifySample(sql, snapshot, edited).join('\n'), /edited since/)

  const removed = migrationsCopy()
  rmSync(join(removed, readdirSync(removed).sort()[0]))
  assert.match(verifySample(sql, snapshot, removed).join('\n'), /missing/)
})

test('line endings do not count as an edit to a migration', () => {
  const dir = migrationsCopy()
  for (const f of readdirSync(dir)) writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8').replace(/\r?\n/g, '\r\n'))
  const { sql, snapshot } = sample(sampleNames[0])
  assert.deepEqual(verifySample(sql, snapshot, dir), [])
})

test('a captured sample loads back and matches its own snapshot, including awkward values', () => {
  const data = join(tempDir(), 'data.sql')
  writeFileSync(
    data,
    "INSERT INTO settings (key, value) VALUES ('app_title', 'It''s -- a ''quote''; and a newline:\nline two');\nINSERT INTO change_log (actor, summary, before) VALUES ('admin@example.com', 'Changed', NULL);\n",
  )
  const out = tempDir()
  captureSample({ name: 'v7.3', migrationsDir, dataFiles: [data], outDir: out })

  const captured = { sql: readFileSync(join(out, 'v7.3.sql'), 'utf8'), snapshot: JSON.parse(readFileSync(join(out, 'v7.3.json'), 'utf8')) }
  assert.deepEqual(verifySample(captured.sql, captured.snapshot, migrationsDir), [])
  const db = new DatabaseSync(':memory:')
  db.exec(captured.sql)
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'app_title'").get().value, "It's -- a 'quote'; and a newline:\nline two")
  assert.equal(db.prepare('SELECT count(*) AS n FROM d1_migrations').get().n, readdirSync(migrationsDir).length)
  db.close()
})

test('capture refuses to overwrite a released sample, and refuses a bad name', () => {
  const out = tempDir()
  captureSample({ name: 'v1.2', migrationsDir, dataFiles: [], outDir: out })
  assert.throws(() => captureSample({ name: 'v1.2', migrationsDir, dataFiles: [], outDir: out }), /already exists/)
  assert.throws(() => captureSample({ name: '1.2.3', migrationsDir, dataFiles: [], outDir: out }), /vMAJOR\.MINOR/)
})

test('buildDatabase records every migration the way Wrangler does, so only later ones are pending', () => {
  const db = buildDatabase(migrationsDir, [])
  const names = db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name)
  assert.deepEqual(names, readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort())
  db.close()
})

test('checkSamples wants a sample for the current minor release, and a snapshot beside every sample', () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  captureSample({ name: 'v0.1', migrationsDir, dataFiles: [], outDir: dir })
  assert.deepEqual(checkSamples({ samplesDir: dir, version: '0.0.0' }), [])
  assert.deepEqual(checkSamples({ samplesDir: dir, version: '0.1.4' }), [])
  assert.match(checkSamples({ samplesDir: dir, version: '0.2.0' }).join('\n'), /no sample database for 0\.2.*v0\.2/)
  rmSync(join(dir, 'v0.1.json'))
  assert.match(checkSamples({ samplesDir: dir, version: '0.0.0' }).join('\n'), /v0\.1\.json is missing/)
  assert.ok(existsSync(join(dir, 'v0.1.sql')))
})

test('the repo passes checkSamples at the version in package.json', () => {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(checkSamples({ samplesDir, version }), [])
})
