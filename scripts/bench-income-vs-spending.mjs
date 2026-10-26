// A timing of the Income vs spending by month Report's roll-up in Node, at the most months a Report covers (120) and 30, 100 and 600 Categories (ADR 0004). Run it by hand:
//
//   node scripts/bench-income-vs-spending.mjs [repeats]
//
// It is not part of `npm run check`. Each size and each function is timed in a FRESH process, because the first call in a process pays for compiling and for growing the heap
// and is what a Worker that has just started pays, and a warm figure alone hides it. For each, it prints the first call and the median of 30 calls after it, as the lowest and highest of
// `repeats` fresh processes (default 5). The functions:
//   rollUp            what the Report called at first: `rollUp` over the rows of `buildSpending`, a row for every Category in every month, which also builds an object for each
//   rollUpMonthly     what it calls now: the same Spending and Income by month over the rows of `buildMonthlySpending`, a few rows a month, which D1 groups (worker/spending.ts)
//   incomeVsSpending  the Report's whole function over those rows (`rollUpMonthly` and the calendar, worker/report-income-vs-spending.ts), then the JSON of its answer
// The rows `buildMonthlySpending` gives are made here from the per-Category rows, by month, kind and whether there is a Category, before the clock starts: that is D1's work, which does not
// count against the Worker's CPU. The script is NOT a measurement of the free plan's 10 ms (workerd's CPU can't be seen from a test), and it leaves out what it costs D1 to hand the rows to
// the Worker (about 72,000 at 600 Categories for `rollUp`, about 480 for the rest). The machine and the Node it ran on are printed, because the figures belong to them.
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MONTHS = 120
const SIZES = [30, 100, 600]
const FUNCTIONS = ['rollUp', 'rollUpMonthly', 'incomeVsSpending']
const WARM_CALLS = 30
const RANGE = { from: '2016-01-01', to: '2025-12-31' }

const months = Array.from({ length: MONTHS }, (_, i) => `${2016 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`)

/** The rows `buildSpending` gives: a row for each month and Category with something in it (one in twenty Categories is Income, one in twenty a Loans one), and Uncategorised. */
function rowsFor(categories) {
  const rows = []
  for (const month of months) {
    for (let c = 0; c < categories; c++) {
      const kind = c % 20 === 0 ? 'income' : c % 20 === 1 ? 'loans' : 'spending'
      rows.push({ month, categoryId: c + 1, categoryName: `Category number ${c + 1}`, kind, outCents: 12_345 + c, inCents: c % 3 === 0 ? 1000 : 0 })
    }
    rows.push({ month, categoryId: null, categoryName: null, kind: 'spending', outCents: 700, inCents: 300 })
  }
  return rows
}

/** What D1 gives for `buildMonthlySpending`: the per-Category rows added up by month, kind and whether there is a Category (at most four a month). */
function monthlyRowsOf(rows) {
  const groups = new Map()
  for (const row of rows) {
    const uncategorised = row.categoryId === null ? 1 : 0
    const key = `${row.month}|${uncategorised}|${row.kind}`
    const group = groups.get(key) ?? { month: row.month, uncategorised, kind: row.kind, outCents: 0, inCents: 0, counted: 0 }
    group.outCents += row.outCents
    group.inCents += row.inCents
    group.counted += 3 // each row stands for a few Transactions
    groups.set(key, group)
  }
  return [...groups.values()]
}

if (process.argv[2] === '--child') {
  const [, , , bundle, size, name] = process.argv
  const { rollUp, rollUpMonthly, incomeVsSpending } = await import(pathToFileURL(bundle).href)
  const run = {
    rollUp: (rows) => rollUp(rows),
    rollUpMonthly: (rows) => rollUpMonthly(rows),
    incomeVsSpending: (rows) => JSON.stringify(incomeVsSpending(RANGE, rows, '2026-10-20')),
  }[name]
  const perCategory = rowsFor(Number(size))
  const rows = name === 'rollUp' ? perCategory : monthlyRowsOf(perCategory) // made before the clock starts: D1's rows arrive however they are used
  const first = performance.now()
  run(rows)
  const firstMs = performance.now() - first
  const warm = []
  for (let i = 0; i < WARM_CALLS; i++) {
    const t = performance.now()
    run(rows)
    warm.push(performance.now() - t)
  }
  warm.sort((a, b) => a - b)
  console.log(JSON.stringify({ rows: rows.length, firstMs, warmMs: warm[Math.floor(warm.length / 2)] }))
} else {
  const repeats = Number(process.argv[2] ?? 5)
  const root = resolve(fileURLToPath(import.meta.url), '..', '..')
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-bench-'))
  const bundle = join(dir, 'bundle.mjs')
  const worker = (file) => JSON.stringify(join(root, 'worker', file).replaceAll('\\', '/'))
  buildSync({
    stdin: { contents: `export { rollUp, rollUpMonthly } from ${worker('spending.ts')}\nexport { incomeVsSpending } from ${worker('report-income-vs-spending.ts')}`, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'error',
  })
  console.log(`${cpus()[0].model.trim()}, ${cpus().length} threads, ${(totalmem() / 2 ** 30).toFixed(0)} GB, Node ${process.version}, ${process.platform}; ${MONTHS} months; ${repeats} fresh processes for each line (lowest to highest)`)
  const range = (xs) => `${Math.min(...xs).toFixed(2)}-${Math.max(...xs).toFixed(2)}`
  for (const size of SIZES) {
    for (const name of FUNCTIONS) {
      const runs = []
      for (let i = 0; i < repeats; i++) {
        const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', bundle, String(size), name], { encoding: 'utf8' })
        if (out.status !== 0) throw new Error(`${name} at ${size} Categories failed: ${out.stderr}`)
        runs.push(JSON.parse(out.stdout))
      }
      console.log(`${String(size).padStart(3)} Categories (${runs[0].rows} rows)  ${name.padEnd(16)} first call ${range(runs.map((r) => r.firstMs)).padStart(11)} ms   warm ${range(runs.map((r) => r.warmMs)).padStart(10)} ms`)
    }
  }
}
