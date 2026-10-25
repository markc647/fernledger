// Screenshots of the app with MADE-UP data, for a design review (docs/agents/design-review.md).
// One foreground run: a fresh local database, the production build served on a port of this checkout's own, the
// made-up data put in through the API, the screenshots, then the server stopped. Nothing touches `npm run dev`'s data.
// Usage: node scripts/review-shots.mjs [--out <folder>] [--only <name|name…>] [--skip-build]
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = resolve(root, option('--out') ?? 'test-results/review-shots')
// Parts of screenshot names, `|` between them. Plain text rather than a regular expression made from an argument (CodeQL js/regex-injection).
const only = option('--only')?.split('|') ?? null

// A port and database of this checkout's own, as playwright.config.ts does for the browser tests, in 30000–39999 so the two never meet.
const port = Number(process.env.REVIEW_PORT ?? 30_000 + (parseInt(createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 8), 16) % 10_000))
const BASE = `http://localhost:${port}`
const state = join(process.env.TEST_TEMP_ROOT ?? join(root, '.wrangler'), `review-state-${port}`)

// ---- The made-up household: four Accounts (bank 99, which is no real bank), May to mid-October 2026.

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20261016) // the same data every run, so screenshots compare
const pick = (list) => list[Math.floor(rnd() * list.length)]
const between = (lo, hi) => Math.round(lo + rnd() * (hi - lo))

const iso = (d) => d.toISOString().slice(0, 10)
const day = (s) => new Date(`${s}T00:00:00Z`)
const addDays = (s, n) => iso(new Date(day(s).getTime() + n * 86_400_000))
const START = '2026-05-01'
const END = '2026-10-15'
const SPLIT = '2026-07-31' // two imports per Account, so each has two balances for the Balance Check
const dow = (s) => day(s).getUTCDay()
const dom = (s) => Number(s.slice(8))

// 99-9999-9999999-NN is the made-up number the secret scan allows (.gitleaks.toml); this database is its own, so the e2e suffixes don't matter.
const ACCOUNTS = {
  everyday: { number: '99-9999-9999999-01', name: 'Everyday Account', opening: 285000 },
  savings: { number: '99-9999-9999999-02', name: 'Rainy Day Savings', opening: 820000 },
  visa: { number: '99-9999-9999999-03', name: 'Fernwood Visa', opening: -42000 },
  loan: { number: '99-9999-9999999-04', name: 'Car Loan', opening: -1450000 },
}
const rows = { everyday: [], savings: [], visa: [], loan: [] }
const add = (acct, date, payee, amountCents, { memo = 'EFTPOS', type = 'EFTPOS', category } = {}) => rows[acct].push({ date, payee, memo, tranType: type, amountCents, category })

const groceries = ['KAURI GROCERS NEWTOWN', 'PUKEKO GROCERS', 'KAURI GROCERS CITY', 'PUKEKO FRESH MARKET']
const cafes = ['HARBOUR VIEW CAFE', 'RIMU & CO CAFE', 'TUI STREET BAKERY', 'KINA SUSHI', 'MANUKA PIZZA CO', 'FANTAIL COFFEE CART']
const fuel = ['HARBOUR FUEL STOP', 'KAURI FUEL EXPRESS']
const fun = ['KEA CINEMAS', 'MOREPORK BOOKSHOP', 'TAUI ESCAPE ROOMS', 'KAKAPO GAMES STORE']
const health = ['MANUKA PHARMACY', 'WELLBEING PHYSIO']

