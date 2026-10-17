// Run with `npm run test:scripts` (Node's built-in runner). These use the real gitleaks binary
// and real git repos in temp dirs. The first run downloads gitleaks into your user cache.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { assetFor, binaryName, cacheRoot, configFromArgs, ensureGitleaks, VERSION, verifySha256 } from './gitleaks.mjs'

const configPath = resolve('.gitleaks.toml')
// Assembled at runtime so this file doesn't trip the scanner itself.
const realLookingAccount = ['12', '3456', '7890123', '00'].join('-')

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `fernledger-test-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function newRepo() {
  const dir = tempDir('repo')
  git(dir, 'init', '-q')
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
  return dir
}
function node(script, cwd, args = [], env = {}) {
  const r = spawnSync(process.execPath, [resolve(script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, out: r.stdout + r.stderr }
}
function tempConfig(transform) {
  const file = join(tempDir('cfg'), '.gitleaks.toml')
  writeFileSync(file, transform(readFileSync(configPath, 'utf8')))
  return file
}
function scan(cwd, flags = [], env = {}) {
  return node('scripts/scan.mjs', cwd, ['--config', configPath, ...flags], env)
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
  assert.equal(cacheRoot('linux', { FERNLEDGER_CACHE_DIR: '/override' }, '/home/a'), '/override')
})

test('--config defaults to the repo config and can be overridden', () => {
  assert.equal(configFromArgs([]), resolve('.gitleaks.toml'))
  assert.equal(configFromArgs(['--staged', '--config', 'other.toml']), resolve('other.toml'))
  assert.equal(binaryName('win32'), 'gitleaks.exe')
  assert.equal(binaryName('linux'), 'gitleaks')
})

test('scan fails on a real-looking account number in an untracked file, and passes without one', () => {
  const dir = newRepo()
  writeFileSync(join(dir, 'notes.txt'), 'nothing here\n')
  assert.equal(scan(dir).status, 0)
  writeFileSync(join(dir, 'leak.txt'), `account ${realLookingAccount}\n`)
  assert.equal(scan(dir).status, 1)
})

test('scan reports repo-relative paths', () => {
  const dir = newRepo()
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'leak.txt'), `account ${realLookingAccount}\n`)
  const r = scan(dir)
  assert.match(r.out, /File:\s+sub[\\/]leak\.txt/)
  assert.doesNotMatch(r.out, /fernledger-scan/)
})

test('scan leaves no working-tree copy behind, whether it passes or fails', () => {
  const dir = newRepo()
  const scratch = tempDir('tmp')
  const env = { TEMP: scratch, TMP: scratch, TMPDIR: scratch }
  writeFileSync(join(dir, 'notes.txt'), 'nothing here\n')
  assert.equal(scan(dir, [], env).status, 0)
  assert.deepEqual(readdirSync(scratch), [])
  writeFileSync(join(dir, 'leak.txt'), `account ${realLookingAccount}\n`)
  assert.equal(scan(dir, [], env).status, 1)
  assert.deepEqual(readdirSync(scratch), [])
})

test('scan skips gitignored files (node_modules and the like)', () => {
  const dir = newRepo()
  writeFileSync(join(dir, 'ignored.txt'), `account ${realLookingAccount}\n`)
  assert.equal(scan(dir).status, 0)
})

test('scan --staged looks only at what is staged', () => {
  const dir = newRepo()
  writeFileSync(join(dir, 'leak.txt'), `account ${realLookingAccount}\n`)
  assert.equal(scan(dir, ['--staged']).status, 0)
  git(dir, 'add', 'leak.txt')
  assert.equal(scan(dir, ['--staged']).status, 1)
})

test('a tampered cached binary is replaced by a fresh verified download', async () => {
  const cache = tempDir('cache')
  const seeded = join(cache, 'gitleaks', VERSION)
  cpSync(dirname(await ensureGitleaks()), seeded, { recursive: true })
  const env = { FERNLEDGER_CACHE_DIR: cache }
  const dir = newRepo()

  const intact = scan(dir, [], env)
  assert.equal(intact.status, 0)
  assert.doesNotMatch(intact.out, /Downloading/)

  appendFileSync(join(seeded, binaryName()), 'tampered')
  const tampered = scan(dir, [], env)
  assert.equal(tampered.status, 0)
  assert.match(tampered.out, /failed verification/)
  assert.match(tampered.out, /Downloading/)

  assert.doesNotMatch(scan(dir, [], env).out, /Downloading/)
})

// Installs a copy of install-hooks.mjs into <root>/scripts, as it sits in a real package.
function installHooksIn(root) {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(resolve('scripts/install-hooks.mjs'), join(root, 'scripts', 'install-hooks.mjs'))
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'install-hooks.mjs')], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout + r.stderr
}
function hooksPath(cwd) {
  return spawnSync('git', ['config', 'core.hooksPath'], { cwd, encoding: 'utf8' }).stdout.trim()
}

test('install-hooks points git at .githooks when the package is the repo root', () => {
  const dir = newRepo()
  installHooksIn(dir)
  assert.equal(hooksPath(dir), '.githooks')
})

test('install-hooks does nothing outside a git checkout', () => {
  const dir = tempDir('nogit')
  installHooksIn(dir)
  assert.equal(existsSync(join(dir, '.git')), false)
})

test('install-hooks leaves a package nested inside another repo alone', () => {
  const repo = newRepo()
  const nested = join(repo, 'packages', 'app')
  mkdirSync(nested, { recursive: true })
  assert.match(installHooksIn(nested), /not the repo root/)
  assert.equal(hooksPath(repo), '')
})

test('install-hooks does not overwrite a hooks path someone already chose', () => {
  const dir = newRepo()
  git(dir, 'config', 'core.hooksPath', 'my-hooks')
  assert.match(installHooksIn(dir), /already set/)
  assert.equal(hooksPath(dir), 'my-hooks')
})

test('self-test passes against the real config', () => {
  assert.equal(node('scripts/scan-selftest.mjs', process.cwd()).status, 0)
})

test('self-test fails when a path allowlist hides test fixtures', () => {
  const weakened = tempConfig((toml) => toml + "\n[allowlist]\npaths = ['''test/fixtures/''']\n")
  const r = node('scripts/scan-selftest.mjs', process.cwd(), ['--config', weakened])
  assert.equal(r.status, 1)
  assert.match(r.out, /nz-bank-account-number/)
  assert.match(r.out, /aws-access-token/)
})

test('self-test fails when the bank-99 allowlists stop matching', () => {
  const tightened = tempConfig((toml) => toml.replace(/^regexes = \[.*\]$/gm, () => "regexes = ['''^never-matches$''']"))
  const r = node('scripts/scan-selftest.mjs', process.cwd(), ['--config', tightened])
  assert.equal(r.status, 1)
  assert.match(r.out, /bank-99/)
})
