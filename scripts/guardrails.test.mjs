// Run with `npm run test:scripts` (Node's built-in runner). These use the real gitleaks binary
// and real git repos in temp dirs, so they need network the first time (the binary is cached).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { assetFor, cacheRoot, verifySha256 } from './gitleaks.mjs'

const configPath = resolve('.gitleaks.toml')
// Assembled at runtime so this file doesn't trip the scanner itself.
const realLookingAccount = ['12', '3456', '7890123', '00'].join('-')

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-scan-'))
  git(dir, 'init', '-q')
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
  return dir
}
function node(script, cwd, ...flags) {
  const r = spawnSync(process.execPath, [resolve(script), ...flags], { cwd, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}
function tempConfig(transform) {
  const file = join(mkdtempSync(join(tmpdir(), 'fernledger-cfg-')), '.gitleaks.toml')
  writeFileSync(file, transform(readFileSync(configPath, 'utf8')))
  return file
}

test('picks the release asset for each supported platform', () => {
  assert.equal(assetFor('win32', 'x64').name, 'gitleaks_8.24.3_windows_x64.zip')
  assert.equal(assetFor('darwin', 'arm64').name, 'gitleaks_8.24.3_darwin_arm64.tar.gz')
  assert.equal(assetFor('linux', 'x64').name, 'gitleaks_8.24.3_linux_x64.tar.gz')
  assert.throws(() => assetFor('freebsd', 'x64'), /unsupported platform/i)
})

test('rejects a download whose SHA-256 differs from the pinned value', () => {
  const bytes = Buffer.from('not a gitleaks archive')
  const good = createHash('sha256').update(bytes).digest('hex')
  verifySha256(bytes, good)
  assert.throws(() => verifySha256(bytes, '0'.repeat(64)), /checksum mismatch/i)
})

test('caches outside the repo, per OS convention', () => {
  assert.match(cacheRoot('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a'), /AppData.Local.fernledger$/)
  assert.match(cacheRoot('darwin', {}, '/Users/a'), /Library.Caches.fernledger$/)
  assert.match(cacheRoot('linux', { XDG_CACHE_HOME: '/x' }, '/home/a'), /^.x.fernledger$/)
  assert.match(cacheRoot('linux', {}, '/home/a'), /home.a.\.cache.fernledger$/)
})

test('scan fails on a real-looking account number in an untracked file, and passes without one', () => {
  const dir = newRepo()
  writeFileSync(join(dir, 'notes.txt'), 'nothing here\n')
  assert.equal(node('scripts/scan.mjs', dir, '--config', configPath).status, 0)
  writeFileSync(join(dir, 'leak.txt'), `account ${realLookingAccount}\n`)
  assert.equal(node('scripts/scan.mjs', dir, '--config', configPath).status, 1)
})

test('scan skips gitignored files (node_modules and the like)', () => {
  const dir = newRepo()
  writeFileSync(join(dir, 'ignored.txt'), `account ${realLookingAccount}\n`)
  assert.equal(node('scripts/scan.mjs', dir, '--config', configPath).status, 0)
})

test('scan --staged looks only at what is staged', () => {
  const dir = newRepo()
  writeFileSync(join(dir, 'leak.txt'), `account ${realLookingAccount}\n`)
  assert.equal(node('scripts/scan.mjs', dir, '--staged', '--config', configPath).status, 0)
  git(dir, 'add', 'leak.txt')
  assert.equal(node('scripts/scan.mjs', dir, '--staged', '--config', configPath).status, 1)
})

test('install-hooks points git at .githooks, and is harmless outside a repo', () => {
  const dir = newRepo()
  assert.equal(node('scripts/install-hooks.mjs', dir).status, 0)
  const configured = spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir, encoding: 'utf8' })
  assert.equal(configured.stdout.trim(), '.githooks')
  assert.equal(node('scripts/install-hooks.mjs', mkdtempSync(join(tmpdir(), 'fernledger-nogit-'))).status, 0)
})

test('self-test passes against the real config', () => {
  assert.equal(node('scripts/scan-selftest.mjs', process.cwd()).status, 0)
})

test('self-test fails when a path allowlist hides test fixtures', () => {
  const weakened = tempConfig((toml) => toml + "\n[allowlist]\npaths = ['''test/fixtures/''']\n")
  const r = node('scripts/scan-selftest.mjs', process.cwd(), '--config', weakened)
  assert.equal(r.status, 1)
  assert.match(r.out, /nz-bank-account-number/)
  assert.match(r.out, /aws-access-token/)
})

test('self-test fails when bank-99 values are no longer allowed', () => {
  const tightened = tempConfig((toml) => toml.replaceAll('99', '77'))
  const r = node('scripts/scan-selftest.mjs', process.cwd(), '--config', tightened)
  assert.equal(r.status, 1)
  assert.match(r.out, /bank-99/)
})