const visaSpend = {}
for (let d = START; d <= END; d = addDays(d, 1)) {
  const month = d.slice(0, 7)
  const fortnight = Math.round((day(d) - day(START)) / 86_400_000 / 7) % 2 // START is a Friday
  if (dow(d) === 5 && fortnight === 0) add('everyday', d, 'KOWHAI DESIGN LTD', 268500, { memo: 'SALARY', type: 'CREDIT', category: 'Wages and salary' })
  if (dow(d) === 5 && fortnight === 1) {
    add('everyday', d, 'CAR LOAN PAYMENT', -42000, { memo: 'AUTOMATIC PAYMENT', type: 'D/D', category: 'Loans' })
    add('loan', addDays(d, 1), 'LOAN PAYMENT RECEIVED', 42000, { memo: 'PAYMENT RECEIVED', type: 'CREDIT', category: 'Loans' })
  }
  if (dom(d) === 1) add('everyday', d, 'TAWA PROPERTY MGMT', -180000, { memo: 'RENT', type: 'D/D', category: 'Rent or mortgage' })
  if (dom(d) === 8) add('everyday', d, 'PUKEKO POWER LTD', -between(14500, 21500), { memo: 'DIRECT DEBIT', type: 'D/D', category: 'Power and gas' })
  if (dom(d) === 12) add('everyday', d, 'KAHU FIBRE INTERNET', -8999, { memo: 'DIRECT DEBIT', type: 'D/D', category: 'Phone and internet' })
  if (dom(d) === 20 && rnd() < 0.7) add('everyday', d, 'WAIORA WATER RATES', -between(6200, 7800), { memo: 'DIRECT DEBIT', type: 'D/D', category: 'Rates and water' })
  if (dom(d) === 3) {
    add('everyday', d, 'TRANSFER TO RAINY DAY', -40000, { memo: 'TRANSFER', type: 'D/C' })
    add('savings', d, 'TRANSFER FROM EVERYDAY', 40000, { memo: 'TRANSFER', type: 'CREDIT' })
  }
  if (addDays(d, 1).slice(0, 7) !== month) add('savings', d, 'FERNWOOD BANK - INTEREST', between(2050, 2900), { memo: 'CR.INT', type: 'INT', category: 'Interest' })
  if (dom(d) === 20) {
    // The card payment clears last month's purchases (the opening balance in May).
    const previous = month === '2026-05' ? null : `2026-${String(Number(month.slice(5)) - 1).padStart(2, '0')}`
    const owed = previous ? (visaSpend[previous] ?? 0) : -ACCOUNTS.visa.opening
    if (owed > 0) {
      add('everyday', d, 'FERNWOOD VISA PAYMENT', -owed, { memo: 'VISA PAYMENT', type: 'D/C' })
      add('visa', d, 'PAYMENT - THANK YOU', owed, { memo: 'PAYMENT', type: 'CREDIT' })
    }
  }
  if ((dow(d) === 2 || dow(d) === 6) && rnd() < 0.9) add('everyday', d, pick(groceries), -between(5200, 18900), { category: 'Groceries' })
  if (dow(d) === 0 && rnd() < 0.8) add('everyday', d, pick(fuel), -between(6800, 10400), { category: 'Fuel' })
  if (dow(d) === 6 && rnd() < 0.6) add('everyday', d, pick(cafes), -between(1800, 5600), { category: 'Eating out' })
  const card = []
  if (rnd() < 0.35) card.push([pick(cafes), -between(1500, 8800), 'Eating out'])
  if (rnd() < 0.12) card.push([pick(fun), -between(1800, 9500), 'Entertainment'])
  if (dow(d) === 4 && rnd() < 0.6) card.push([pick(groceries), -between(9800, 21500), 'Groceries'])
  if (dow(d) === 3 && rnd() < 0.4) card.push([pick(fuel), -between(5500, 9200), 'Fuel'])
  if (rnd() < 0.05) card.push([pick(health), -between(1800, 7200), 'Health and medical'])
  if (dom(d) === 14) card.push(['STREAMBOX SUBSCRIPTION', -1699, 'Entertainment'])
  for (const [payee, cents, category] of card) {
    add('visa', d, payee, cents, { type: 'D/C', category })
    visaSpend[month] = (visaSpend[month] ?? 0) - cents
  }
  if (dom(d) === 28) add('loan', d, 'INTEREST CHARGED', -between(7400, 8100), { memo: 'LOAN INTEREST', type: 'INT', category: 'Loans' })
}
// Left for the Uncategorised page: no Rule matches them and no Override is made.
for (const [acct, d, payee, cents] of [
  ['everyday', '2026-06-13', 'SWAP MEET STALL 14', -4500], ['everyday', '2026-08-22', 'N7 SPORTS CLUB RAFFLE', -2000], ['everyday', '2026-09-05', 'PARKING PAY STATION 4412', -1280],
  ['everyday', '2026-09-27', 'SHARED GIFT - REF 2231', -6500], ['everyday', '2026-10-03', 'AIRPORT TAXIS LTD', -4890], ['everyday', '2026-10-09', 'MORNINGSIDE HARDWARE', -3735],
  ['everyday', '2026-10-12', 'SCHOOL FAIR STALL', -2500], ['visa', '2026-09-18', 'WILLOW GARDEN CENTRE', -8420], ['visa', '2026-10-06', 'ONLINE ORDER 88213-A', -11990],
  ['visa', '2026-10-11', 'BRIGHTSIDE DENTAL', -23500], ['everyday', '2026-10-14', 'REFUND KEA CINEMAS', 1800], ['visa', '2026-10-13', 'LATE PAYMENT FEE', -1000],
]) add(acct, d, payee, cents, { type: cents > 0 ? 'CREDIT' : 'D/C' })
for (const list of Object.values(rows)) list.sort((a, b) => a.date.localeCompare(b.date))
const NOTES = [
  ['everyday', 'TAWA PROPERTY MGMT', '2026-10-01', 'Rent went up $50 from October? Check the lease.'],
  ['visa', 'BRIGHTSIDE DENTAL', '2026-10-11', 'Claim back on health insurance'],
  ['everyday', 'SHARED GIFT - REF 2231', '2026-09-27', 'Paid for the shared birthday present'],
]

