// The backup/restore round trip, run entirely on this machine: seed a SQLite database, back it up with the
// Worker's own backup code, restore it with scripts/restore.mjs into a second database, and compare.
// SQLite (node:sqlite) stands in for D1 and a folder for R2; a fake Wrangler connects the script to both.
// Nothing here touches Cloudflare. (worker/backup.test.ts covers the Worker against real local D1 and R2.)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { continueBackup, startBackup } from '../worker/backup.ts'

const root = resolve(import.meta.dirname, '..')
const cleanup = []
const opened = []
after(() => {
  opened.forEach((db) => db.close()) // Windows won't delete a folder holding an open database
  cleanup.forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-restore-'))
  cleanup.push(dir)
  return dir
}

const migrations = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(root, 'migrations', f), 'utf8'))
const extraTable = 'CREATE TABLE odd (id INTEGER PRIMARY KEY, label TEXT, amount_cents INTEGER, ratio REAL, data BLOB)'

function newDatabase(file) {
  const db = new DatabaseSync(file)
  opened.push(db)
  for (const sql of migrations) db.exec(sql)
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)')
  db.exec("INSERT INTO d1_migrations (name) VALUES ('0201_settings.sql'), ('0202_change_log.sql')")
  db.exec(extraTable)
  return db
}

// The few D1 methods the backup uses, on SQLite.
const d1 = (db) => ({
  prepare(sql) {
    const make = (params) => ({
      bind: (...more) => make(more),
      all: async () => ({ results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }),
      first: async () => {
        const row = db.prepare(sql).all(...params)[0]
        return row ? { ...row } : null
      },
    })
    return make([])
  },
})

// R2 as a folder: put and get by key.
const bucket = (dir) => ({
  async put(key, value) {
    const file = join(dir, key)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  },
  async head(key) {
    return existsSync(join(dir, key)) ? { key } : null
  },
  async get(key) {
    try {
      const bytes = readFileSync(join(dir, key))
      return { json: async () => JSON.parse(bytes.toString('utf8')), text: async () => bytes.toString('utf8') }
    } catch {
      return null
    }
  },
})

// Backs up with the Worker's code, as the weekly cron and the following crons would.
async function backUp(db, bucketDir, time) {
  const env = { DB: d1(db), BACKUPS: bucket(bucketDir) }
  await startBackup(env, time)
  for (let i = 0; i < 5; i++) await continueBackup(env)
}

// A stand-in for Wrangler. `r2 object get <bucket>/<key> --file F` copies from the folder; `d1 execute <db>`
// runs --command or --file on <db>.sqlite in the same folder. Every call is logged to calls.jsonl.
const fakeWrangler = `
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const dir = process.env.FAKE_DIR
const args = process.argv.slice(2)
const words = args.filter((a) => !a.startsWith('-'))
const value = (flag) => args[args.indexOf(flag) + 1]
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')
if (words[0] === 'r2') {
  const key = words[3].slice(words[3].indexOf('/') + 1)
  const source = path.join(dir, 'bucket', key)
  if (!fs.existsSync(source)) { console.error('The specified key does not exist.'); process.exit(1) }
  fs.copyFileSync(source, value('--file'))
} else if (words[0] === 'd1') {
  const db = new DatabaseSync(path.join(dir, words[2] + '.sqlite'))
  try {
    if (args.includes('--file')) { db.exec('BEGIN;' + fs.readFileSync(value('--file'), 'utf8') + 'COMMIT;'); console.log(JSON.stringify([{ results: [] }])) }
    else console.log(JSON.stringify([{ results: db.prepare(value('--command')).all().map((r) => ({ ...r })) }]))
  } catch (e) { console.error('SQL error'); process.exit(1) }
} else { console.log('ok') }
`

