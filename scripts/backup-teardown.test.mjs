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
  assert.match(r.out, /Dry run only/)
  assert.deepEqual(account.calls(), [], 'a dry run makes no Wrangler call at all')
  assert.ok(!existsSync(join(account.dir, 'export')))
})

test('teardown exports a verified backup, then deletes the database only after the database name is typed', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 1, 'the bucket still holds backups, which Wrangler cannot list, so the teardown is not finished')
  assert.deepEqual(account.state().databases, [])
  const exported = readdirSync(join(account.dir, 'export'))
  assert.ok(exported.includes('manifest.json'))
  const settings = exported.find((f) => f.startsWith('settings.') && f.endsWith('.ndjson'))
  assert.match(readFileSync(join(account.dir, 'export', settings), 'utf8'), /Fern's money/)
  const order = account.order()
  assert.ok(lastIndex(order, 'r2 object') < index(order, 'd1 delete'), 'the export is finished before anything is deleted')
  assert.match(r.out, /Fern's money|final export/i)
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

test('teardown deletes nothing when the export fails', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n', [], { FAKE_FAIL: 'r2 object put' })

  assert.equal(r.status, 1)
  assert.match(r.out, /Nothing was deleted/)
  assert.deepEqual(account.state().databases, ['fernledger'])
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
})

test('teardown deletes nothing when the downloaded export fails its checksum', () => {
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

test('teardown with a non-empty bucket tells the Deployer how to empty and delete it', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n')

  assert.deepEqual(account.state().buckets, ['fernledger-backups'])
  assert.match(r.out, /R2/)
  assert.match(r.out, /empty/i)
  assert.match(r.out, /r2 bucket delete fernledger-backups/)
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

test('teardown refuses an export folder that already holds files', () => {
  const account = fakeAccount()
  mkdirSync(join(account.dir, 'export'))
  writeFileSync(join(account.dir, 'export', 'old.txt'), 'x')

  const r = teardown(account, 'fernledger\n')

  assert.equal(r.status, 1)
  assert.match(r.out, /not empty|already/i)
  assert.deepEqual(account.state().databases, ['fernledger'])
})

test('teardown revokes the Akahu token by instructions only, and only if Akahu Sync was used (ADR 0008)', () => {
  const account = fakeAccount()

  const r = teardown(account, 'fernledger\n')

  assert.match(r.out, /If you used Akahu Sync/)
  assert.match(r.out, /revoke/i)
  assert.ok(!account.calls().some((c) => c.args.join(' ').toLowerCase().includes('akahu')), 'no command touches Akahu')
})

test('teardown needs the account confirmed, and fails closed without a terminal or --yes', () => {
  const account = fakeAccount()

  const r = run('teardown.mjs', ['--out', join(account.dir, 'export')], account.env, 'fernledger\n')

  assert.equal(r.status, 1)
  assert.match(r.out, /--yes/)
  assert.deepEqual(account.state().databases, ['fernledger'])
})
