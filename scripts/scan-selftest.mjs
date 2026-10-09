// Usage: node scripts/scan-selftest.mjs [--config <path>]
// Proves .gitleaks.toml still catches what it exists to catch. Writes probe files to a temp dir
// (never into the repo), scans them with the config, and exits 1 unless:
//   - a real-looking NZ account number, an ASB CSV header with a non-99 bank, and a fake AWS key
//     are each caught, even though they sit under test/fixtures/
//   - the made-up bank 99 values are not flagged
// Probe values are assembled from pieces so this file doesn't trip the scanner itself.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureGitleaks } from './gitleaks.mjs'

const args = process.argv.slice(2)
const configIndex = args.indexOf('--config')
const config = resolve(configIndex >= 0 ? args[configIndex + 1] : '.gitleaks.toml')

const dash = (...parts) => parts.join('-')
const probes = [
  { file: 'catch-account.txt', mustCatch: 'nz-bank-account-number', text: `Account ${dash('12', '3456', '7890123', '00')}\n` },
  { file: 'catch-asb-header.csv', mustCatch: 'asb-csv-export-header', text: `Bank ${'12'}; Branch ${'3456'}; Account ${dash('1234567', '00')} (Probe)\n` },
  { file: 'catch-aws-key.env', mustCatch: 'aws-access-token', text: `AWS_ACCESS_KEY_ID=${'AKIA' + 'ZXCVBNMASDFGHJKL'}\n` },
  {
    file: 'pass-bank-99.csv',
    mustCatch: null,
    text: `Bank 99; Branch 9999; Account 9999999-99 (Probe)\nTransfer to ${dash('99', '9999', '9999999', '00')}\n`,
  },
]

const work = mkdtempSync(join(tmpdir(), 'fernledger-selftest-'))
const problems = []
try {
  const fixtures = join(work, 'test', 'fixtures', 'probe')
  mkdirSync(fixtures, { recursive: true })
  for (const p of probes) writeFileSync(join(fixtures, p.file), p.text)

  const report = join(work, 'report.json')
  const bin = await ensureGitleaks()
  const r = spawnSync(
    bin,
    ['dir', join(work, 'test'), '--config', config, '--report-format', 'json', '--report-path', report, '--exit-code', '0', '--redact', '--no-banner', '--log-level', 'warn'],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`gitleaks failed to run: ${r.stderr}`)
  const findings = JSON.parse(readFileSync(report, 'utf8'))

  for (const p of probes) {
    const rules = findings.filter((f) => f.File.replaceAll('\\', '/').endsWith(`/${p.file}`)).map((f) => f.RuleID)
    if (p.mustCatch && !rules.includes(p.mustCatch)) {
      problems.push(`NOT CAUGHT: ${p.file} should trigger ${p.mustCatch} (got: ${rules.join(', ') || 'nothing'})`)
    }
    if (!p.mustCatch && rules.length > 0) {
      problems.push(`WRONGLY FLAGGED: bank-99 probe ${p.file} triggered ${[...new Set(rules)].join(', ')}`)
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`Secret-scan self-test FAILED for ${config}:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('Secret-scan self-test passed: probes caught, bank-99 values allowed.')