// Makes a folder holding a backup of a freshly seeded database and an empty, migrated target database.
async function scenario() {
  const dir = tempDir()
  const bucketDir = join(dir, 'bucket')
  const source = newDatabase(join(dir, 'source.sqlite'))
  source.exec(`
    INSERT INTO settings (key, value) VALUES ('app_title', 'Fern''s money'), ('about_contact', 'Sam');
    INSERT INTO change_log (actor, summary, before, after) VALUES ('a@example.com', 'Line one
Line two; DROP TABLE settings; -- "quoted"', '{"a":1}', NULL);
    INSERT INTO odd (label, amount_cents, ratio, data) VALUES ('Tab	here', -12345, 0.25, x'00ff10'), (NULL, 0, NULL, NULL), ('', 9, 1.5, x'');
    CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    INSERT INTO pairs VALUES ('x', 'y');
  `)
  // Enough change_log rows to need several parts, so the restore handles a table split over files.
  source.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
               INSERT INTO change_log (actor, summary) SELECT 'b@example.com', 'Change ' || i FROM n`)
  await backUp(source, bucketDir, Date.parse('2026-10-11T15:00:00Z')) // Monday 12 Oct in NZ
  writeFileSync(join(dir, 'fake-wrangler.cjs'), fakeWrangler)
  const target = newDatabase(join(dir, 'target.sqlite'))
  return { dir, bucketDir, source, target }
}

function restore(s, args = ['2026-10-12', '--database', 'target', '--local']) {
  const base = { ...process.env }
  delete base.CLOUDFLARE_ACCOUNT_ID
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/restore.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...base, FERNLEDGER_WRANGLER: join(s.dir, 'fake-wrangler.cjs'), FAKE_DIR: s.dir },
  })
  const out = r.stdout + r.stderr
  let calls = []
  try {
    calls = readFileSync(join(s.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  } catch {
    // No calls were made.
  }
  return { status: r.status, out, calls, loads: calls.filter((c) => c.includes('--file') && c[0] === 'd1') }
}

const dump = (db) =>
  Object.fromEntries(
    ['settings', 'change_log', 'odd'].map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map((r) => ({ ...r }))]),
  )

test('seed, back up, restore, compare: the restored database holds exactly what was backed up', async () => {
  const s = await scenario()

  const r = restore(s)

  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /Restored 2506 rows in \d+ tables/)
  assert.deepEqual(dump(s.target), dump(s.source))
  assert.equal(dump(s.target).change_log.length, 2501)
  assert.ok(r.loads.length > 3, 'change_log should have needed more than one part')
})

test('restore --dry-run downloads and verifies the backup, prints the loads it would run, and writes nothing', async () => {
  const s = await scenario()

  const r = restore(s, ['2026-10-12', '--database', 'target', '--local', '--dry-run'])

  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /\$ npx wrangler r2 object get fernledger-backups\/backups\/2026-10-12\/manifest\.json/)
  assert.match(r.out, /Verified 5 parts/)
  assert.match(r.out, /\$ npx wrangler d1 execute target --local --file /)
  assert.match(r.out, /Dry run only/)
  assert.ok(r.calls.some((c) => c[0] === 'r2'), 'a dry run downloads')
  assert.deepEqual(r.loads, [], 'but loads nothing')
  assert.equal(dump(s.target).settings.length, 0)
})

test('restore --dry-run still refuses a damaged part', async () => {
  const s = await scenario()
  const partFile = join(s.bucketDir, 'backups/2026-10-12/settings.000001.ndjson')
  writeFileSync(partFile, readFileSync(partFile, 'utf8').replace('Sam', 'Max'))

  const r = restore(s, ['2026-10-12', '--database', 'target', '--local', '--dry-run'])

  assert.equal(r.status, 1)
  assert.match(r.out, /fails its checksum/)
})

test('restore says which tables the backup did not copy', async () => {
  const s = await scenario()

  const r = restore(s)

  assert.match(r.out, /Not backed up, so not restored: pairs/)
})

test('restore refuses a database whose table lacks a column the backup has, and changes nothing', async () => {
  const s = await scenario()
  s.target.exec('DROP TABLE odd; CREATE TABLE odd (id INTEGER PRIMARY KEY, label TEXT)')

  const r = restore(s)

  assert.equal(r.status, 1)
  assert.match(r.out, /lacks odd\.amount_cents, odd\.ratio, odd\.data/)
  assert.deepEqual(r.loads, [])
})

test('restore accepts a database with extra columns (a newer schema)', async () => {
  const s = await scenario()
  s.target.exec('ALTER TABLE odd ADD COLUMN note TEXT')

  const r = restore(s)

  assert.equal(r.status, 0, r.out)
})

test('restore will not fetch a part outside the backup it was asked for', async () => {
  const s = await scenario()
  const file = join(s.bucketDir, 'backups/2026-10-12/manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.tables[0].parts[0].key = 'backups/2026-10-05/settings.000001.ndjson'
  writeFileSync(file, JSON.stringify(manifest))

  const r = restore(s)

  assert.equal(r.status, 1)
  assert.match(r.out, /outside the backup/)
  assert.ok(!r.calls.some((c) => c.join(' ').includes('2026-10-05')))
  assert.deepEqual(r.loads, [])
})

test('restore refuses another backup\'s manifest copied into place', async () => {
  const s = await scenario()
  mkdirSync(join(s.bucketDir, 'backups/2026-10-19'), { recursive: true })
  writeFileSync(join(s.bucketDir, 'backups/2026-10-19/manifest.json'), readFileSync(join(s.bucketDir, 'backups/2026-10-12/manifest.json')))

  const r = restore(s, ['2026-10-19', '--database', 'target', '--local'])

  assert.equal(r.status, 1)
  assert.match(r.out, /different backup/)
  assert.deepEqual(r.loads, [])
})

test('restore refuses a part whose bytes changed, before writing anything', async () => {
  const s = await scenario()
  const partFile = join(s.bucketDir, 'backups/2026-10-12/settings.000001.ndjson')
  writeFileSync(partFile, readFileSync(partFile, 'utf8').replace('Sam', 'Max'))

  const r = restore(s)

  assert.equal(r.status, 1)
  assert.match(r.out, /settings\.000001\.ndjson fails its checksum/)
  assert.doesNotMatch(r.out, /Max|Sam/)
  assert.deepEqual(r.loads, [])
  assert.equal(dump(s.target).settings.length, 0)
})

test('restore refuses a database that already has rows, and changes nothing', async () => {
  const s = await scenario()
  s.target.exec("INSERT INTO settings (key, value) VALUES ('app_title', 'Existing')")

  const r = restore(s)

  assert.equal(r.status, 1)
  assert.match(r.out, /already has rows in settings/)
  assert.deepEqual(r.loads, [])
  assert.equal(dump(s.target).settings.length, 1)
})

test('restore refuses a database that lacks a table in the backup', async () => {
  const s = await scenario()
  s.target.exec('DROP TABLE odd')

  const r = restore(s)

  assert.equal(r.status, 1)
  assert.match(r.out, /has no table odd/)
  assert.deepEqual(r.loads, [])
})

test('restore refuses a backup with no manifest (an unfinished run)', async () => {
  const s = await scenario()
  rmSync(join(s.bucketDir, 'backups/2026-10-12/manifest.json'))

  const r = restore(s)

  assert.equal(r.status, 1)
  assert.deepEqual(r.loads, [])
})

test('restore needs a date', async () => {
  const s = await scenario()
  const r = restore(s, ['--local'])
  assert.equal(r.status, 1)
  assert.match(r.out, /Usage/)
})

test('restore does not keep the downloaded data around', async () => {
  const s = await scenario()
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('fernledger-restore-'))

  restore(s)

  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith('fernledger-restore-')), before)
})