async function api(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: 'fernledger_dev_as=admin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function seed() {
  await api('POST', '/api/categories', { name: 'Pets', kind: 'spending' })
  const cat = Object.fromEntries((await api('GET', '/api/categories')).map((c) => [c.name, c.id]))
  for (const rule of [
    { textContains: 'GROCER', categoryId: cat.Groceries },
    { textContains: 'FUEL', categoryId: cat.Fuel },
    { textContains: 'SALARY', direction: 'in', categoryId: cat['Wages and salary'] },
    { bankType: 'INT', direction: 'in', categoryId: cat.Interest },
    { textContains: 'CAR LOAN', categoryId: cat.Loans },
  ]) await api('POST', '/api/rules', rule)
  for (const [from, to, file] of [[START, SPLIT, 1], [addDays(SPLIT, 1), END, 2]]) {
    for (const [key, acct] of Object.entries(ACCOUNTS)) {
      const inFile = rows[key].filter((r) => r.date >= from && r.date <= to)
      const balance = rows[key].filter((r) => r.date <= to).reduce((sum, r) => sum + r.amountCents, acct.opening)
      await api('POST', '/api/imports/chunks', {
        account: { number: acct.number, name: acct.name },
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: inFile.length, skipped: 0, from, to, ledgerBalance: { cents: balance, date: to } },
        rows: inFile.map((r, i) => ({ date: r.date, uniqueId: `${key.slice(0, 2).toUpperCase()}${file}${String(i).padStart(4, '0')}`, tranType: r.tranType, chequeNumber: null, payee: r.payee, bankMemo: r.memo, amountCents: r.amountCents })),
      })
    }
  }
  // Overrides for what the Rules left, and the Notes.
  const accounts = await api('GET', '/api/accounts')
  for (const [key, acct] of Object.entries(ACCOUNTS)) {
    const { id } = accounts.find((a) => a.name === acct.name)
    const listed = (await api('GET', `/api/transactions?accountId=${id}&from=${START}&to=${END}&limit=200&count=false`)).transactions
    const used = new Set()
    for (const r of rows[key]) {
      const t = listed.find((x) => !used.has(x.id) && x.description === r.payee && x.date === r.date && x.amountCents === r.amountCents)
      if (!t) throw new Error(`Seeded Transaction not listed: ${key} ${r.date} ${r.payee}`)
      used.add(t.id)
      if (r.category && t.categoryName !== r.category) await api('PUT', `/api/transactions/${t.id}/override`, { categoryId: cat[r.category] })
      const note = NOTES.find(([k, payee, date]) => k === key && payee === r.payee && date === r.date)
      if (note) await api('PUT', `/api/transactions/${t.id}/note`, { note: note[3] })
    }
  }
  for (const [name, from, cents] of [['Groceries', '2026-05', 70000], ['Groceries', '2026-10', 75000], ['Eating out', '2026-05', 25000], ['Fuel', '2026-05', 28000], ['Power and gas', '2026-05', 40000]]) {
    await api('PUT', `/api/budgets/${cat[name]}`, { effectiveFrom: from, amountCents: cents })
  }
}

