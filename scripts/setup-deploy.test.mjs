import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { stripJsonComments } from './wrangler-cli.mjs'

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
// The commands a run prints: lines starting "$ ", with any trailing "  # note" removed.
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
const words = args.filter((a) => !a.startsWith('-'))
const cmd = words.slice(0, 2).join(' ')
const key = words.slice(0, 3).join(' ')
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, ci: process.env.CI, account: process.env.CLOUDFLARE_ACCOUNT_ID }) + '\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const out = (v) => console.log(JSON.stringify(v))
// Real Wrangler output can contain the account email or a token, so failures leak one on purpose.
const fail = (msg) => { console.error(msg + ' owner@example.com token=SECRET123'); process.exit(1) }
if ((process.env.FAKE_FAIL || '').split(',').includes(cmd)) fail('simulated failure of ' + cmd)
if (words[0] === 'whoami') out({ loggedIn: true, email: 'owner@example.com', accounts: state.accounts })
else if (cmd === 'd1 list') out(state.databases.map((name) => ({ name, uuid: 'x' })))
else if (cmd === 'd1 create') { state.databases.push(words[2]); save(); console.log('created') }
else if (cmd === 'd1 info') out(state.replication ? { name: words[2], read_replication: { mode: state.replication } } : { name: words[2] })
else if (key === 'r2 bucket info') state.buckets.includes(words[3]) ? out({ name: words[3] }) : fail('The specified bucket does not exist. [code: 10006]')
else if (key === 'r2 bucket create') { state.buckets.push(words[3]); save(); console.log('created') }
else if (key === 'd1 time-travel info') out({ bookmark: state.bookmark })
else if (cmd === 'd1 execute') out([{ results: [{ n: 0 }] }]) // no tables yet: a first deploy, so no backup (scripts/backup-teardown.test.mjs covers the rest)
else if (key === 'd1 migrations apply') console.log('Applied 1 migration')
else if (words[0] === 'deploy') console.log('Deployed fernledger to https://fernledger.example.workers.dev')
else console.log('ok ' + cmd)
`

// Makes a throwaway "Cloudflare account" and returns env for the scripts plus readers for the calls made.
function fakeAccount(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-wrangler-'))
  cleanup.push(dir)
  writeFileSync(join(dir, 'wrangler.cjs'), fakeWrangler)
  const initial = { accounts: [{ name: 'Test Account', id: 'acct-1' }], databases: [], buckets: [], replication: 'disabled', bookmark: '00000085-0000024c-00004c6d-test', ...state }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(initial))
  const calls = () => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return {
    env: { FERNLEDGER_WRANGLER: join(dir, 'wrangler.cjs'), FAKE_DIR: dir },
    calls,
    // The Wrangler subcommands called, in order, e.g. 'd1 migrations apply'. Flags are left out.
    order: () => calls().map((c) => c.args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ')),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
  }
}
const cleanup = []
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })))

// Index of a call in the order, failing the test if the call never happened (so `a < b` can't pass on -1).
function at(order, prefix) {
  const i = order.findIndex((o) => o.startsWith(prefix))
  assert.notEqual(i, -1, `expected a "${prefix}" call, saw: ${order.join(' | ')}`)
  return i
}

// A migrations folder with one file in it, standing in for the repo's migrations/.
function migrationsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-migrations-'))
  cleanup.push(dir)
  writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE t (id INTEGER);\n')
  return dir
}
const ready = { databases: ['fernledger'], buckets: ['fernledger-backups'] }
const bookmark = '00000085-0000024c-00004c6d-test'
const deployArgs = ['--yes', '--workers-dev-registered', '--skip-build']

// ---- stripJsonComments ----

// Runs stripJsonComments in a child process with a timeout, so a regression to an endless loop fails the test instead of hanging it.
function strip(text) {
  const code = `import { stripJsonComments } from './scripts/wrangler-cli.mjs'; process.stdout.write(stripJsonComments(${JSON.stringify(text)}))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 5000 })
  return { status: r.status, signal: r.signal, out: r.stdout, err: r.stderr }
}

test('stripJsonComments drops comments but keeps // and /* inside strings', () => {
  const r = strip('{ // note\n "url": "http://x/*y*/", /* block */ "a": 1 }')
  assert.equal(r.status, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { url: 'http://x/*y*/', a: 1 })
})

test('stripJsonComments rejects an unterminated string instead of looping', () => {
  const r = strip('{ "a": "never ends')
  assert.equal(r.signal, null, 'timed out')
  assert.notEqual(r.status, 0)
  assert.match(r.err, /string that never ends/)
})

test('stripJsonComments rejects an unterminated block comment instead of looping', () => {
  const r = strip('{ "a": 1 } /* never ends')
  assert.equal(r.signal, null, 'timed out')
  assert.notEqual(r.status, 0)
  assert.match(r.err, /comment that never ends/)
})

test('stripJsonComments rejects a string ending in a lone backslash instead of looping', () => {
  const r = strip('{ "a": "x\\')
  assert.equal(r.signal, null, 'timed out')
  assert.notEqual(r.status, 0)
})

