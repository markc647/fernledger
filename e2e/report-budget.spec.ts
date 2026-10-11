import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'

// Ticket 21: the Budget vs actual Report (spec story 94). It uses the Report frame of ticket 18, so it opens in a new window, says on its face what it is,
// and prints with its table headings on every page. The Report's numbers are held to the Summary's Budget vs actual and to Spending in
// worker/report-budget.test.ts; this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it makes
// (page count, the text on each page, the margins and the size of the type).

// TODO: e2e/report-helpers.ts (ticket 20) will hold WCAG, dateText, setTitle, blackOnWhite, squash and the 12pt, margin and title checks; switch to them then.
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const MEMBER_EMAIL = 'dev.member@example.com'
const TITLE = `Mum's "family" finances \\ Report` // quote, apostrophe and backslash: the Admin can type any of them
const NOW = new Date('2026-10-08T02:42:00.000Z') // 3:42 pm in NZ
const GENERATED = `Generated Thu 8 Oct 2026 at 3:42 pm by ${MEMBER_EMAIL}`

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2001 and 2000, before every other spec's: tickets 17 and 20 have 2002 to 2004).
// The Report is of all Accounts, so it lists what other specs made too, but they have nothing in these years and no Budget reaches back to them.
//
// A year's worth of everything the Report has to get right, January to June:
// - Eating out has $150.00 from January, ended from April; Fuel has $200.00 from February; Groceries has $800.00 from January. Both of those are ended
//   from July, so the Budgets do not reach the months other specs use;
// - Fuel in January has no Budget yet and Eating out in April has none any more, so that spending is outside Budgets;
// - February has a refund, wages ($2,000.00, Income) and money lent ($500.00, Loans); March has money in with no Category, so Uncategorised is below zero;
// - April has a Transfer of $300.00 between the two Accounts, which is neither spending nor income.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  return {
    year: light ? 2001 : 2000,
    // Names that no other spec's name is part of (and that are part of none): a spec finds an Account or Category by a part of its name, case aside.
    everyday: { number: light ? '99-9999-9999999-80' : '99-9999-9999999-82', name: `Monthly budgets everyday ${project}` },
    savings: { number: light ? '99-9999-9999999-81' : '99-9999-9999999-83', name: `Monthly budgets savings ${project}` },
    names: {
      // In this alphabetical order, which is the order the Report lists them in; none has a starter Category's name in it.
      cafe: `Budget report coffee ${project}`,
      fuel: `Budget report petrol ${project}`,
      groceries: `Budget report supermarket ${project}`,
      wages: `Budget report pay ${project}`,
      loan: `Budget report lent ${project}`,
    },
  }
}
type Names = ReturnType<typeof dataFor>['names']