// ---- The screenshots. Add one here for a page your change touches; `--only` takes a few by name.

const DATES = `from=${START}&to=${END}`
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844, phone: true }
const tableShown = (p) => p.getByRole('table').first().waitFor()
const syncSection = (p) => p.getByRole('region', { name: 'Run a Sync now' })

/** Scrolls "Run a Sync now" into view and frames the Settings screen on it. */
const syncShown = async (p) => {
  await syncSection(p).scrollIntoViewIfNeeded()
  await syncSection(p).waitFor()
}

/**
 * A Sync the Admin runs, with its Accounts set up for it first: one linked and given a Cutover Date, one linked without
 * one (which Sync leaves alone, and says so). Only for the run with made-up Akahu tokens set, which is what makes the
 * control live; Akahu then refuses them, so the shot is of a run that failed, said why per Account, and wrote nothing.
 */
const linkSection = (p) => p.getByRole('region', { name: 'Akahu Sync' })

/** Scrolls the Account Link into view: with no Akahu tokens this is its Setup-needed state. */
const linkShown = async (p) => {
  await linkSection(p).scrollIntoViewIfNeeded()
  await linkSection(p).waitFor()
}

/**
 * The Account Link with its states side by side: one Account linked and given a Cutover Date, one linked without one (which
 * Sync skips, and the row says so), and the rest not linked. Only for the run with made-up Akahu tokens, which is what makes
 * the control live. Asking for the list of Akahu accounts then fails, because the tokens are not real, so the shot also shows
 * how that failure reads — which is the part worth reviewing, the happy path needing a real Akahu account.
 */
const accountLink = async (p) => {
  const accounts = await api('GET', '/api/accounts')
  const id = (name) => accounts.find((a) => a.name === name).id
  await api('PUT', `/api/accounts/${id(ACCOUNTS.everyday.name)}/akahu-link`, { akahuAccountId: 'acc_example00000000000001' })
  await api('PUT', `/api/accounts/${id(ACCOUNTS.everyday.name)}/cutover-date`, { cutoverDate: addDays(END, 1) })
  await api('PUT', `/api/accounts/${id(ACCOUNTS.savings.name)}/akahu-link`, { akahuAccountId: 'acc_example00000000000002' })
  await p.reload()
  const button = linkSection(p).getByRole('button', { name: 'Show my Akahu accounts' })
  await button.waitFor()
  await button.scrollIntoViewIfNeeded()
  await button.click()
  await linkSection(p).getByRole('alert').first().waitFor()
}

