// The pre-deploy backup and the teardown script, run end to end as subprocesses against a fake Wrangler.
// The fake "account" keeps its D1 databases as SQLite files and its R2 bucket as a folder, so the Worker's own
// backup code (worker/backup.ts, which the scripts run through Wrangler) does real work. Nothing here touches Cloudflare.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { downloadBackup, localPath } from './backup-run.mjs'

const root = resolve(import.meta.dirname, '..')
const cleanup = []
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tempDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `fernledger-test-${label}-`))
  cleanup.push(dir)
  return dir
}

const migrationFiles = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(root, 'migrations', f), 'utf8'))

// A stand-in for Wrangler. Accounts live in state.json, D1 databases are <name>.sqlite, the R2 bucket is bucket/.
// Every call is logged to calls.jsonl. FAKE_FAIL lists commands (two or three words, e.g. "r2 object put") that fail.
const fakeWrangler = `
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const dir = process.env.FAKE_DIR
const stateFile = path.join(dir, 'state.json')
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const args = process.argv.slice(2)
const words = args.filter((a) => !a.startsWith('-'))
const value = (flag) => args[args.indexOf(flag) + 1]
const cmd = words.slice(0, 2).join(' ')
const key = words.slice(0, 3).join(' ')
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, ci: process.env.CI, account: process.env.CLOUDFLARE_ACCOUNT_ID }) + '\\n')
const out = (v) => console.log(JSON.stringify(v))
// Real Wrangler output can contain the account email or a token, so failures leak one on purpose.
const fail = (msg) => { console.error(msg + ' owner@example.com token=SECRET123'); process.exit(1) }
const failing = (process.env.FAKE_FAIL || '').split(',')
if (failing.includes(cmd) || failing.includes(key)) fail('simulated failure of ' + key)
const bucketDir = path.join(dir, 'bucket')
const objectKey = () => words[3].slice(words[3].indexOf('/') + 1)
const hasObjects = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).some((e) => !e.isDirectory() || hasObjects(path.join(d, e.name)))
if (words[0] === 'whoami') out({ loggedIn: true, accounts: state.accounts })
else if (cmd === 'd1 list') out(state.databases.map((name) => ({ name })))
else if (key === 'r2 bucket info') state.buckets.includes(words[3]) ? out({ name: words[3] }) : fail('The specified bucket does not exist. [code: 10006]')
else if (key === 'd1 time-travel info') out({ bookmark: 'bookmark-test' })
else if (key === 'd1 migrations apply') console.log('Applied 1 migration')
else if (words[0] === 'deploy') console.log('Deployed')
else if (cmd === 'd1 execute') {
  const db = new DatabaseSync(path.join(dir, words[2] + '.sqlite'))
  try { out([{ results: db.prepare(value('--command')).all().map((r) => ({ ...r })) }]) } catch (e) { fail('SQL error') }
} else if (key === 'r2 object get') {
  const source = path.join(bucketDir, objectKey())
  if (!fs.existsSync(source)) fail('The specified key does not exist. [code: 10007]')
  fs.copyFileSync(source, value('--file'))
} else if (key === 'r2 object put') {
  const target = path.join(bucketDir, objectKey())
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(value('--file'), target)
} else if (cmd === 'd1 delete') {
  state.databases = state.databases.filter((n) => n !== words[2]); save()
  fs.rmSync(path.join(dir, words[2] + '.sqlite'), { force: true })
} else if (key === 'r2 bucket delete') {
  if (hasObjects(bucketDir)) fail('The bucket you tried to delete (' + words[3] + ') is not empty. [code: 10008]')
  state.buckets = state.buckets.filter((n) => n !== words[3]); save()
} else console.log('ok ' + cmd)
`