// ---- setup ----

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

test('setup talks about a location hint, not a guarantee (ADR 0007)', () => {
  const r = run('setup.mjs', ['--yes'], fakeAccount().env)
  assert.match(r.out, /location hint "oc"/)
  assert.doesNotMatch(r.out, /are in location|stored in|residency/i)
})

test('setup passes the confirmed account to Wrangler, and CI=true so it never prompts or rewrites wrangler.jsonc', () => {
  const account = fakeAccount()
  run('setup.mjs', ['--yes'], account.env)
  assert.notEqual(account.calls().length, 0)
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

test('setup stops when Wrangler is not signed in', () => {
  const account = fakeAccount({ accounts: [] })
  const r = run('setup.mjs', ['--yes'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /not signed in/)
  assert.deepEqual(account.order(), ['whoami'])
})

test('setup stops when whoami itself fails, without echoing Wrangler output', () => {
  const account = fakeAccount()
  const r = run('setup.mjs', ['--yes'], { ...account.env, FAKE_FAIL: 'whoami' })
  assert.equal(r.status, 1)
  assert.match(r.out, /not signed in/)
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
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

test('setup stops when CLOUDFLARE_ACCOUNT_ID is not an account this login reaches', () => {
  const account = fakeAccount()
  const r = run('setup.mjs', ['--yes'], { ...account.env, CLOUDFLARE_ACCOUNT_ID: 'someone-elses' })
  assert.equal(r.status, 1)
  assert.match(r.out, /not one of the accounts/)
  assert.deepEqual(account.order(), ['whoami'])
})

test('setup stops if D1 read replication is on', () => {
  const account = fakeAccount({ ...ready, replication: 'auto' })
  const r = run('setup.mjs', ['--yes'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /read replication is "auto"/)
})

test('setup does not pass when D1 reports no read replication setting, and says what it saw', () => {
  const account = fakeAccount({ ...ready, replication: null })
  const r = run('setup.mjs', ['--yes'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /did not report a read replication setting/)
})

test('setup stops on an R2 error that is not "bucket missing", and leaks no Wrangler output', () => {
  const account = fakeAccount({ databases: ['fernledger'] })
  const r = run('setup.mjs', ['--yes'], { ...account.env, FAKE_FAIL: 'r2 bucket' })
  assert.equal(r.status, 1)
  assert.deepEqual(account.state().buckets, [])
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
})

test('a Wrangler failure is summarised: command and exit code, never its output', () => {
  const account = fakeAccount()
  const r = run('setup.mjs', ['--yes'], { ...account.env, FAKE_FAIL: 'd1 list' })
  assert.equal(r.status, 1)
  assert.match(r.out, /`wrangler d1 list` failed \(exit 1\)/)
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123|simulated/)
})

test('a missing Wrangler binary gives a clear message', () => {
  const r = run('setup.mjs', ['--yes'], { FERNLEDGER_WRANGLER: join(tmpdir(), 'fernledger-no-such-wrangler.js') })
  assert.equal(r.status, 1)
  assert.match(r.out, /Wrangler is not installed. Run `npm install`/)
})

test('setup dry run creates the D1 database and R2 bucket in Oceania by default', () => {
  const r = run('setup.mjs', ['--dry-run'])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(commands(r), [
    'npx wrangler whoami --json',
    'npx wrangler d1 list --json',
    'npx wrangler d1 create fernledger --location oc',
    'npx wrangler r2 bucket info fernledger-backups --json',
    'npx wrangler r2 bucket create fernledger-backups --location oc',
    'npx wrangler d1 info fernledger --json',
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
  const config = JSON.parse(stripJsonComments(wranglerConfig))
  assert.doesNotMatch(JSON.stringify(config), /database_id|preview_database_id|account_id|"id":/)
  assert.doesNotMatch(wranglerConfig, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
})

// ---- deploy ----

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
    'npx wrangler deploy --strict',
  ])
  assert.match(r.out, /CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler d1 time-travel restore fernledger --bookmark=<bookmark>/)
  assert.match(r.out, /CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler rollback/)
})

test('deploy dry run leaves out the migrations step when there are no migrations', () => {
  const r = run('deploy.mjs', ['--dry-run'], { FERNLEDGER_MIGRATIONS_DIR: join(tmpdir(), 'fernledger-no-such-dir') })
  assert.equal(r.status, 0, r.out)
  assert.ok(!commands(r).some((c) => c.includes('migrations apply')))
  assert.ok(commands(r).includes('npx wrangler d1 time-travel info fernledger --json'))
})

test('deploy records the bookmark before migrating, then deploys, then prints the bookmark and rollback', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 0, r.out)
  const order = account.order()
  assert.ok(at(order, 'd1 time-travel info') < at(order, 'd1 migrations apply'))
  assert.ok(at(order, 'd1 migrations apply') < at(order, 'deploy'))
  assert.match(r.out, new RegExp(`Restore point.*${bookmark}`))
})

test('deploy shows what Wrangler reported on success, but never the whoami output', () => {
  const r = run('deploy.mjs', deployArgs, { ...fakeAccount(ready).env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /Applied 1 migration/)
  assert.match(r.out, /https:\/\/fernledger\.example\.workers\.dev/)
  assert.doesNotMatch(r.out, /owner@example\.com/)
})

test('printed rollback commands carry the confirmed account, so they run as printed on a multi-account login', () => {
  const account = fakeAccount({ ...ready, accounts: [{ name: 'A', id: 'acct-a' }, { name: 'B', id: 'acct-b' }] })
  const r = run('deploy.mjs', deployArgs, { ...account.env, CLOUDFLARE_ACCOUNT_ID: 'acct-b', FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`CLOUDFLARE_ACCOUNT_ID=acct-b npx wrangler d1 time-travel restore fernledger --bookmark=${bookmark}`))
  assert.match(r.out, /CLOUDFLARE_ACCOUNT_ID=acct-b npx wrangler rollback/)
  assert.doesNotMatch(r.out, /acct-a/)
})

test('deploy runs wrangler deploy with --strict, so CI mode aborts on conflicts instead of answering yes', () => {
  const account = fakeAccount(ready)
  run('deploy.mjs', deployArgs, { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  const deploy = account.calls().find((c) => c.args[0] === 'deploy')
  assert.ok(deploy, 'no deploy call')
  assert.ok(deploy.args.includes('--strict'))
  assert.equal(deploy.ci, 'true')
})

test('deploy applies no migration and deploys nothing if the restore point cannot be recorded', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), FAKE_FAIL: 'd1 time-travel' })
  assert.equal(r.status, 1)
  const order = account.order()
  at(order, 'd1 time-travel info')
  assert.ok(!order.some((o) => o.startsWith('d1 migrations')))
  assert.ok(!order.some((o) => o.startsWith('deploy')))
})

test('deploy still prints the bookmark and rollback instructions when a migration fails', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), FAKE_FAIL: 'd1 migrations' })
  assert.equal(r.status, 1)
  assert.match(r.out, new RegExp(`--bookmark=${bookmark}`))
  assert.ok(!account.order().some((o) => o.startsWith('deploy')))
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
})

