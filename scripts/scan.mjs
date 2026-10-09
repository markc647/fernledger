// Usage: node scripts/scan.mjs [--staged] [--config <path>]   (run from the repo root)
//   default   scans the working tree: tracked and untracked files, minus anything gitignored
//   --staged  scans only what is staged (used by the pre-commit hook)
// Exits 0 when clean, 1 on findings. Findings are redacted: only the rule, file and line print.
import { spawnSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ensureGitleaks } from './gitleaks.mjs'

const args = process.argv.slice(2)
const staged = args.includes('--staged')
const configIndex = args.indexOf('--config')
const config = resolve(configIndex >= 0 ? args[configIndex + 1] : '.gitleaks.toml')
const common = ['--config', config, '--redact', '--verbose', '--no-banner', '--log-level', 'warn']

const bin = await ensureGitleaks()

function run(gitleaksArgs, cwd) {
  const r = spawnSync(bin, gitleaksArgs, { cwd, stdio: 'inherit' })
  if (r.error) throw r.error
  return r.status ?? 1
}

if (staged) {
  process.exit(run(['git', '--pre-commit', '--staged', ...common], process.cwd()))
}

// gitleaks ignores .gitignore, so it would wade through node_modules. Copy just the files git
// would consider part of the project into a temp dir and scan that.
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 })
if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`)
const copy = mkdtempSync(join(tmpdir(), 'fernledger-scan-'))
try {
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    let stat
    try {
      stat = lstatSync(file)
    } catch {
      continue // deleted but not yet staged
    }
    if (!stat.isFile()) continue
    mkdirSync(dirname(join(copy, file)), { recursive: true })
    copyFileSync(file, join(copy, file))
  }
  process.exit(run(['dir', copy, ...common], process.cwd()))
} finally {
  rmSync(copy, { recursive: true, force: true })
}