// A throwaway Cloudflare account. With data: true its database has the real schema and a few made-up rows.
function fakeAccount({ database = true, bucket = true, data = true, accounts = [{ name: 'Test Account', id: 'acct-1' }] } = {}) {
  const dir = tempDir('backup')
  mkdirSync(join(dir, 'bucket'))
  writeFileSync(join(dir, 'wrangler.cjs'), fakeWrangler)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ accounts, databases: database ? ['fernledger'] : [], buckets: bucket ? ['fernledger-backups'] : [] }))
  if (database) {
    const db = new DatabaseSync(join(dir, 'fernledger.sqlite'))
    if (data) {
      for (const sql of migrationFiles) db.exec(sql)
      db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO d1_migrations (name) VALUES ('0201_settings.sql')")
      db.exec(`INSERT INTO settings (key, value) VALUES ('app_title', 'Fern''s money'), ('about_contact', 'Sam')`)
    }
    db.close() // Windows won't delete a folder holding an open database
  }
  const calls = () => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return {
    dir,
    env: { FERNLEDGER_WRANGLER: join(dir, 'wrangler.cjs'), FAKE_DIR: dir },
    calls,
    // The Wrangler subcommands called, in order, e.g. 'd1 migrations apply'. Flags are left out.
    order: () => calls().map((c) => c.args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ')),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    // Backups in the bucket: date -> manifest.
    backups: () => {
      const base = join(dir, 'bucket', 'backups')
      if (!existsSync(base)) return {}
      return Object.fromEntries(
        readdirSync(base, { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'manifest.json')))
          .map((e) => [e.name, JSON.parse(readFileSync(join(base, e.name, 'manifest.json'), 'utf8'))]),
      )
    },
  }
}

function run(script, args, env, input) {
  const base = { ...process.env }
  delete base.REGION
  delete base.CLOUDFLARE_ACCOUNT_ID
  const r = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', env: { ...base, ...env }, input: input ?? '', timeout: 120_000 })
  return { status: r.status, out: r.stdout + r.stderr }
}

function migrationsDir() {
  const dir = tempDir('migrations')
  writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE t (id INTEGER);\n')
  return dir
}
const deploy = (account, extra = [], env = {}) =>
  run('deploy.mjs', ['--yes', '--workers-dev-registered', '--skip-build', ...extra], { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), ...env })
const index = (order, prefix) => {
  const i = order.findIndex((o) => o.startsWith(prefix))
  assert.notEqual(i, -1, `expected a "${prefix}" call, saw: ${order.join(' | ')}`)
  return i
}
const lastIndex = (order, prefix) => order.map((o) => o.startsWith(prefix)).lastIndexOf(true)

// ---- pre-deploy backup ----

test('deploy takes a complete backup before it applies migrations', () => {
  const account = fakeAccount()

  const r = deploy(account)

  assert.equal(r.status, 0, r.out)
  const dates = Object.keys(account.backups())
  assert.equal(dates.length, 1, 'one complete backup, with a manifest')
  const tables = Object.fromEntries(account.backups()[dates[0]].tables.map((t) => [t.name, t.rows]))
  assert.equal(tables.settings, 2)
  const order = account.order()
  assert.ok(lastIndex(order, 'r2 object put') < index(order, 'd1 migrations apply'), 'every backup write comes before the migrations')
  assert.ok(index(order, 'd1 migrations apply') < index(order, 'deploy'))
  assert.match(r.out, new RegExp(`backups/${dates[0]}`))
})