const syncRun = async (p) => {
  const accounts = await api('GET', '/api/accounts')
  const id = (name) => accounts.find((a) => a.name === name).id
  await api('PUT', `/api/accounts/${id(ACCOUNTS.everyday.name)}/akahu-link`, { akahuAccountId: 'acc_example00000000000001' })
  await api('PUT', `/api/accounts/${id(ACCOUNTS.everyday.name)}/cutover-date`, { cutoverDate: addDays(END, 1) })
  await api('PUT', `/api/accounts/${id(ACCOUNTS.savings.name)}/akahu-link`, { akahuAccountId: 'acc_example00000000000002' })
  await p.reload()
  const button = syncSection(p).getByRole('button', { name: 'Run a Sync now' })
  await button.waitFor()
  await button.scrollIntoViewIfNeeded()
  await button.click()
  await syncSection(p).getByText(/^Sync (finished|did not finish)/).waitFor({ timeout: 30_000 })
}
/** A Member's reads refused for the day's limit: the page again, so its reads meet the refusal. */
async function dayLimitShown(page) {
  await page.route(/\/api\/transactions\?/, (route) => route.fulfill({ status: 429, json: { error: 'Daily limit reached', reason: 'member-reads' } }))
  await page.reload()
  await page.getByRole('alert').filter({ hasText: "Today's limit on Members' reads" }).waitFor()
}

/** Download CSV while the Member stays busy: the client asks again for 10 s (src/lib/member-busy.ts), then the page says so. */
async function exportBusy(page) {
  await page.route(/\/api\/transactions\/export\.csv/, (route) => route.fulfill({ status: 429, json: { error: 'Too many requests at once', reason: 'member-busy' } }))
  await page.locator('#filter-download-count').waitFor()
  await page.getByRole('link', { name: 'Download CSV' }).click()
  await page.getByRole('alert').filter({ hasText: 'still reading for you' }).waitFor({ timeout: 20_000 })
}

const SHOTS = [
  { name: 'dashboard', path: '/' },
  { name: 'transactions', path: '/transactions' },
  { name: 'transactions-edit', path: '/transactions', fullPage: false, before: (p) => p.getByRole('button', { name: /^Edit / }).first().click() },
  { name: 'uncategorised', path: '/uncategorised' },
  // The detail of the first Transaction in the list. The made-up household is imported, not Synced, so this is the Import's short
  // "From the bank": what Akahu sends, field by field, is only there for a Synced Transaction.
  { name: 'transaction-detail', path: '/transactions', before: async (p) => { await p.getByRole('cell').getByRole('link').first().click(); await p.getByRole('region', { name: 'From the bank' }).waitFor() } },
  { name: 'import-preview', path: '/import', before: async (p) => { await p.locator('input[type="file"]').setInputFiles(join(root, 'test/fixtures/asb/savings.csv')); await tableShown(p) } },
  { name: 'export', path: '/export' },
  { name: 'reports', path: '/reports' },
  { name: 'report-spending', path: `/reports/spending?${DATES}`, before: tableShown },
  { name: 'report-income', path: `/reports/income-vs-spending?${DATES}`, before: tableShown },
  { name: 'report-budget', path: `/reports/budget-vs-actual?${DATES}`, before: tableShown },
  { name: 'net-worth', path: '/reports/net-worth' },
  { name: 'accounts', path: '/accounts' },
  { name: 'categories', path: '/categories' },
  { name: 'rules', path: '/rules' },
  { name: 'rules-menu', path: '/rules', fullPage: false, before: async (p) => { await p.getByRole('button', { name: /^Actions for Rule/ }).first().click(); await p.getByRole('menu').waitFor() } },
  { name: 'budgets', path: '/budgets' },
  { name: 'settings', path: '/settings' },
  // "Run a Sync now": its Setup-needed state, which is what an instance with no Akahu tokens sees.
  { name: 'settings-sync', path: '/settings', fullPage: false, before: syncShown },
  // And a run, which needs the tokens. They reach the Worker through the build, so this one cannot use --skip-build:
  // AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=… node scripts/review-shots.mjs --only settings-sync-run
  { name: 'settings-sync-run', path: '/settings', fullPage: false, akahu: true, before: syncRun },
  // The Account Link (spec 29): its Setup-needed state, which is what an instance with no Akahu tokens sees.
  { name: 'settings-account-link', path: '/settings', fullPage: false, before: linkShown },
  // And the live control, which needs the tokens, as the run above does:
  // AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=… node scripts/review-shots.mjs --only settings-account-link-chosen
  { name: 'settings-account-link-chosen', path: '/settings', fullPage: false, akahu: true, before: accountLink },
  { name: 'change-log', path: '/change-log' },
  { name: 'summary-member', path: '/', role: 'member' },
  // The Members' daily read limit and a busy Member (worker/member-read-limit.ts): the Worker's refusals are stubbed, so nothing has to read up to the limit.
  { name: 'member-day-limit', path: '/transactions', role: 'member', fullPage: false, before: dayLimitShown },
  { name: 'phone-member-day-limit', path: '/transactions', role: 'member', viewport: PHONE, fullPage: false, before: dayLimitShown },
  { name: 'export-member-busy', path: '/export', role: 'member', fullPage: false, before: exportBusy },
  { name: 'dashboard-dark', path: '/', theme: 'dark' },
  { name: 'transactions-dark', path: '/transactions', theme: 'dark' },
  { name: 'phone-dashboard', path: '/', viewport: PHONE },
  { name: 'phone-transactions', path: '/transactions', viewport: PHONE },
]

