// The whole browser suite on this machine in a quarter of the time: `npm run test:e2e:shards [-- <playwright args>]`.
// The tests run one at a time on one database (playwright.config.ts), so this builds the app once and runs the suite as
// four parts side by side, each with a port and so a database of its own (under TEST_TEMP_ROOT when set: a RAM disk, say).
// Each part's output goes to test-results/shard-<n>.log; the logs of the parts that failed are printed at the end.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const parts = Number(process.env.E2E_SHARDS ?? 4)
// Clear of a checkout's own port as far as one can be (20000–29999, playwright.config.ts); --strictPort fails a clash loudly.
const firstPort = Number(process.env.E2E_SHARD_PORT ?? 29_900)
const args = process.argv.slice(2)

const build = spawnSync('npm run build', { cwd: root, stdio: 'inherit', shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

const results = resolve(root, 'test-results')
mkdirSync(results, { recursive: true })
const started = Date.now()

function runPart(n) {
  const log = resolve(results, `shard-${n}.log`)
  const out = createWriteStream(log)
  const child = spawn('npx', ['playwright', 'test', ...args, `--shard=${n}/${parts}`, `--output=test-results/shard-${n}`, '--pass-with-no-tests'], {
    cwd: root,
    shell: true,
    env: { ...process.env, E2E_PORT: String(firstPort + n), E2E_SKIP_BUILD: '1' },
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  return new Promise((done) => child.on('close', (code) => out.end(() => done({ n, code, log }))))
}

const finished = await Promise.all(Array.from({ length: parts }, (_, i) => runPart(i + 1)))
const failed = finished.filter((part) => part.code !== 0)
for (const part of failed) console.log(`\n--- part ${part.n} failed (${part.log}) ---\n${readFileSync(part.log, 'utf8').split('\n').slice(-60).join('\n')}`)
for (const part of finished) console.log(`part ${part.n}: ${part.code === 0 ? 'passed' : `failed (exit ${part.code})`}`)
console.log(`${parts} parts in ${Math.round((Date.now() - started) / 60_000)} min`)
process.exit(failed.length ? 1 : 0)