test('deploy waits for a backup that takes more than one Worker invocation, and every row is in it', () => {
  const account = fakeAccount()
  const db = new DatabaseSync(join(account.dir, 'fernledger.sqlite'))
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15000)
           INSERT INTO change_log (actor, summary) SELECT 'b@example.com', 'Change ' || i || ' ${'x'.repeat(60)}' FROM n`)
  db.close()

  const r = deploy(account)

  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /still backing up \(round 1\)/, 'it took more than one round')
  const manifest = Object.values(account.backups())[0]
  assert.equal(manifest.tables.find((t) => t.name === 'change_log').rows, 15000)
  assert.ok(lastIndex(account.order(), 'r2 object put') < index(account.order(), 'd1 migrations apply'))
})

test('deploy takes the restore point after the backup, so it is the state the migrations start from', () => {
  const account = fakeAccount()
  deploy(account)
  const order = account.order()
  assert.ok(lastIndex(order, 'r2 object put') < index(order, 'd1 time-travel info'))
  assert.ok(index(order, 'd1 time-travel info') < index(order, 'd1 migrations apply'))
})

test('deploy on a first deploy says so, takes no backup, and carries on', () => {
  const account = fakeAccount({ data: false })

  const r = deploy(account)

  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /first deploy/i)
  assert.match(r.out, /nothing to back up/i)
  assert.ok(!account.order().some((o) => o.startsWith('r2 object')))
  assert.deepEqual(account.backups(), {})
  index(account.order(), 'deploy')
})

test('deploy stops before changing anything when the backup fails, and says how to go on', () => {
  const account = fakeAccount()

  const r = deploy(account, [], { FAKE_FAIL: 'r2 object put' })

  assert.equal(r.status, 1)
  assert.match(r.out, /backup/i)
  assert.match(r.out, /Nothing was changed/)
  assert.match(r.out, /run .*deploy.* again/i)
  assert.match(r.out, /--skip-backup/)
  assert.match(r.out, /d1 export/)
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
  const order = account.order()
  assert.ok(!order.some((o) => o.startsWith('d1 migrations') || o.startsWith('deploy') || o.startsWith('d1 time-travel')))
})

test('deploy stops when the backup is unreadable, rather than treating a failed check as "no backup yet"', () => {
  // A failed manifest check that is not "no such object" must not be mistaken for a missing manifest.
  const account = fakeAccount()
  const r = deploy(account, [], { FAKE_FAIL: 'r2 object get' })
  assert.equal(r.status, 1)
  assert.ok(!account.order().some((o) => o.startsWith('d1 migrations') || o.startsWith('deploy')))
  assert.deepEqual(account.backups(), {})
})

test('a second deploy the same day reuses the complete backup instead of taking another', () => {
  const account = fakeAccount()
  deploy(account)
  const puts = account.order().filter((o) => o.startsWith('r2 object put')).length

  const r = deploy(account)

  assert.equal(r.status, 0, r.out)
  assert.equal(account.order().filter((o) => o.startsWith('r2 object put')).length, puts)
  assert.match(r.out, /already/i)
  assert.match(r.out, /written since it was taken are not in it/i, 'it says what reusing means')
  assert.match(r.out, /restore point/i, 'and what covers the gap')
})

test('deploy --skip-backup deploys without one, and says it did', () => {
  const account = fakeAccount()
  const r = deploy(account, ['--skip-backup'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /skipp\w+ the backup/i)
  assert.ok(!account.order().some((o) => o.startsWith('r2 object')))
  index(account.order(), 'd1 migrations apply')
})

test('deploy --dry-run describes the backup and runs nothing', () => {
  const r = run('deploy.mjs', ['--dry-run'], {})
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /backup/i)
  assert.match(r.out, /Dry run only/)
})

// ---- teardown ----

const teardownArgs = (account, extra = []) => ['--yes', '--out', join(account.dir, 'export'), ...extra]
const teardown = (account, input, extra = [], env = {}) => run('teardown.mjs', teardownArgs(account, extra), { ...account.env, ...env }, input)

test('teardown --dry-run prints what it would do and touches nothing', () => {
  const account = fakeAccount()

  const r = run('teardown.mjs', ['--dry-run', '--out', join(account.dir, 'export')], account.env)

  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /\$ npx wrangler d1 delete fernledger/)
  assert.match(r.out, /\$ npx wrangler r2 bucket delete fernledger-backups/)
  assert.match(r.out, /new complete backup/)
  assert.match(r.out, /Dry run only/)
  assert.deepEqual(account.calls(), [], 'a dry run makes no Wrangler call at all')
  assert.ok(!existsSync(join(account.dir, 'export')))
})

test('teardown downloads a verified final backup, then deletes the database only after the database name is typed', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 0, `the bucket step is left to the Deployer and is the expected end, not a failure: ${r.out}`)
  assert.deepEqual(account.state().databases, [])
  const exported = readdirSync(join(account.dir, 'export'))
  assert.ok(exported.includes('manifest.json'))
  const settings = exported.find((f) => f.startsWith('settings.') && f.endsWith('.ndjson'))
  assert.match(readFileSync(join(account.dir, 'export', settings), 'utf8'), /Fern's money/)
  const order = account.order()
  assert.ok(lastIndex(order, 'r2 object') < index(order, 'd1 delete'), 'the export is finished before anything is deleted')
  assert.match(r.out, /final backup/i)
  assert.match(readFileSync(join(account.dir, 'export', 'manifest.json'), 'utf8'), /backups\/\d{4}-\d{2}-\d{2}-final-/, 'the final backup has a folder of its own')
})

test('teardown deletes nothing when what is typed is not the database name', () => {
  for (const typed of ['yes\n', 'Fernledger\n', ' fernledger-backups\n', '']) {
    const account = fakeAccount()

    const r = teardown(account, typed)

    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /Nothing was deleted/)
    assert.deepEqual(account.state().databases, ['fernledger'], `typed ${JSON.stringify(typed)}`)
    assert.deepEqual(account.state().buckets, ['fernledger-backups'])
    assert.ok(!account.order().some((o) => o.startsWith('d1 delete') || o.startsWith('r2 bucket delete')))
    assert.ok(existsSync(join(account.dir, 'export', 'manifest.json')), 'the export was still made')
  }
})

test('teardown under CI=true still needs the typed name: auto-answered Wrangler prompts are not a confirmation', () => {
  for (const typed of ['', 'y\n', 'yes\n']) {
    const account = fakeAccount()

    const r = teardown(account, typed, [], { CI: 'true' })

    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /Nothing was deleted/)
    assert.deepEqual(account.state().databases, ['fernledger'], `typed ${JSON.stringify(typed)}`)
    assert.ok(!account.order().some((o) => o.startsWith('d1 delete') || o.startsWith('r2 bucket delete')))
  }
})

test('teardown deletes nothing when the final backup fails', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n', [], { FAKE_FAIL: 'r2 object put' })

  assert.equal(r.status, 1)
  assert.match(r.out, /Nothing was deleted/)
  assert.deepEqual(account.state().databases, ['fernledger'])
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
})

test('teardown deletes nothing when the downloaded backup fails its checksum', () => {
  const account = fakeAccount()
  // The bucket serves a damaged part: flip the stored bytes after the backup is written but before the download.
  const damaged = `
    const fs = require('node:fs'), path = require('node:path')
    const real = path.join(process.env.FAKE_DIR, 'real-wrangler.cjs')
    const r = require('node:child_process').spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
    const args = process.argv.slice(2)
    if (r.status === 0 && args[0] === 'r2' && args[2] === 'put' && args[3].endsWith('.000001.ndjson')) {
      const target = path.join(process.env.FAKE_DIR, 'bucket', args[3].slice(args[3].indexOf('/') + 1))
      fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('Sam', 'Bob'))
    }
    process.exit(r.status)
  `
  writeFileSync(join(account.dir, 'real-wrangler.cjs'), fakeWrangler)
  writeFileSync(join(account.dir, 'wrangler.cjs'), damaged)

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /checksum|wrong size/)
  assert.match(r.out, /Nothing was deleted/)
  assert.deepEqual(account.state().databases, ['fernledger'])
})

test('teardown deletes the bucket too once it is empty, and finishes cleanly', () => {
  // The state after a first run deleted the database and the Deployer emptied the bucket by hand.
  const account = fakeAccount({ database: false })

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 0, r.out)
  assert.deepEqual(account.state().buckets, [])
  assert.ok(!account.order().some((o) => o.startsWith('r2 object')), 'there is no database to export')
  assert.ok(!existsSync(join(account.dir, 'export')))
})

test('teardown with a non-empty bucket ends with how to empty and delete it, and warns that emptying destroys every backup', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 0, r.out)
  assert.deepEqual(account.state().databases, [])
  assert.deepEqual(account.state().buckets, ['fernledger-backups'])
  assert.match(r.out, /Last step, by hand/)
  assert.match(r.out, /R2/)
  assert.match(r.out, /empty/i)
  assert.match(r.out, /r2 bucket delete fernledger-backups/)
  assert.match(r.out, /destroys every backup/i, 'emptying the bucket loses all of them, not only the final one')
  assert.match(r.out, /Download anything you want to keep first/)
  assert.ok(r.out.lastIndexOf('Last step, by hand') > r.out.lastIndexOf('By hand\n'), 'the bucket step is the last thing printed')
})

test('teardown warns before the typed confirmation that emptying the bucket destroys every backup', () => {
  const account = fakeAccount()

  const r = teardown(account, 'nope\n')

  assert.equal(r.status, 1)
  assert.match(r.out, /destroys every backup in it/i)
})

test('teardown with nothing left says so and exits cleanly', () => {
  const account = fakeAccount({ database: false, bucket: false })
  const r = teardown(account, 'fernledger\n')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /Nothing to tear down/)
})

test('teardown refuses an export folder inside the repo, which is public', () => {
  const account = fakeAccount()

  const r = run('teardown.mjs', ['--yes', '--out', join(root, 'my-export')], account.env, 'fernledger\n')

  assert.equal(r.status, 1)
  assert.match(r.out, /inside the repository|inside this repo/i)
  assert.deepEqual(account.calls(), [])
  assert.ok(!existsSync(join(root, 'my-export')))
})

test('teardown refuses a final backup folder that already holds files', () => {
  const account = fakeAccount()
  mkdirSync(join(account.dir, 'export'))
  writeFileSync(join(account.dir, 'export', 'old.txt'), 'x')

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 1)
  assert.match(r.out, /not empty|already/i)
  assert.deepEqual(account.state().databases, ['fernledger'])
})

test('teardown revokes Akahu access by instructions only, and only if Akahu Sync was used (ADR 0008)', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n')

  assert.match(r.out, /If you used Akahu Sync/)
  assert.match(r.out, /revoke/i)
  // The command words only (`order()`), not the SQL they carry: the backup reads every column of every table, and some columns are named for Akahu.
  assert.ok(!account.order().some((o) => o.toLowerCase().includes('akahu')), 'no command touches Akahu')
})

test('teardown needs the account confirmed, and fails closed without a terminal or --yes', () => {
  const account = fakeAccount()

  const r = run('teardown.mjs', ['--out', join(account.dir, 'export')], account.env, 'fernledger\n')

  assert.equal(r.status, 1)
  assert.match(r.out, /--yes/)
  assert.deepEqual(account.state().databases, ['fernledger'])
})

// ---- teardown: the guards ----

const deletes = (account) => account.order().filter((o) => o.startsWith('d1 delete') || o.startsWith('r2 bucket delete'))
const settingsFile = (account) => readdirSync(join(account.dir, 'export')).find((f) => f.startsWith('settings.') && f.endsWith('.ndjson'))

test('teardown never reuses a backup taken earlier today: the final backup has the rows written since', () => {
  const account = fakeAccount()
  assert.equal(deploy(account).status, 0)
  const [today] = Object.keys(account.backups())
  const db = new DatabaseSync(join(account.dir, 'fernledger.sqlite'))
  db.exec("INSERT INTO settings (key, value) VALUES ('later', 'written after the deploy backup')")
  db.close()
  const puts = () => account.order().filter((o) => o.startsWith('r2 object put')).length
  const before = puts()

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 0, r.out)
  assert.doesNotMatch(r.out, /already exists/, 'it did not reuse the backup of the same date')
  assert.ok(puts() > before, 'it wrote a whole new backup')
  assert.match(readFileSync(join(account.dir, 'export', settingsFile(account)), 'utf8'), /written after the deploy backup/)
  const dates = Object.keys(account.backups())
  assert.equal(dates.length, 2, 'the new backup is in a folder of its own, beside the earlier one')
  assert.ok(dates.includes(today))
  assert.equal(account.backups()[today].tables.find((t) => t.name === 'settings').rows, 2, 'the earlier backup is untouched')
})

test('teardown refuses to delete when the database changed after the backup was taken', () => {
  const account = fakeAccount()
  // A write lands in the database right after the backup's manifest is saved, as a Sync or an Import could.
  const writer = `
    const fs = require('node:fs'), path = require('node:path')
    const real = path.join(process.env.FAKE_DIR, 'real-wrangler.cjs')
    const r = require('node:child_process').spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
    const args = process.argv.slice(2)
    if (r.status === 0 && args[0] === 'r2' && args[2] === 'put' && args[3].endsWith('/manifest.json')) {
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(path.join(process.env.FAKE_DIR, 'fernledger.sqlite'))
      db.exec("INSERT INTO settings (key, value) VALUES ('late', 'secret-late-value')")
      db.close()
    }
    process.exit(r.status)
  `
  writeFileSync(join(account.dir, 'real-wrangler.cjs'), fakeWrangler)
  writeFileSync(join(account.dir, 'wrangler.cjs'), writer)

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /changed while the backup was being taken/)
  assert.match(r.out, /settings \(backup 2 rows, database 3\)/)
  assert.match(r.out, /Nothing was deleted/)
  assert.doesNotMatch(r.out, /secret-late-value/)
  assert.deepEqual(deletes(account), [])
  assert.deepEqual(account.state().databases, ['fernledger'])
  assert.deepEqual(account.state().buckets, ['fernledger-backups'])
})

test('teardown refuses to delete when the database changed while the confirmation was waiting', () => {
  const account = fakeAccount()
  // The row-count check runs once after the backup and once right after the typed name. A write lands between them.
  const writer = `
    const fs = require('node:fs'), path = require('node:path')
    const real = path.join(process.env.FAKE_DIR, 'real-wrangler.cjs')
    const args = process.argv.slice(2)
    if (args[0] === 'd1' && args[1] === 'execute' && args.some((a) => a.includes('UNION ALL'))) {
      const counter = path.join(process.env.FAKE_DIR, 'count-checks')
      const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1
      fs.writeFileSync(counter, String(n))
      if (n === 2) {
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(path.join(process.env.FAKE_DIR, 'fernledger.sqlite'))
        db.exec("INSERT INTO settings (key, value) VALUES ('during-prompt', 'secret-prompt-value')")
        db.close()
      }
    }
    const r = require('node:child_process').spawnSync(process.execPath, [real, ...args], { stdio: 'inherit', env: process.env })
    process.exit(r.status)
  `
  writeFileSync(join(account.dir, 'real-wrangler.cjs'), fakeWrangler)
  writeFileSync(join(account.dir, 'wrangler.cjs'), writer)

  const r = teardown(account, 'fernledger\n')

  assert.equal(readFileSync(join(account.dir, 'count-checks'), 'utf8'), '2', 'the check ran again after the confirmation')
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /changed after the backup was taken/)
  assert.match(r.out, /settings \(backup 2 rows, database 3\)/)
  assert.match(r.out, /Nothing was deleted/)
  assert.doesNotMatch(r.out, /secret-prompt-value/)
  assert.deepEqual(deletes(account), [])
  assert.deepEqual(account.state().databases, ['fernledger'])
  assert.deepEqual(account.state().buckets, ['fernledger-backups'])
})

test('teardown refuses a table the backup could not hold unless its name is typed with the database name', () => {
  for (const [typed, goes] of [['fernledger\n', false], ['yes\n', false], ['fernledger without lookup\n', true]]) {
    const account = fakeAccount()
    const db = new DatabaseSync(join(account.dir, 'fernledger.sqlite'))
    db.exec('CREATE TABLE lookup (code TEXT PRIMARY KEY, label TEXT) WITHOUT ROWID')
    db.close()

    const r = teardown(account, typed)

    assert.deepEqual(account.state().databases, goes ? [] : ['fernledger'], `typed ${JSON.stringify(typed)}: ${r.out}`)
    assert.match(r.out, /NOT in the final backup[^]*lookup/)
    if (goes) assert.equal(r.status, 0, r.out)
    else {
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, /Nothing was deleted/)
      assert.deepEqual(deletes(account), [])
    }
  }
})

test('teardown with a database but no bucket refuses: there is nowhere to put the backup', () => {
  const account = fakeAccount({ bucket: false })

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /no R2 bucket/i)
  assert.match(r.out, /Nothing was deleted/)
  assert.deepEqual(deletes(account), [])
  assert.deepEqual(account.state().databases, ['fernledger'])
  assert.ok(!existsSync(join(account.dir, 'export')))
})

test('teardown of an empty database takes no backup, deletes both, and finishes cleanly', () => {
  const account = fakeAccount({ data: false })

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /no tables/i)
  assert.ok(!account.order().some((o) => o.startsWith('r2 object')), 'nothing was backed up')
  assert.ok(!existsSync(join(account.dir, 'export')))
  assert.deepEqual(account.state().databases, [])
  assert.deepEqual(account.state().buckets, [])
  assert.doesNotMatch(r.out, /Last step, by hand/)
})

test('teardown leaves the bucket alone when deleting the database fails', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n', [], { FAKE_FAIL: 'd1 delete' })

  assert.equal(r.status, 1, r.out)
  assert.ok(!account.order().some((o) => o.startsWith('r2 bucket delete')), 'the bucket holds the backup, so it is not touched')
  assert.deepEqual(account.state().buckets, ['fernledger-backups'])
  assert.match(r.out, /bucket was not touched/)
  assert.match(r.out, /final backup is in/)
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
  assert.ok(existsSync(join(account.dir, 'export', 'manifest.json')))
})

test('teardown reports the database as deleted when the bucket delete fails for another reason', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n', [], { FAKE_FAIL: 'r2 bucket delete' })

  assert.equal(r.status, 1, r.out)
  assert.deepEqual(account.state().databases, [])
  assert.match(r.out, /D1 database "fernledger" is deleted/)
  assert.match(r.out, /r2 bucket delete/)
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
})

test('teardown re-run to finish the bucket needs no backup folder, even if the earlier one is full', () => {
  const account = fakeAccount({ database: false })
  mkdirSync(join(account.dir, 'export'))
  writeFileSync(join(account.dir, 'export', 'manifest.json'), '{}')

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 0, r.out)
  assert.deepEqual(account.state().buckets, [])
  assert.match(r.out, /already gone/)
})

test('teardown --out refuses a value that is another flag', () => {
  const account = fakeAccount()

  const r = run('teardown.mjs', ['--yes', '--out', '--dry-run'], account.env)

  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /--out needs a folder/)
  assert.deepEqual(account.calls(), [])
})

// ---- the downloaded folder ----

test('a part key that climbs out of the backup folder, or is absolute, is refused before a path is built', () => {
  const out = join(tempDir('out'), 'export')
  const prefix = 'backups/2026-10-12'
  assert.equal(localPath(out, prefix, `${prefix}/settings.000001.ndjson`), join(out, 'settings.000001.ndjson'))
  for (const key of [`${prefix}/../escape.ndjson`, `${prefix}/a/../../escape`, `${prefix}/..`, `${prefix}//x`, `${prefix}/./x`, `${prefix}/`, `${prefix}\\..\\x`, `${prefix}/C:/x`, '/etc/passwd', 'backups/2026-10-13/x.ndjson']) {
    assert.throws(() => localPath(out, prefix, key), /outside the backup/, key)
  }
})

test('downloading a backup whose manifest has a part key outside it fetches no part and writes nothing there', async () => {
  const dir = tempDir('doctored')
  const out = join(dir, 'x', 'y', 'export')
  const prefix = 'backups/2026-10-12'
  const manifest = {
    version: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    prefix,
    migrations: [],
    skipped: [],
    tables: [{ name: 't', createSql: '', columns: ['a'], rows: 1, parts: [{ key: `${prefix}/../../escaped.ndjson`, rows: 1, bytes: 2, sha256: 'x' }] }],
  }
  const fetched = []
  const runner = {
    run(args) {
      fetched.push(args[3])
      writeFileSync(args[args.indexOf('--file') + 1], args[3].endsWith('/manifest.json') ? JSON.stringify(manifest) : 'x\n')
    },
  }

  await assert.rejects(downloadBackup(runner, { bucket: 'b', prefix, outDir: out, log: () => {} }), /outside the backup/)

  assert.deepEqual(fetched, [`b/${prefix}/manifest.json`], 'only the manifest was fetched')
  assert.ok(!existsSync(join(dir, 'x', 'escaped.ndjson')) && !existsSync(join(dir, 'escaped.ndjson')))
  assert.ok(!existsSync(out), 'what did not verify is not kept')
})