test('deploy still prints the bookmark and rollback instructions when the deploy itself fails', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir(), FAKE_FAIL: 'deploy' })
  assert.equal(r.status, 1)
  assert.match(r.out, new RegExp(`--bookmark=${bookmark}`))
})

test('deploy does not auto-create resources: it stops if setup has not been run', () => {
  const account = fakeAccount()
  const r = run('deploy.mjs', deployArgs, account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /npm run setup/)
  assert.ok(!account.order().some((o) => o.startsWith('deploy')))
  assert.deepEqual(account.state().databases, [])
})

test('deploy stops on an R2 error that is not "bucket missing", and leaks no Wrangler output', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, FAKE_FAIL: 'r2 bucket' })
  assert.equal(r.status, 1)
  assert.doesNotMatch(r.out, /owner@example\.com|SECRET123/)
  assert.match(r.out, /Could not check whether R2 bucket/)
  assert.ok(!account.order().some((o) => o.startsWith('d1 time-travel') || o.startsWith('deploy')))
})

test('deploy stops when Wrangler is not signed in', () => {
  const account = fakeAccount({ ...ready, accounts: [] })
  const r = run('deploy.mjs', deployArgs, account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /not signed in/)
  assert.deepEqual(account.order(), ['whoami'])
})

test('deploy stops when CLOUDFLARE_ACCOUNT_ID is not an account this login reaches', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, CLOUDFLARE_ACCOUNT_ID: 'someone-elses' })
  assert.equal(r.status, 1)
  assert.match(r.out, /not one of the accounts/)
  assert.deepEqual(account.order(), ['whoami'])
})

test('deploy fails closed without --yes when there is no terminal to ask on', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--workers-dev-registered', '--skip-build'], account.env)
  assert.equal(r.status, 1)
  assert.match(r.out, /--yes/)
  assert.ok(!account.order().some((o) => o.startsWith('deploy')))
})

// Wrangler registers a workers.dev subdomain for the account when it has none, and in some environments
// (CI mode, AI coding agents) without asking. The scripts must never let that happen unprompted.
test('deploy will not run, even with --yes, unless the Deployer says the workers.dev subdomain exists', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', ['--yes', '--skip-build'], { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 1)
  assert.match(r.out, /--workers-dev-registered/)
  assert.match(r.out, /https:\/\/dash\.cloudflare\.com\/acct-1\/workers\/subdomain/)
  assert.deepEqual(account.order(), ['whoami'], 'nothing but the account lookup may run')
})

test('deploy proceeds once --workers-dev-registered is given', () => {
  const account = fakeAccount(ready)
  const r = run('deploy.mjs', deployArgs, { ...account.env, FERNLEDGER_MIGRATIONS_DIR: migrationsDir() })
  assert.equal(r.status, 0, r.out)
  at(account.order(), 'deploy')
})

test('deploy dry run says it would stop unless the subdomain is confirmed', () => {
  const r = run('deploy.mjs', ['--dry-run'])
  assert.match(r.out, /workers\.dev subdomain/)
})