// Dates and money, written the way the app writes them.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const dateText = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthText = (month: string) => `${FULL_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
const money = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}`
/** What a Spent figure reads: "$55.50", or "$15.00 back" below zero. */
const spent = (cents: number) => `${money(Math.abs(cents))}${cents < 0 ? ' back' : ''}`
const two = (n: number) => String(n).padStart(2, '0')

type Row = { tag: string; date: string; cents: number; category?: keyof Names }
const everydayRows = (year: number): Row[] => {
  const d = (month: number, day: number) => `${year}-${two(month)}-${two(day)}`
  return [
    { tag: 'G1', date: d(1, 5), cents: -70_000, category: 'groceries' },
    { tag: 'G2', date: d(1, 20), cents: -5_000, category: 'groceries' },
    { tag: 'F1', date: d(1, 12), cents: -6_000, category: 'fuel' },
    { tag: 'C1', date: d(1, 15), cents: -4_000, category: 'cafe' },
    { tag: 'U1', date: d(1, 25), cents: -1_234 },
    { tag: 'G3', date: d(2, 3), cents: -80_000, category: 'groceries' },
    { tag: 'G4', date: d(2, 17), cents: 3_000, category: 'groceries' },
    { tag: 'F2', date: d(2, 10), cents: -18_000, category: 'fuel' },
    { tag: 'W1', date: d(2, 14), cents: 200_000, category: 'wages' },
    { tag: 'L1', date: d(2, 20), cents: -50_000, category: 'loan' },
    { tag: 'G5', date: d(3, 4), cents: -95_000, category: 'groceries' },
    { tag: 'F3', date: d(3, 9), cents: -21_000, category: 'fuel' },
    { tag: 'C2', date: d(3, 12), cents: -15_100, category: 'cafe' },
    { tag: 'U2', date: d(3, 30), cents: 2_000 },
    { tag: 'G6', date: d(4, 2), cents: -10_000, category: 'groceries' },
    { tag: 'C3', date: d(4, 8), cents: -6_000, category: 'cafe' },
    { tag: 'T1', date: d(4, 15), cents: -30_000 }, // the Transfer's first half
  ]
}

// The months, as the Report should show them (Budget, spent), worked out by hand from the rows above.
const MONTHS = ['01', '02', '03', '04', '05', '06']
const TOTAL_BUDGET = 625_000 // 950 + 1,150 + 1,150 + 1,000 + 1,000 + 1,000, in dollars
const TOTAL_SPENDING = 326_334
const MONTH_FIGURES: Record<string, { budget: number; spending: number; rows: [keyof Names, number, number][]; outside: number; uncategorised: number }> = {
  '01': { budget: 95_000, spending: 86_234, rows: [['cafe', 15_000, 4_000], ['groceries', 80_000, 75_000]], outside: 6_000, uncategorised: 1_234 },
  '02': { budget: 115_000, spending: 95_000, rows: [['cafe', 15_000, 0], ['fuel', 20_000, 18_000], ['groceries', 80_000, 77_000]], outside: 0, uncategorised: 0 },
  '03': { budget: 115_000, spending: 129_100, rows: [['cafe', 15_000, 15_100], ['fuel', 20_000, 21_000], ['groceries', 80_000, 95_000]], outside: 0, uncategorised: -2_000 },
  '04': { budget: 100_000, spending: 16_000, rows: [['fuel', 20_000, 0], ['groceries', 80_000, 10_000]], outside: 6_000, uncategorised: 0 },
  '05': { budget: 100_000, spending: 0, rows: [['fuel', 20_000, 0], ['groceries', 80_000, 0]], outside: 0, uncategorised: 0 },
  '06': { budget: 100_000, spending: 0, rows: [['fuel', 20_000, 0], ['groceries', 80_000, 0]], outside: 0, uncategorised: 0 },
}

const seeded = new Set<string>()

/** The project's Categories, Budgets, two Accounts and their Transactions. Safe to repeat: a Category, a Budget, an Import and an Override that are already there are left as they are. */
async function seed(context: BrowserContext, baseURL: string, project: string) {
  if (seeded.has(project)) return
  const { year, everyday, savings, names } = dataFor(project)
  await signInAs(context, 'admin')
  const headers = { Origin: baseURL }
  const existing = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  const category = async (name: string, kind: 'spending' | 'income' | 'loans') => {
    const found = existing.find((c) => c.name === name)
    if (found) return found.id
    const res = await context.request.post('/api/categories', { headers, data: { name, kind } })
    expect(res.status()).toBe(201)
    return ((await res.json()) as { id: number }).id
  }
  const id = {
    groceries: await category(names.groceries, 'spending'),
    fuel: await category(names.fuel, 'spending'),
    cafe: await category(names.cafe, 'spending'),
    wages: await category(names.wages, 'income'),
    loan: await category(names.loan, 'loans'),
  }
  const budget = async (name: keyof typeof id, month: string, amountCents: number | null) =>
    expect((await context.request.put(`/api/budgets/${id[name]}`, { headers, data: { effectiveFrom: `${year}-${month}`, amountCents } })).ok()).toBe(true)
  await budget('groceries', '01', 80_000)
  await budget('groceries', '07', null)
  await budget('fuel', '02', 20_000)
  await budget('fuel', '07', null)
  await budget('cafe', '01', 15_000)
  await budget('cafe', '04', null)

  const importRows = async (account: { number: string; name: string }, rows: { tag: string; date: string; cents: number }[]) => {
    const dates = rows.map((r) => r.date).sort()
    const res = await context.request.post('/api/imports/chunks', {
      headers,
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: dates[0], to: dates.at(-1), ledgerBalance: { date: dates.at(-1), cents: 0 } },
        rows: rows.map((r) => ({ date: r.date, uniqueId: `BR${year}${r.tag}`, tranType: 'EFTPOS', chequeNumber: null, payee: `EXAMPLE BUDGETSHOP ${year} ${r.tag}`, bankMemo: 'EFTPOS', amountCents: r.cents })),
      },
    })
    expect(res.ok()).toBe(true)
  }
  const rows = everydayRows(year)
  await importRows(everyday, rows)
  await importRows(savings, [{ tag: 'T2', date: `${year}-04-15`, cents: 30_000 }]) // the Transfer's other half, imported second so the two are paired

  const { transactions } = (await (await context.request.get(`/api/transactions?from=${year}-01-01&to=${year}-12-31&limit=200&count=false`)).json()) as { transactions: { id: number; description: string }[] }
  expect(transactions).toHaveLength(rows.length + 1)
  for (const r of rows) {
    if (!r.category) continue
    const tx = transactions.find((t) => t.description === `EXAMPLE BUDGETSHOP ${year} ${r.tag}`)!
    expect((await context.request.put(`/api/transactions/${tx.id}/override`, { headers, data: { categoryId: id[r.category] } })).ok()).toBe(true)
  }
  seeded.add(project)
}

// The Settings are shared by every test and both themes, so each test leaves the defaults behind (as reports.spec.ts does).
test.afterEach(async ({ request, baseURL }) => {
  const reset = await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title: 'Fernledger' } })
  expect(reset.ok()).toBe(true)
})
// TODO: e2e/report-helpers.ts
const setTitle = async (request: APIRequestContext, baseURL: string | undefined, app_title: string) =>
  expect((await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title } })).ok()).toBe(true)

const address = (from: string, to: string, extra = '') => `/reports/budget-vs-actual?from=${from}&to=${to}${extra}`
const article = (page: Page) => page.getByRole('article', { name: 'Budget vs actual' })
const month = (page: Page, text: string) => article(page).getByRole('region', { name: text })
const tableIn = (region: Locator, text: string) => region.getByRole('table', { name: new RegExp(`^Budget and spending in ${text}`) })
const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('the Reports page offers it with a form of its own that asks for dates and no Account, and opens it in a new window', async ({ page, context }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Budget vs actual' })).toBeVisible()

    const form = page.getByRole('form', { name: 'Budget vs actual' })
    await expect(form.getByLabel('Account')).toHaveCount(0) // a Budget is for all Accounts together
    await expect(form).toContainText('A Budget is for a whole month, so a Report shows every month your dates touch, in full, up to 24 months.')
    await form.getByLabel('From').fill(`${year}-01-01`)
    await form.getByLabel('To').fill(`${year}-06-30`)
    const [popup] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(popup.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible()
    expect(new URL(popup.url()).pathname).toBe('/reports/budget-vs-actual')
    expect(Object.fromEntries(new URL(popup.url()).searchParams)).toEqual({ from: `${year}-01-01`, to: `${year}-06-30` })
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible() // the Reports page is still where it was
  })

  test('its form asks for real dates, in order, touching no more than 24 months, and opens nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    const form = page.getByRole('form', { name: 'Budget vs actual' })
    const open = form.getByRole('button', { name: 'Open Report in a new window' })

    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await form.getByLabel('From').fill('2001-12-31')
    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await form.getByLabel('To').fill('2001-01-01')
    await open.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(form.getByLabel('To')).toHaveAttribute('aria-invalid', 'true')
    await form.getByLabel('From').fill('2001-01-31')
    await form.getByLabel('To').fill('2003-01-01') // 25 months
    await open.click()
    await expect(form.getByRole('alert')).toHaveText('A Budget vs actual Report covers at most 24 months. Choose dates that touch 24 months or fewer.')
    await expect(form.getByLabel('To')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('form', { name: 'Transaction listing' }).getByRole('alert')).toHaveCount(0) // the other forms are untouched
    expect(context.pages()).toHaveLength(1)
  })

  test('an address without dates, with dates the wrong way round, or with too many months explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const [path, words, alert] of [
      ['/reports/budget-vs-actual', 'Choose the first and last dates', false],
      ['/reports/budget-vs-actual?from=2001-12-31&to=2001-01-01', 'before the “From” date', true],
      ['/reports/budget-vs-actual?from=2001-01-31&to=2003-01-01', 'covers at most 24 months', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status')).toContainText(words)
      await expect(page.getByRole('button', { name: 'Open Report in a new window' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without dates it can use
    }
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.addInitScript(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => void ((window as unknown as { printed: number }).printed += 1)
    })
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    await page.getByRole('button', { name: 'Print or save as PDF' }).click()
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// On screen

test.describe('on screen', () => {
  test.beforeEach(async ({ context }) => {
    await context.clock.setFixedTime(NOW) // keeps running; only the date is fixed
  })

  test('has the title block, what the figures mean, the months together, and a section for each month', async ({ page, context, request, baseURL }, testInfo) => {
    const { year, everyday, savings } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))

    const report = article(page)
    await expect(report.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible()
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Account: All Accounts: ') // a Budget is for all Accounts together
    await expect(header).toContainText(`${everyday.name} (${everyday.number})`) // each Account with its bank number
    await expect(header).toContainText(`${savings.name} (${savings.number})`)
    await expect(header).toContainText(`Dates: ${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`)
    await expect(header).toContainText(GENERATED)
    await expect(report.getByText('You chose')).toHaveCount(0) // whole months: nothing to say about the dates

    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('A Budget applies from the month it begins until it is changed or ended, so changing a Budget never alters an earlier month')
    await expect(about).toContainText('Transfers between your own Accounts, Pending Transactions, Income and Loans are not counted.')

    await expect(report.getByRole('heading', { level: 2 })).toHaveText(['About these figures', 'All months together', ...MONTHS.map((m) => monthText(`${year}-${m}`))])
  })

  test('adds the months together: each Category’s Budgets and spending while it had a Budget, the months it was over, and what is outside Budgets', async ({ page, context, baseURL }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))

    const together = article(page).getByRole('region', { name: 'All months together' })
    await expect(together).toContainText(`${monthText(`${year}-01`)} to ${monthText(`${year}-06`)}.`)
    await expect(together.locator('dl')).toContainText('Total Budget')
    await expect(together.locator('dl')).toContainText(money(TOTAL_BUDGET))
    await expect(together.locator('dl')).toContainText('Total spending')
    await expect(together.locator('dl')).toContainText(money(TOTAL_SPENDING)) // not the Transfer, the wages or the loan
    const table = together.getByRole('table', { name: new RegExp(`^Budget and spending from ${monthText(`${year}-01`)} to ${monthText(`${year}-06`)}`) })
    await expect(table.getByRole('columnheader')).toHaveText(['Category', 'Budget', 'Spent', 'Over Budget'])
    await expect(table.locator('tbody tr')).toHaveCount(5)
    await expect(table.locator('tbody tr').nth(0)).toContainText(`${names.cafe}${money(45_000)}${money(19_100)}1 of 3 months`) // January to March, over in March only
    await expect(table.locator('tbody tr').nth(1)).toContainText(`${names.fuel}${money(100_000)}${money(39_000)}1 of 5 months`) // February to June
    await expect(table.locator('tbody tr').nth(2)).toContainText(`${names.groceries}${money(480_000)}${money(257_000)}1 of 6 months`)
    await expect(table.locator('tbody tr').nth(3)).toContainText(`Spending outside BudgetsNo Budget${money(12_000)}Not in a Budget`) // January's fuel and April's cafe
    await expect(table.locator('tbody tr').nth(4)).toContainText(`Uncategorised (includes money in not yet given a Category)No Budget${spent(-766)}Not in a Budget`)
  })

  for (const m of MONTHS) {
    test(`compares ${FULL_MONTHS[Number(m) - 1]} with the Budget it had that month, as the Summary does`, async ({ page, context, baseURL }, testInfo) => {
      const { year, names } = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'member')
      await page.goto(address(`${year}-01-01`, `${year}-06-30`))

      const figures = MONTH_FIGURES[m]!
      const region = month(page, monthText(`${year}-${m}`))
      await expect(region.locator('dl')).toContainText(`Total Budget${money(figures.budget)}`)
      await expect(region.locator('dl')).toContainText(`Total spending${spent(figures.spending)}`)
      const table = tableIn(region, monthText(`${year}-${m}`))
      await expect(table.getByRole('columnheader')).toHaveText(['Category', 'Budget', 'Spent', 'Status'])
      await expect(table.locator('tbody tr')).toHaveCount(figures.rows.length + 2) // the Categories with a Budget that month, and the two that are not in one
      for (const [index, [key, budget, spentCents]] of figures.rows.entries()) {
        const row = table.locator('tbody tr').nth(index)
        await expect(row).toContainText(names[key])
        await expect(row).toContainText(money(budget))
        await expect(row).toContainText(spent(spentCents))
        const left = budget - spentCents
        await expect(row).toContainText(left < 0 ? `Over Budget${money(-left)} over` : left === 0 ? 'On BudgetNothing left' : `Under Budget${money(left)} left`)
        await expect(row.locator('svg[aria-hidden="true"]')).toHaveCount(1) // an icon as well as the words
      }
      const outside = table.locator('tbody tr').nth(figures.rows.length)
      await expect(outside).toContainText('Spending outside Budgets')
      await expect(outside).toContainText(spent(figures.outside))
      await expect(outside).toContainText('Not in a Budget')
      const uncategorised = table.locator('tbody tr').nth(figures.rows.length + 1)
      await expect(uncategorised).toContainText('Uncategorised (includes money in not yet given a Category)')
      await expect(uncategorised).toContainText(spent(figures.uncategorised))
    })
  }

  test('uses the Budget in effect each month: a Category is in the months from the month its Budget is effective, and not in those before it or after it ends', async ({ page, context, baseURL }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))

    await expect(month(page, monthText(`${year}-06`)).getByRole('table')).toBeVisible() // the Report has arrived
    const inMonth = async (m: string) => (await tableIn(month(page, monthText(`${year}-${m}`)), monthText(`${year}-${m}`)).locator('tbody tr td:first-child').allTextContents()).filter((t) => t.startsWith('Budget report'))
    expect(await inMonth('01')).toEqual([names.cafe, names.groceries]) // Fuel's Budget begins in February
    expect(await inMonth('02')).toEqual([names.cafe, names.fuel, names.groceries])
    expect(await inMonth('04')).toEqual([names.fuel, names.groceries]) // Eating out's has ended
    expect(await inMonth('06')).toEqual([names.fuel, names.groceries])
  })

  test('leaves out a Transfer, wages and money lent: April’s $300.00 Transfer and February’s $2,000.00 wages and $500.00 loan are not in any figure', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-02-01`, `${year}-04-30`))

    await expect(month(page, monthText(`${year}-02`)).locator('dl')).toContainText(`Total spending${money(95_000)}`)
    await expect(month(page, monthText(`${year}-04`)).locator('dl')).toContainText(`Total spending${money(16_000)}`)
    const together = article(page).getByRole('region', { name: 'All months together' })
    await expect(together.locator('dl')).toContainText(`Total spending${money(95_000 + 129_100 + 16_000)}`)
  })

  test('says a month with no Budget and no spending has neither, in one sentence', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-07-01`, `${year}-08-31`)) // both Budgets have ended

    const july = month(page, monthText(`${year}-07`))
    await expect(july).toContainText(`No Category has a Budget in ${monthText(`${year}-07`)}, and nothing was spent.`)
    await expect(july.getByRole('table')).toHaveCount(0)
    await expect(article(page).getByRole('region', { name: 'All months together' })).toBeVisible()
    await expect(article(page).getByRole('region', { name: 'All months together' }).getByRole('table').locator('tbody tr')).toHaveCount(2) // only what is not in a Budget
  })

  test('is one month for dates in one month: no months together, only that month', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-03-01`, `${year}-03-31`))

    await expect(article(page).getByRole('heading', { level: 2 })).toHaveText(['About these figures', monthText(`${year}-03`)])
    await expect(article(page).getByRole('region', { name: 'All months together' })).toHaveCount(0)
  })

  test('shows whole months for dates that are part of a month, and says which dates were chosen and which are covered', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-01-15`, `${year}-03-10`))

    const report = article(page)
    await expect(report.locator('header')).toContainText(`Dates: ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`) // what the Report covers
    await expect(report).toContainText(
      `You chose ${dateText(`${year}-01-15`)} to ${dateText(`${year}-03-10`)}. A Budget is for a whole month, so this Report shows every month those dates touch, in full: ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}.`,
    )
    await expect(report.getByRole('heading', { level: 2 })).toHaveText(['About these figures', 'All months together', monthText(`${year}-01`), monthText(`${year}-02`), monthText(`${year}-03`)])
    await expect(page).toHaveTitle(`Fernledger – Budget vs actual – All Accounts – ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`)
    // The whole of March is in, not only the first ten days: its $950.00 of Groceries was spent on the 4th, and Fuel's $210.00 on the 9th.
    await expect(month(page, monthText(`${year}-03`)).locator('dl')).toContainText(`Total spending${money(129_100)}`)
  })

  test('takes no Account: an Account in the address changes nothing', async ({ page, context, baseURL }, testInfo) => {
    const { year, everyday } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(`${year}-01-01`, `${year}-01-31`, '&account=999999999'))

    await expect(article(page).locator('header')).toContainText('Account: All Accounts: ')
    await expect(article(page).locator('header')).toContainText(everyday.name)
    await expect(month(page, monthText(`${year}-01`)).locator('dl')).toContainText(`Total spending${money(86_234)}`)
  })

  test('says a month that is not over yet is not, and a month to come has not begun', async ({ page, context }) => {
    // The Worker decides which month it is now, in New Zealand; the Report asks it, so the test finds out the way budgets.spec.ts does.
    const thisMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)
    await signInAs(context, 'member')

    await page.goto(address(`${thisMonth}-01`, `${thisMonth}-28`))
    await expect(month(page, monthText(thisMonth))).toContainText('This month is not over yet, so what has been spent so far is compared with the whole month’s Budget.')

    await page.goto(address('2100-01-01', '2100-01-31'))
    await expect(month(page, 'January 2100')).toContainText('This month has not begun, so nothing has been spent yet.')
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}, with every kind of row and status on it`, async ({ page, context, baseURL }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, role)
      await page.goto(address(`${year}-01-15`, `${year}-06-30`)) // part of a month, so the notice is on it too
      await expect(article(page).getByRole('table').first()).toBeVisible()
      await expect(article(page).getByText('Over Budget').first()).toBeVisible()
      await expect(article(page).getByText('Under Budget').first()).toBeVisible()
      await expect(article(page).getByText('Not in a Budget').first()).toBeVisible()
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    const cards = month(page, monthText(`${year}-01`)).getByRole('list', { name: /^Budget and spending in January/ }).getByRole('listitem')
    await expect(cards).toHaveCount(4) // two Categories with a Budget, and the two that are not in one
    await expect(cards.first()).toContainText(names.cafe)
    await expect(cards.first()).toContainText(money(15_000))
    await expect(cards.first()).toContainText('Status')
    await expect(article(page).getByRole('region', { name: 'All months together' }).getByRole('listitem').first()).toContainText('Over Budget')
  })

  test.describe('when the request fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: figures that were not read never look like a month with nothing in it', async ({ page, context }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      await signInAs(context, 'member')
      await page.route('**/api/reports/budget-vs-actual?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(address(`${year}-01-01`, `${year}-06-30`))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Printed

test.describe('printed', () => {
  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    await expect(article(page).getByRole('table').first()).toBeVisible()
  })

  const range = (year: number) => `${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
    await expect(page.getByRole('link')).toHaveCount(0)
    await expect(page.getByText('In the print window')).toBeHidden()
  })

  test('writes its own title block: the app title, the Report, the Accounts, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const { year, everyday } = dataFor(testInfo.project.name)
    const header = article(page).locator('header')
    await expect(header).toBeVisible()
    await expect(header.getByText(TITLE, { exact: true })).toBeVisible() // the Admin's words, as typed
    await expect(header.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible()
    await expect(header).toContainText(`${everyday.name} (${everyday.number})`)
    await expect(header).toContainText(`Dates: ${range(year)}`)
    await expect(header.getByText(GENERATED, { exact: true })).toBeVisible()
  })

  test('puts the same identifying lines in every table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const tables = article(page).getByRole('table')
    expect(await tables.count()).toBe(7) // the months together, and six months
    for (let i = 0; i < 7; i++) {
      const identity = tables.nth(i).locator('thead tr').first()
      await expect(identity).toBeVisible() // on screen it is not
      await expect(identity).toContainText(`${TITLE} – Budget vs actual – All Accounts – ${range(year)}`)
      await expect(identity).toContainText(GENERATED)
      // It is one of the table's heading rows, with the column headings: that is what makes a browser repeat it.
      expect(await tables.nth(i).locator('thead').evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
    }
  })

  test('names the page for Save as PDF: the app, the Report, the Accounts and the dates', async ({ page }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Budget vs actual – All Accounts – ${range(year)}`)
  })

  /** Every word of the Report is black, including the muted ones, the money and an over-Budget status, and the paper is white. */
  // TODO: e2e/report-helpers.ts
  const blackOnWhite = (page: Page) =>
    page.evaluate(() => {
      const rgb = (css: string) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.fillStyle = '#fff'
        ctx.fillStyle = css
        ctx.fillRect(0, 0, 1, 1)
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
      }
      const walker = document.createTreeWalker(document.querySelector('.report-frame')!, NodeFilter.SHOW_TEXT)
      const unreadable: string[] = []
      let texts = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        texts += 1
        const [r, g, b] = rgb(getComputedStyle(node.parentElement!).color)
        if (Math.max(r!, g!, b!) > 40) unreadable.push(`${node.textContent.trim().slice(0, 30)}: rgb(${r}, ${g}, ${b})`)
      }
      return { unreadable, paper: rgb(getComputedStyle(document.body).backgroundColor), texts }
    })

  test('is black text on white paper, even from the dark theme, and an over-Budget status is black too', async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expect(article(page).getByText('Over Budget').first()).toBeVisible()
    const printed = await blackOnWhite(page)
    expect(printed.texts).toBeGreaterThan(100)
    expect(printed.unreadable).toEqual([]) // every word, including the muted ones, the money and the statuses, is black
    expect(Math.min(...printed.paper)).toBeGreaterThan(240)
  })

  test('has no text under 12pt', async ({ page }) => {
    const small = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.report-frame')!, NodeFilter.SHOW_TEXT)
      const found: string[] = []
      let texts = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        texts += 1
        const size = parseFloat(getComputedStyle(node.parentElement!).fontSize)
        if (size < 16) found.push(`${size}px: ${node.textContent.trim().slice(0, 30)}`)
      }
      return { found, texts }
    })
    expect(small.texts).toBeGreaterThan(100)
    expect(small.found).toEqual([]) // 12pt is 16px
    // The table's own text is set to 12pt, not left to the 15px it has on screen.
    const cell = await article(page).locator('tbody td').first().evaluate((el) => getComputedStyle(el).fontSize)
    expect(parseFloat(cell)).toBeGreaterThanOrEqual(16)
  })

  test('is its own page with its own margins, repeats table headings and keeps a row whole', async ({ page }) => {
    const styles = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
      return { page: style('.report-frame').page, thead: style('thead').display, row: style('tbody tr').breakInside, main: style('main').paddingLeft }
    })
    expect(styles).toEqual({ page: 'report', thead: 'table-header-group', row: 'avoid', main: '0px' })
  })

  test('is several A4 pages with the table headings on every page that has rows, and no row lost, repeated or cut across pages', async ({ page }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(3)
    const withRows = pages.filter((p) => /Under Budget|Over Budget|Not in a Budget/.test(textOf(p)))
    expect(withRows.length).toBeGreaterThanOrEqual(3)

    // Headings come back on every page the tables run onto, not only the first.
    for (const p of withRows) for (const heading of ['Category', 'Budget', 'Spent']) expect(p.text.map((t) => t.str), `${heading} on page ${pages.indexOf(p) + 1}`).toContain(heading)

    // Every month is a section of its own that is there once, and every row of it is on a page once: its Category, its Budget and what it spent. Two months can
    // have the same row (May and June are alike), so a row is expected as many times as the months have it; the months together has its own sums.
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    const expected = new Map<string, number>()
    for (const m of MONTHS) {
      const label = monthText(`${year}-${m}`)
      expect(pages.flatMap((p) => p.text).filter((t) => t.str === label), label).toHaveLength(1)
      for (const [key, budget, spentCents] of MONTH_FIGURES[m]!.rows) {
        const row = `${names[key]} ${money(budget)} ${spent(spentCents)}`
        expected.set(row, (expected.get(row) ?? 0) + 1)
      }
    }
    for (const [row, count] of expected) expect(all.split(row).length - 1, row).toBe(count)
    expect(expected.size).toBeGreaterThan(10)
    expect(pages.flatMap((p) => p.text).filter((t) => t.str === 'All months together')).toHaveLength(1) // the months together come once, before the months
    expect(all).toContain('1 of 6 months') // and a Category's months over Budget is in them
  })

  test('numbers every page "Page 2 of 5" in the bottom margin', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const margin = (20 / 25.4) * 72 // the bottom margin, 20mm, in points
    pages.forEach((p, index) => {
      const numbered = p.text.filter((t) => t.str === `Page ${index + 1} of ${pages.length}`)
      expect(numbered, `page ${index + 1}`).toHaveLength(1)
      expect(numbered[0]!.y).toBeLessThan(margin)
    })
  })

  test('says what the Report is, which Accounts and dates, and who generated it and when, at the top of every page the tables run onto', async ({ page }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const withRows = pages.filter((p) => /Under Budget|Over Budget|Not in a Budget/.test(textOf(p)))
    expect(withRows.length).toBeGreaterThanOrEqual(3)
    // In each page's own body, not its margins, so every browser prints it. The Admin's title comes through as typed, quote and backslash too.
    // (The line may wrap, so the comparison ignores where it broke.)
    // TODO: e2e/report-helpers.ts
    const squash = (text: string) => text.replace(/\s+/g, '')
    for (const p of withRows) {
      const text = squash(textOf(p))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(`${TITLE} – Budget vs actual – All Accounts – ${range(year)}`))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(GENERATED))
    }
  })

  test('has nothing in the top margin and only the page number in the bottom one', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    for (const [index, p] of pages.entries()) {
      expect(p.text.filter((t) => t.y > p.height - (18 / 25.4) * 72), `top margin of page ${index + 1}`).toEqual([])
      expect(p.text.filter((t) => t.y < (20 / 25.4) * 72).map((t) => t.str), `bottom margin of page ${index + 1}`).toEqual([`Page ${index + 1} of ${pages.length}`])
    }
  })

  test('sets every word of it, the page numbers and the statuses included, in at least 12pt type', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const small = pages.flatMap((p, index) => p.text.filter((t) => t.size < 11.95).map((t) => `page ${index + 1}: ${t.size}pt "${t.str}"`))
    expect(small).toEqual([])
    expect(pages.flatMap((p) => p.text).length).toBeGreaterThan(300)
  })

  test('prints the same from a phone-width window: still tables', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(article(page).getByRole('table').first()).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })

  test('says a month is part way on paper too, and a part-month request, so a printout never claims more than it covers', async ({ page }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await page.goto(address(`${year}-02-10`, `${year}-03-31`))
    await expect(article(page).getByRole('table').first()).toBeVisible()
    await expect(article(page)).toContainText(`You chose ${dateText(`${year}-02-10`)} to ${dateText(`${year}-03-31`)}.`)
    const notice = article(page).getByText('You chose')
    expect(await notice.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid') // a box, not only a colour
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Around the Report

test.describe('around the Report', () => {
  test('is titled for Save as PDF while it is open, and goes back to the app title when it is left', async ({ page, context, request, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    await expect(page).toHaveTitle(`Mum's finances – Budget vs actual – All Accounts – ${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })

  test('shows every Member the same Report as the Admin', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['member', 'admin'] as const) {
      await signInAs(context, role)
      await page.goto(address(`${year}-01-01`, `${year}-06-30`))
      await expect(article(page).getByRole('region', { name: 'All months together' }).getByRole('table')).toBeVisible()
      seen.push((await article(page).getByRole('table').locator('tbody tr').allTextContents()).join('|'))
    }
    expect(seen[0]).toBe(seen[1])
  })
})
