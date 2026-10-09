import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const wranglerConfig = readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8')

// Runs a script as a subprocess. REGION is removed from the inherited environment so a Deployer's
// shell can't change what the tests expect.
function run(script, args = [], env = {}) {
  const base = { ...process.env }
  delete base.REGION
  delete base.CLOUDFLARE_ACCOUNT_ID
  const r = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...base, ...env },
  })
  return { status: r.status, out: r.stdout + r.stderr, lines: (r.stdout + r.stderr).split(/\r?\n/) }
}
// The commands a dry run prints: lines starting "$ ", with any trailing "  # note" removed.
const commands = (r) => r.lines.filter((l) => l.startsWith('$ ')).map((l) => l.slice(2).split('  # ')[0])

// A stand-in for Wrangler, so real (non-dry) runs can be tested without touching Cloudflare. It keeps
// "the account" in state.json, logs each call to calls.jsonl, and fails any command listed in FAKE_FAIL.
const fakeWrangler = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.FAKE_DIR
const file = path.join(dir, 'state.json')
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
const cmd = args.slice(0, 2).join(' ')
const key = args.slice(0, 3).join(' ')
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, ci: process.env.CI, account: process.env.CLOUDFLARE_ACCOUNT_ID }) + '\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const out = (v) => console.log(JSON.stringify(v))
const fail = (msg) => { console.error(msg); process.exit(1) }
if ((process.env.FAKE_FAIL || '').split(',').includes(cmd)) fail('simulated failure of ' + cmd)
if (args[0] === 'whoami') out({ loggedIn: true, accounts: state.accounts })
else if (cmd === 'd1 list') out(state.databases.map((name) => ({ name, uuid: 'x' })))
else if (cmd === 'd1 create') { state.databases.push(args[2]); save(); console.log('created') }
else if (cmd === 'd1 info') out({ name: args[2], read_replication: { mode: state.replication } })
else if (key === 'r2 bucket info') state.buckets.includes(args[3]) ? out({ name: args[3] }) : fail('The specified bucket does not exist. [code: 10006]')
else if (key === 'r2 bucket create') { state.buckets.push(args[3]); save(); console.log('created') }
else if (key === 'd1 time-travel info') out({ bookmark: state.bookmark })
else console.log('ok ' + cmd)
`

// Makes a throwaway "Cloudflare account" and returns env for the scripts plus a reader for the calls made.
function fakeAccount(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-wrangler-'))
  cleanup.push(dir)
  writeFileSync(join(dir, 'wrangler.cjs'), fakeWrangler)
  const initial = { accounts: [{ name: 'Test Account', id: 'acct-1' }], databases: [], buckets: [], replication: 'disabled', bookmark: '00000085-0000024c-00004c6d-test', ...state }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(initial))
  return {
    env: { FERNLEDGER_WRANGLER: join(dir, 'wrangler.cjs'), FAKE_DIR: dir },
    calls: () => {
      try {
        return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
  }
}
const cleanup = []
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })))

test('setup creates what is missing, once: a second run creates nothing', () => {
  const account = fakeAccount()
  const first = run('setup.mjs', ['--yes'], account.env)
  assert.equal(first.status, 0, first.out)
  assert.deepEqual(account.state().databases, ['fernledger'])
  assert.deepEqual(account.state().buckets, ['fernledger-backups'])
  const second = run('setup.mjs', ['--yes'], account.env)
  assert.equal(second.status, 0, second.out)
  const creates = account.calls().filter((c) => c.args.includes('create'))
  assert.equal(creates.length, 2)
  assert.match(second.out, /already exists/)
})

test('setup passes the confirmed account to Wrangler, and CI=true so it never prompts or rewrites wrangler.jsonc', () => {
  const account = fakeAccount()
  run('setup.mjs', ['--yes'], account.env)
  for (const call of account.calls()) {
    assert.equal(call.ci, 'true')
    if (call.args[0] !== 'whoami') assert.equal(call.account, 'acct-1')
  }
})

test('setup fails closed without --yes when there is no terminal to ask on', () => {
  const account = fakeAccount()
  const r = run('setup.mjs', [], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /--yes/)
  assert.deepEqual(account.state().databases, [])
})

test('setup refuses to guess between accounts', () => {
  const account = fakeAccount({ accounts: [{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }] })
  const r = run('setup.mjs', ['--yes'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /CLOUDFLARE_ACCOUNT_ID/)
  assert.deepEqual(account.state().databases, [])
  const chosen = run('setup.mjs', ['--yes'], { ...account.env, CLOUDFLARE_ACCOUNT_ID: 'b' })
  assert.equal(chosen.status, 0, chosen.out)
  assert.ok(account.calls().every((c) => c.account === 'b' || c.args[0] === 'whoami'))
})

test('setup stops if D1 read replication is on', () => {
  const account = fakeAccount({ databases: ['fernledger'], buckets: ['fernledger-backups'], replication: 'auto' })
  const r = run('setup.mjs', ['--yes'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /read replication/)
})

test('setup stops on an R2 error that is not "bucket missing"', () => {
  const account = fakeAccount({ databases: ['fernledger'] })
  const r = run('setup.mjs', ['--yes'], { ...account.env, FAKE_FAIL: 'r2 bucket' })
  assert.equal(r.status, 1)
  assert.deepEqual(account.state().buckets, [])
})

// A migrations folder with one file in it, standing in for the repo's migrations/.
function migrationsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-migrations-'))
  cleanup.push(dir)
  writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE t (id INTEGER);\n')
  return dir
}
const ready = { databases: ['fernledger'], buckets: ['fernledger-backups'] }
const bookmark = '00000085-0000024c-00004c6d-test'

test('deploy dry run prints build, restore point, migrations, deploy, then the rollback instructions', () => {
  const r = run('deploy.mjs', ['--dry-run'], { FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(commands(r), [
    'npx wrangler whoami --json',
    'npx wrangler d1 list --json',
    'npx wrangler r2 bucket info fernledger-backups --json',
    'npm run build',
    'npx wrangler d1 time-travel info fernledger --json',
    'npx wrangler d1 migrations apply fernledger --remote',
    'npx wrangler deploy',
  ])
  assert.match(r.out, /wrangler d1 time-travel restore fernledger --bookmark=<bookmark>/)
  assert.match(r.out, /npx wrangler rollback/)
})

test('deploy dry run leaves out the migrations step when there are no migrations', () => {
  const r = run('deploy.mjs', ['--dry-run'], { FERNLEDGER_MIGRATIONS_DIR: join(tmpdir(), 'fernledger-no-such-dir') })
  assert.equal(r.status, 0, r.out)
  assert.ok(!commands(r).some((c) => c.includes('migrations apply')))
  assert.ok(commands(r).includes('npx wrangler d1 time-travel info fernledger --json'))
})

test('deploy records the bookmark before migrating, then deploys, then prints the bookmark and rollback', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--yes', '--skip-build'], { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 0, r.out)
  const order = account.calls().map((c) => c.args.slice(0, 3).join(' '))
  assert.ok(order.indexOf('d1 time-travel info') < order.indexOf('d1 migrations apply'))
  assert.ok(order.indexOf('d1 migrations apply') < order.indexOf('deploy'))
  assert.match(r.out, new RegExp(`Restore point.*${bookmark}`))
  assert.match(r.out, new RegExp(`wrangler d1 time-travel restore fernledger --bookmark=${bookmark}`))
})

test('deploy applies no migration and deploys nothing if the restore point cannot be recorded', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--yes', '--skip-build'], { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), FAKE_FAIL: 'd1 time-travel' })
  assert.equal(r.status, 1)
  const order = account.calls().map((c) => c.args.slice(0, 2).join(' '))
  assert.ok(!order.includes('d1 migrations'))
  assert.ok(!order.includes('deploy'))
})

test('deploy still prints the bookmark and rollback instructions when a migration fails', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--yes', '--skip-build'], { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), FAKE_FAIL: 'd1 migrations' })
  assert.equal(r.status, 1)
  assert.match(r.out, new RegExp(`--bookmark=${bookmark}`))
  assert.ok(!account.calls().some((c) => c.args[0] === 'deploy'))
})

test('deploy still prints the bookmark and rollback instructions when the deploy itself fails', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--yes', '--skip-build'], { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), FAKE_FAIL: 'deploy' })
  assert.equal(r.status, 1)
  assert.match(r.out, new RegExp(`--bookmark=${bookmark}`))
})

test('deploy does not auto-create resources: it stops if setup has not been run', () => {
  const account = fakeAccount()
  const r = run('deploy.mjs', ['--yes', '--skip-build'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /npm run setup/)
  assert.ok(!account.calls().some((c) => c.args[0] === 'deploy'))
  assert.deepEqual(account.state().databases, [])
})

test('deploy fails closed without --yes when there is no terminal to ask on', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--skip-build'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /--yes/)
  assert.ok(!account.calls().some((c) => c.args[0] === 'deploy'))
})

test('setup dry run creates the D1 database and R2 bucket in Oceania by default', () => {
  const r = run('setup.mjs', ['--dry-run'])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(commands(r), [
    'npx wrangler whoami --json',
    'npx wrangler d1 list --json',
    'npx wrangler d1 create fernledger --location oc',
    'npx wrangler d1 info fernledger --json',
    'npx wrangler r2 bucket info fernledger-backups --json',
    'npx wrangler r2 bucket create fernledger-backups --location oc',
  ])
})

test('setup dry run honours REGION', () => {
  const r = run('setup.mjs', ['--dry-run'], { REGION: 'apac' })
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(
    commands(r).filter((c) => c.includes('create')),
    ['npx wrangler d1 create fernledger --location apac', 'npx wrangler r2 bucket create fernledger-backups --location apac'],
  )
})

test('setup rejects a REGION Wrangler does not accept, and runs nothing', () => {
  const r = run('setup.mjs', ['--dry-run'], { REGION: 'oc; rm -rf /' })
  assert.equal(r.status, 1)
  assert.match(r.out, /REGION must be one of/)
  assert.deepEqual(commands(r), [])
})

test('wrangler.jsonc names the resources but carries no Cloudflare IDs', () => {
  assert.match(wranglerConfig, /"database_name": "fernledger"/)
  assert.doesNotMatch(wranglerConfig, /database_id|preview_database_id|account_id|"id":/)
  assert.doesNotMatch(wranglerConfig, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
})

test('wrangler.jsonc does not enable D1 read replication', () => {
  assert.doesNotMatch(wranglerConfig, /read_replication/)
})