const settle = (page) => page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)))

async function shootAll() {
  mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  const problems = []
  try {
    // A shot marked `akahu` needs both Akahu tokens in the environment, which `serverEnv` passes to the Worker. Without
    // them Sync is switched off and there is nothing to photograph, so it is left out rather than failing.
    const akahuOn = Boolean(process.env.AKAHU_APP_TOKEN && process.env.AKAHU_USER_TOKEN)
    for (const shot of SHOTS.filter((s) => (!only || only.some((part) => s.name.includes(part))) && (!s.akahu || akahuOn))) {
      const { role = 'admin', theme = 'light', viewport = DESKTOP } = shot
      const context = await browser.newContext({ viewport, colorScheme: theme, ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}) })
      await context.addCookies([{ name: 'fernledger_dev_as', value: role, domain: 'localhost', path: '/' }])
      const page = await context.newPage()
      try {
        await page.goto(BASE + shot.path)
        await page.locator('h1').first().waitFor()
        await page.waitForLoadState('networkidle')
        if (shot.before) await shot.before(page)
        await page.waitForLoadState('networkidle')
        await settle(page)
        await page.screenshot({ path: join(out, `${shot.name}.png`), fullPage: shot.fullPage ?? true })
        console.log(`shot ${shot.name}`)
      } catch (e) {
        problems.push(`${shot.name}: ${String(e.message ?? e).split('\n')[0]}`)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return problems
}

// ---- The server: run in the foreground of this script and stopped by its own PID (never by name: parallel-work.md).

function run(command, env = {}) {
  const r = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${command} failed (exit ${r.status})`)
}

const serverEnv = { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', ADMIN_EMAIL: 'admin@example.com', DEV_USER_EMAIL: 'admin@example.com', E2E_PERSIST_TO: state }
run('node scripts/e2e-prepare.mjs', { E2E_PERSIST_TO: state })
if (!args.includes('--skip-build')) run('npm run build')
const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], {
  cwd: root,
  env: { ...process.env, ...serverEnv },
  stdio: 'ignore',
  detached: process.platform !== 'win32',
})
const stop = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(-server.pid)
}
let problems = []
try {
  const deadline = Date.now() + 60_000
  while (!(await fetch(BASE).then((r) => r.ok, () => false))) {
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`The review server did not start on ${BASE}.`)
    await new Promise((done) => setTimeout(done, 500))
  }
  await seed()
  console.log(`Seeded made-up data on ${BASE}.`)
  problems = await shootAll()
} finally {
  stop()
}
console.log(`Screenshots in ${out}`)
if (problems.length) {
  console.error(['Some screenshots failed:', ...problems.map((p) => `  - ${p}`)].join('\n'))
  process.exitCode = 1
}
