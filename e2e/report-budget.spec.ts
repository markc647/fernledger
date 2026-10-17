import type { BrowserContext, Locator, Page } from '@playwright/test'
import { dateField, pickDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { expectTableLook } from './table-look-helpers'
import { openHelp } from './help-helpers'
import { readPdf, textOf } from './pdf-text'
import {
  dateText,
  ensureCategory,
  expectBareMargins,
  expectBlackOnWhite,
  expectIdentityOnEveryPage,
  expectJustTheReport,
  expectNoTextUnder12pt,
  expectNoTypeUnder12pt,
  expectOwnPage,
  expectPageNumbers,
  expectTitleBlock,
  forgetKeptReportsAfterEach,
  GENERATED,
  importRows,
  money,
  NOT_COUNTED,
  NOW,
  overrideCategories,
  restoreAppTitleAfterEach,
  setTitle,
  signInToOpen,
  spent,
  squash,
  TITLE,
  UNCATEGORISED,
  type SeedRow,
} from './report-helpers'

// Ticket 21: the Budget vs actual Report (spec story 94). It uses the Report frame of ticket 18, so it is shown on its own page, under its form, says on its face what it is,
// and prints with its table headings on every page. The Report's numbers are held to the Summary's Budget vs actual and to Spending in
// worker/report-budget.test.ts; this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it makes
// (page count, the text on each page, the margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2001 and 2000, before every other spec's:
// the Dashboard has 2004 and the Spending by Category Report 2002 and 2003). The Report is of all Accounts, so it lists what other specs made too, but they have
// nothing in these years and no Budget reaches back to them.
//
// A year's worth of everything the Report has to get right, January to June:
// - Coffee has $150.00 from January, ended from April; Petrol has $200.00 from February, changed to $250.00 from May; Supermarket has $800.00 from January.
//   Petrol and Supermarket are ended from July, so the Budgets do not reach the months other specs use;
// - Petrol in January has no Budget yet and Coffee in April has none any more, so that spending is outside Budgets;
// - February has a refund, wages ($2,000.00, Income) and money lent ($500.00, Loans); March has money in with no Category, so Uncategorised is below zero;
// - April has a Transfer of $300.00 between the two Accounts, which is neither spending nor income.
// Payees avoid "EXAMPLE", which other specs' Rules look for.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  return {
    project,
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

const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthText = (month: string) => `${FULL_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
const two = (n: number) => String(n).padStart(2, '0')

const everydayRows = (project: string): (SeedRow & { tag: string })[] => {
  const { year, names } = dataFor(project)
  const d = (month: number, day: number) => `${year}-${two(month)}-${two(day)}`
  const row = (tag: string, date: string, amountCents: number, category?: keyof Names) => ({ tag, date, payee: `BUDGETRPT ${project} ${tag}`, amountCents, category: category && names[category] })
  return [
    row('G1', d(1, 5), -70_000, 'groceries'),
    row('G2', d(1, 20), -5_000, 'groceries'),
    row('F1', d(1, 12), -6_000, 'fuel'),
    row('C1', d(1, 15), -4_000, 'cafe'),
    row('U1', d(1, 25), -1_234),
    row('G3', d(2, 3), -80_000, 'groceries'),
    row('G4', d(2, 17), 3_000, 'groceries'),
    row('F2', d(2, 10), -18_000, 'fuel'),
    row('W1', d(2, 14), 200_000, 'wages'),
    row('L1', d(2, 20), -50_000, 'loan'),
    row('G5', d(3, 4), -95_000, 'groceries'),
    row('F3', d(3, 9), -21_000, 'fuel'),
    row('C2', d(3, 12), -15_100, 'cafe'),
    row('U2', d(3, 30), 2_000),
    row('G6', d(4, 2), -10_000, 'groceries'),
    row('C3', d(4, 8), -6_000, 'cafe'),
    row('T1', d(4, 15), -30_000), // the Transfer's first half
  ]
}

// The months, as the Report should show them, worked out by hand from the rows above: the Budgets added up, what the Categories with a Budget spent, and all
// the spending, and the rows with a Budget that month (Category, Budget, spent), what is outside Budgets and Uncategorised.
type Figures = { budget: number; budgeted: number; spending: number; rows: [keyof Names, number, number][]; outside: number; uncategorised: number; changed?: keyof Names }
const MONTHS = ['01', '02', '03', '04', '05', '06']
const MONTH_FIGURES: Record<string, Figures> = {
  '01': { budget: 95_000, budgeted: 79_000, spending: 86_234, rows: [['cafe', 15_000, 4_000], ['groceries', 80_000, 75_000]], outside: 6_000, uncategorised: 1_234 },
  '02': { budget: 115_000, budgeted: 95_000, spending: 95_000, rows: [['cafe', 15_000, 0], ['fuel', 20_000, 18_000], ['groceries', 80_000, 77_000]], outside: 0, uncategorised: 0 },
  '03': { budget: 115_000, budgeted: 131_100, spending: 129_100, rows: [['cafe', 15_000, 15_100], ['fuel', 20_000, 21_000], ['groceries', 80_000, 95_000]], outside: 0, uncategorised: -2_000 },
  '04': { budget: 100_000, budgeted: 10_000, spending: 16_000, rows: [['fuel', 20_000, 0], ['groceries', 80_000, 10_000]], outside: 6_000, uncategorised: 0 },
  '05': { budget: 105_000, budgeted: 0, spending: 0, rows: [['fuel', 25_000, 0], ['groceries', 80_000, 0]], outside: 0, uncategorised: 0, changed: 'fuel' },
  '06': { budget: 105_000, budgeted: 0, spending: 0, rows: [['fuel', 25_000, 0], ['groceries', 80_000, 0]], outside: 0, uncategorised: 0 },
}
const TOTAL = { budget: 635_000, budgeted: 315_100, spending: 326_334, outside: 12_000, uncategorised: -766 }
/** Where Budgets stand against what the Categories with a Budget spent: the words and what is left or over, as a row's Status says them. */
const standing = (budget: number, budgeted: number) => (budget - budgeted < 0 ? { words: 'Over Budget', detail: `${money(budgeted - budget)} over` } : budget === budgeted ? { words: 'On Budget', detail: 'Nothing left' } : { words: 'Under Budget', detail: `${money(budget - budgeted)} left` })

const seeded = new Set<string>()

/** The project's Categories, Budgets, two Accounts and their Transactions. Safe to repeat: a Category, a Budget, an Import and an Override that are already there are left as they are. */
async function seed(context: BrowserContext, baseURL: string, project: string) {
  if (seeded.has(project)) return
  const { year, everyday, savings, names } = dataFor(project)
  await signInAs(context, 'admin')
  const categories: Record<string, number> = {
    [names.groceries]: await ensureCategory(context, baseURL, names.groceries, 'spending'),
    [names.fuel]: await ensureCategory(context, baseURL, names.fuel, 'spending'),
    [names.cafe]: await ensureCategory(context, baseURL, names.cafe, 'spending'),
    [names.wages]: await ensureCategory(context, baseURL, names.wages, 'income'),
    [names.loan]: await ensureCategory(context, baseURL, names.loan, 'loans'),
  }
  const budget = async (name: keyof Names, month: string, amountCents: number | null) =>
    expect((await context.request.put(`/api/budgets/${categories[names[name]]}`, { headers: { Origin: baseURL }, data: { effectiveFrom: `${year}-${month}`, amountCents } })).ok()).toBe(true)
  await budget('groceries', '01', 80_000)
  await budget('groceries', '07', null)
  await budget('fuel', '02', 20_000)
  await budget('fuel', '05', 25_000)
  await budget('fuel', '07', null)
  await budget('cafe', '01', 15_000)
  await budget('cafe', '04', null)

  const rows = everydayRows(project)
  const savingsRows: SeedRow[] = [{ date: `${year}-04-15`, payee: `BUDGETRPT ${project} T2`, amountCents: 30_000 }] // the Transfer's other half, imported second so the two are paired
  await importRows(context, baseURL, { account: everyday, year, rows, idPrefix: `BR${year}E` })
  await importRows(context, baseURL, { account: savings, year, rows: savingsRows, idPrefix: `BR${year}S` })
  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  await overrideCategories(context, baseURL, { accountId: accounts.find((a) => a.name === everyday.name)!.id, year, rows, categories })
  seeded.add(project)
}

restoreAppTitleAfterEach() // the Settings are shared by every test and both themes (as reports.spec.ts does)
forgetKeptReportsAfterEach() // so is the list of kept Reports, which the Admin showing a Report adds to

const address = (from: string, to: string, extra = '') => `/reports/budget-vs-actual?from=${from}&to=${to}${extra}`
const article = (page: Page) => page.getByRole('article', { name: 'Budget vs actual' })
const month = (page: Page, text: string) => article(page).getByRole('region', { name: text })
const together = (page: Page) => article(page).getByRole('region', { name: 'All months together' })
/** Words only a row of a table has: the name of one of the spec's Categories. The About and the totals say none, so a page with them and no row is not taken for one with rows. */
const rowsMarker = (names: Names) => new RegExp(Object.values(names).join('|'))
const tableIn = (region: Locator, text: string) => region.getByRole('table', { name: new RegExp(`^Budget and spending in ${text}`) })

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('its page has a form of its own that asks for dates and no Account and shows the Report under it', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto('/reports/budget-vs-actual')
    await expect(page.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible()

    const form = page.getByRole('form', { name: 'Budget vs actual' })
    await expect(form.getByLabel('Account')).toHaveCount(0) // a Budget is for all Accounts together
    await expect(form).not.toContainText('A Budget is for a whole month') // the form's note is in the page's help sheet
    await expect(await openHelp(page)).toContainText('A Budget is for a whole month, so a Report shows every month your dates touch, in full, up to 24 months.')
    await page.keyboard.press('Escape')
    await pickDate(form, 'From', `${year}-01-01`)
    await pickDate(form, 'To', `${year}-06-30`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/reports/budget-vs-actual')
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ from: `${year}-01-01`, to: `${year}-06-30` })
  })

  test('its form asks for real dates, in order, touching no more than 24 months, and shows nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/budget-vs-actual')
    const form = page.getByRole('form', { name: 'Budget vs actual' })
    const show = form.getByRole('button', { name: 'Show Report' })

    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await pickDate(form, 'From', '2001-12-31')
    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await pickDate(form, 'To', '2001-01-01')
    await show.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(dateField(form, 'To')).toHaveAttribute('aria-invalid', 'true')
    await pickDate(form, 'From', '2001-01-31')
    await pickDate(form, 'To', '2003-01-01') // 25 months
    await show.click()
    await expect(form.getByRole('alert')).toHaveText('A Budget vs actual Report covers at most 24 months. Choose dates that touch 24 months or fewer.')
    await expect(dateField(form, 'To')).toHaveAttribute('aria-invalid', 'true')
    expect(new URL(page.url()).search).toBe('')
    await expect(article(page)).toHaveCount(0)
  })

  test('an address with only some dates, dates the wrong way round, or too many months explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'admin')
    for (const [path, words, alert] of [
      ['/reports/budget-vs-actual?from=2001-01-01', 'Choose the first and last dates', false],
      ['/reports/budget-vs-actual?from=2001-12-31&to=2001-01-01', 'before the “From” date', true],
      ['/reports/budget-vs-actual?from=2001-01-31&to=2003-01-01', 'covers at most 24 months', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status').filter({ hasText: words })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Show Report' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without dates it can use
    }
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
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
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))

    const report = article(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Budget vs actual' })).toBeVisible() // the page's heading, above the form: the Report's own title is text on screen and the h1 on paper
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Account: All Accounts: ') // a Budget is for all Accounts together
    await expect(header).toContainText(`${everyday.name} (${everyday.number})`) // each Account with its bank number
    await expect(header).toContainText(`${savings.name} (${savings.number})`)
    await expect(header).toContainText(`Dates: ${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`)
    await expect(header).toContainText(GENERATED)
    await expect(report.getByText('You chose')).toHaveCount(0) // whole months: nothing to say about the dates

    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('Each month is compared with the Budget in effect for it.')
    await expect(about).toContainText('A Budget applies from the month it begins until it is changed or ended, so changing a Budget never alters an earlier month')
    await expect(about).toContainText('Where a Category\'s Budget changes, its row says so.')
    await expect(about).toContainText("A refund comes off what a Category spent, so what's left can be more than the Budget")
    await expect(about).toContainText('a Category\'s spending in a month it has no Budget is in Spending outside Budgets')
    await expect(about).toContainText(NOT_COUNTED)
    await expect(about).toContainText('Categories are taken as they are now. A Category that has since been made Income or Loans, or removed, is out of every month shown, past ones too')

    await expect(report.getByRole('heading', { level: 2 })).toHaveText(['About these figures', 'All months together', ...MONTHS.map((m) => monthText(`${year}-${m}`))])
  })

  test('adds the months that have ended together: each Category’s Budgets and spending while it had a Budget, the months it was over, and what is outside Budgets', async ({ page, context, baseURL }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))

    const section = together(page)
    // Which months, and why: all six have ended.
    await expect(section).toContainText(`These figures cover ${monthText(`${year}-01`)} to ${monthText(`${year}-06`)}, the 6 months that have ended.`)
    await expect(section).not.toContainText('left out of these figures')
    const net = standing(TOTAL.budget, TOTAL.budgeted)
    await expect(section.locator('dl')).toContainText(`Total Budget${money(TOTAL.budget)}`)
    await expect(section.locator('dl')).toContainText(`Spent in Categories with a Budget${money(TOTAL.budgeted)}`)
    await expect(section.locator('dl')).toContainText(`Against the Budgets${net.words}${net.detail}`) // like for like: not the Transfer, the wages or the loan, and not what is outside Budgets
    await expect(section.locator('dl')).toContainText('Months the Budgets together were over1 of 6 months') // March, when the Budgets together were overspent
    await expect(section.locator('dl')).toContainText(`Total spending${money(TOTAL.spending)}`)
    await expect(section.locator('dl dt').first()).toHaveCSS('font-weight', '600')
    const table = section.getByRole('table', { name: new RegExp(`^Budget and spending in the months that have ended from ${monthText(`${year}-01`)} to ${monthText(`${year}-06`)}`) })
    await expect(table.getByRole('columnheader')).toHaveText(['Category', 'Budget', 'Spent', 'Months over Budget'])
    await expectTableLook(table)
    await expect(table.locator('tbody tr')).toHaveCount(5)
    await expect(table.locator('tbody tr').nth(0)).toContainText(`${names.cafe}${money(45_000)}${money(19_100)}1 of 3 months`) // January to March, over in March only
    await expect(table.locator('tbody tr').nth(1)).toContainText(`${names.fuel}${money(110_000)}${money(39_000)}1 of 5 months`) // February to April at $200.00, May and June at $250.00
    await expect(table.locator('tbody tr').nth(2)).toContainText(`${names.groceries}${money(480_000)}${money(257_000)}1 of 6 months`)
    await expect(table.locator('tbody tr').nth(3)).toContainText(`Spending outside BudgetsNo Budget${money(TOTAL.outside)}–Not in a Budget`) // January's petrol and April's coffee
    await expect(table.locator('tbody tr').nth(4)).toContainText(`${UNCATEGORISED}No Budget${spent(TOTAL.uncategorised)}–Not in a Budget`)
  })

  for (const m of MONTHS) {
    test(`compares ${FULL_MONTHS[Number(m) - 1]} with the Budget it had that month, as the Summary does`, async ({ page, context, baseURL }, testInfo) => {
      const { year, names } = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'admin')
      await page.goto(address(`${year}-01-01`, `${year}-06-30`))

      const figures = MONTH_FIGURES[m]!
      const region = month(page, monthText(`${year}-${m}`))
      const net = standing(figures.budget, figures.budgeted)
      await expect(region.locator('dl')).toContainText(`Total Budget${money(figures.budget)}`)
      await expect(region.locator('dl')).toContainText(`Spent in Categories with a Budget${spent(figures.budgeted)}`)
      await expect(region.locator('dl')).toContainText(`Against the Budgets${net.words}${net.detail}`)
      await expect(region.locator('dl')).toContainText(`Total spending${spent(figures.spending)}`)
      await expect(region.locator('dl')).not.toContainText('Months the Budgets together were over') // a month has one standing; the months together count them
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
        // Where a Budget changes inside the Report, the row says so, in the month it changes and in no other.
        if (figures.changed === key) await expect(row).toContainText(`Budget changed from ${monthText(`${year}-${m}`)}`)
        else await expect(row).not.toContainText('Budget changed from')
      }
      const outside = table.locator('tbody tr').nth(figures.rows.length)
      await expect(outside).toContainText('Spending outside Budgets')
      await expect(outside).toContainText(spent(figures.outside))
      await expect(outside).toContainText('Not in a Budget')
      const uncategorised = table.locator('tbody tr').nth(figures.rows.length + 1)
      await expect(uncategorised).toContainText(UNCATEGORISED)
      await expect(uncategorised).toContainText(spent(figures.uncategorised))
    })
  }

  test('uses the Budget in effect each month: a Category is in the months from the month its Budget is effective, and not in those before it or after it ends', async ({ page, context, baseURL }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))

    await expect(month(page, monthText(`${year}-06`)).getByRole('table')).toBeVisible() // the Report has arrived
    const ours = Object.values(names)
    /** Our Categories that have a row in the month, in the table's order (a row may say under its name that the Budget changed). */
    const inMonth = async (m: string) => {
      const cells = await tableIn(month(page, monthText(`${year}-${m}`)), monthText(`${year}-${m}`)).locator('tbody tr td:first-child').allTextContents()
      return cells.flatMap((cell) => ours.find((name) => cell.startsWith(name)) ?? [])
    }
    expect(await inMonth('01')).toEqual([names.cafe, names.groceries]) // Petrol's Budget begins in February
    expect(await inMonth('02')).toEqual([names.cafe, names.fuel, names.groceries])
    expect(await inMonth('04')).toEqual([names.fuel, names.groceries]) // Coffee's has ended
    expect(await inMonth('06')).toEqual([names.fuel, names.groceries])
  })

  test('leaves out a Transfer, wages and money lent: April’s $300.00 Transfer and February’s $2,000.00 wages and $500.00 loan are not in any figure', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-02-01`, `${year}-04-30`))

    await expect(month(page, monthText(`${year}-02`)).locator('dl')).toContainText(`Total spending${money(95_000)}`)
    await expect(month(page, monthText(`${year}-04`)).locator('dl')).toContainText(`Total spending${money(16_000)}`)
    await expect(together(page).locator('dl')).toContainText(`Total spending${money(95_000 + 129_100 + 16_000)}`)
  })

  test('says once at the top that no Category has a Budget, and not for each month, when none has', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-07-01`, `${year}-08-31`)) // both Budgets have ended

    const report = article(page)
    await expect(report.getByText('No Category has a Budget in these months, so all of the spending is outside Budgets.')).toHaveCount(1)
    for (const m of ['07', '08']) {
      const region = month(page, monthText(`${year}-${m}`))
      await expect(region).toContainText(`Nothing was spent in ${monthText(`${year}-${m}`)}.`)
      await expect(region.getByRole('table')).toHaveCount(0)
      await expect(region).not.toContainText('No Category has a Budget in')
    }
    const section = together(page)
    await expect(section).toContainText(`These figures cover ${monthText(`${year}-07`)} to ${monthText(`${year}-08`)}, the 2 months that have ended.`)
    await expect(section.locator('dl')).not.toContainText('Total Budget') // without a Budget there is nothing to set the spending against
    await expect(section.getByRole('table').locator('tbody tr')).toHaveCount(2) // only what is not in a Budget
  })

  test('says a month in a Report that has Budgets elsewhere has no Budget, in one sentence with whether anything was spent', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-06-01`, `${year}-08-31`)) // June has Budgets; July and August have none and nothing spent

    await expect(article(page).getByText('No Category has a Budget in these months')).toHaveCount(0) // June has
    await expect(month(page, monthText(`${year}-07`))).toContainText(`No Category has a Budget in ${monthText(`${year}-07`)}, and nothing was spent.`)
    await expect(month(page, monthText(`${year}-07`)).getByRole('table')).toHaveCount(0)
  })

  test('is one month for dates in one month: no months together, only that month', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-03-01`, `${year}-03-31`))

    await expect(article(page).getByRole('heading', { level: 2 })).toHaveText(['About these figures', monthText(`${year}-03`)])
    await expect(together(page)).toHaveCount(0)
  })

  test('shows whole months for dates that are part of a month, and says which dates were chosen and which are covered', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-01-15`, `${year}-03-10`))

    const report = article(page)
    await expect(report.locator('header')).toContainText(`Dates: ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`) // what the Report covers
    await expect(report).toContainText(
      `You chose ${dateText(`${year}-01-15`)} to ${dateText(`${year}-03-10`)}. A Budget is for a whole month, so this Report shows every month those dates touch, in full: ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}.`,
    )
    await expect(report.getByRole('heading', { level: 2 })).toHaveText(['About these figures', 'All months together', monthText(`${year}-01`), monthText(`${year}-02`), monthText(`${year}-03`)])
    await expect(page).toHaveTitle(`Fernledger – Budget vs actual – All Accounts – ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`)
    // The whole of March is in, not only the first ten days: its $950.00 of Supermarket was spent on the 4th, and Petrol's $210.00 on the 9th.
    await expect(month(page, monthText(`${year}-03`)).locator('dl')).toContainText(`Total spending${money(129_100)}`)
  })

  test('takes no Account: an Account in the address changes nothing', async ({ page, context, baseURL }, testInfo) => {
    const { year, everyday } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-01-01`, `${year}-01-31`, '&account=999999999'))

    await expect(article(page).locator('header')).toContainText('Account: All Accounts: ')
    await expect(article(page).locator('header')).toContainText(everyday.name)
    await expect(month(page, monthText(`${year}-01`)).locator('dl')).toContainText(`Total spending${money(86_234)}`)
  })

  test('labels the months the Budgets together were over apart from the months a Category was over, because they can differ', async ({ page, context }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    // Nine months. Stub category has $10.00 and is over in January, March and May; Big one has $1,000.00 and spends nothing, so the Budgets together are never over.
    const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => {
      const spentCents = ['01', '03', '05'].includes(m) ? 1_500 : 500
      return {
        month: `${year}-${m}`,
        state: 'ended',
        rows: [
          { categoryId: 1, categoryName: 'Big one', budgetCents: 100_000, spentCents: 0, effectiveFrom: `${year}-01`, changed: false },
          { categoryId: 2, categoryName: 'Stub category', budgetCents: 1_000, spentCents, effectiveFrom: `${year}-01`, changed: false },
        ],
        otherCents: 0,
        uncategorisedCents: 0,
        budgetCents: 101_000,
        budgetedSpentCents: spentCents,
        spentCents,
      }
    })
    await signInAs(context, 'admin')
    await page.route('**/api/reports/budget-vs-actual?**', (route) =>
      route.fulfill({
        json: {
          from: `${year}-01-01`,
          to: `${year}-09-30`,
          covers: { from: `${year}-01-01`, to: `${year}-09-30` },
          months,
          together: { first: `${year}-01`, last: `${year}-09`, months: 9 },
          total: { budgetCents: 909_000, budgetedSpentCents: 7_500, spentCents: 7_500, otherCents: 0, uncategorisedCents: 0, budgetMonths: 9, overMonths: 0 },
          categories: [
            { categoryId: 1, categoryName: 'Big one', months: 9, overMonths: 0, budgetCents: 900_000, spentCents: 0 },
            { categoryId: 2, categoryName: 'Stub category', months: 9, overMonths: 3, budgetCents: 9_000, spentCents: 7_500 },
          ],
        },
      }),
    )
    await page.goto(address(`${year}-01-01`, `${year}-09-30`))

    const section = together(page)
    await expect(section.locator('dl')).toContainText('Months the Budgets together were over0 of 9 months')
    await expect(section.locator('dl')).not.toContainText('Months over Budget') // that is the table's column, a Category at a time
    const table = section.getByRole('table')
    await expect(table.getByRole('columnheader').last()).toHaveText('Months over Budget')
    await expect(table.locator('tbody tr').filter({ hasText: 'Stub category' })).toContainText('3 of 9 months')
    await expect(table.locator('tbody tr').filter({ hasText: 'Big one' })).toContainText('0 of 9 months')
  })

  test('leaves the month it is now and the months to come out of the months together, says so and why, and still shows each', async ({ page, context }) => {
    // The Worker decides which month it is now, in New Zealand; the Report asks it, so the test finds out the way budgets.spec.ts does.
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)
    const around = (by: number) => {
      const index = Number(now.slice(0, 4)) * 12 + Number(now.slice(5, 7)) - 1 + by
      return `${Math.floor(index / 12)}-${two((index % 12) + 1)}`
    }
    const [before, next] = [around(-1), around(1)]
    await signInAs(context, 'admin')

    await page.goto(address(`${before}-01`, `${next}-28`))
    const section = together(page)
    await expect(section).toContainText(
      `These figures are for ${monthText(before)}, the one month that has ended. ${monthText(now)} is not over yet, so part of its spending would be set against the whole of its Budget. ` +
        `${monthText(next)} has not begun, so its Budget would be set against no spending at all. They are left out of these figures, and shown on their own below.`,
    )
    await expect(month(page, monthText(now))).toContainText('This month is not over yet, so what has been spent so far is compared with the whole month’s Budget. It is not in the months together.')
    await expect(month(page, monthText(next))).toContainText('This month has not begun, so nothing has been spent yet. It is not in the months together.')
    await expect(month(page, monthText(before))).not.toContainText('It is not in the months together')

    // With no month ended there is nothing to add together, and the months are still there.
    await page.goto(address(`${now}-01`, `${next}-28`))
    await expect(together(page)).toContainText('No month in these dates has ended, so there is nothing to add together yet.')
    await expect(together(page).getByRole('table')).toHaveCount(0)
    await expect(together(page).locator('dl')).toHaveCount(0)
    await expect(month(page, monthText(now))).toBeVisible()
    await expect(month(page, monthText(next))).toBeVisible()

    // A month to come far off, in a Report of its own.
    await page.goto(address('2100-01-01', '2100-01-31'))
    await expect(month(page, 'January 2100')).toContainText('This month has not begun, so nothing has been spent yet. It is not in the months together.')
  })

  for (const role of ['admin', 'member'] as const) {
    test(`has no WCAG 2.2 AA violations as ${role === 'admin' ? 'the Admin' : 'a Member, who opens the Report the Admin kept'}, with every kind of row and status on it`, async ({ page, context, baseURL }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInToOpen(context, baseURL, role, { report: 'budget-vs-actual', from: `${year}-01-15`, to: `${year}-06-30` })
      await page.goto(address(`${year}-01-15`, `${year}-06-30`)) // part of a month, so the notice is on it too
      await expect(article(page).getByRole('table').first()).toBeVisible()
      await expect(article(page).getByText('Over Budget').first()).toBeVisible()
      await expect(article(page).getByText('Under Budget').first()).toBeVisible()
      await expect(article(page).getByText('Not in a Budget').first()).toBeAttached()
      await expect(article(page).getByText('Budget changed from').first()).toBeVisible()
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    const cards = month(page, monthText(`${year}-01`)).getByRole('list', { name: /^Budget and spending in January/ }).getByRole('listitem')
    await expect(cards).toHaveCount(4) // two Categories with a Budget, and the two that are not in one
    await expect(cards.first()).toContainText(names.cafe)
    await expect(cards.first()).toContainText(money(15_000))
    await expect(cards.first()).toContainText('Status')
    await expect(together(page).getByRole('listitem').first()).toContainText('Months over Budget')
    await expect(together(page).getByRole('listitem').first()).toContainText('1 of 3 months')
  })

  test.describe('when the request fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: figures that were not read never look like a month with nothing in it', async ({ page, context }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      await signInAs(context, 'admin')
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
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    await expect(article(page).getByRole('table').first()).toBeVisible()
  })

  const range = (year: number) => `${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Accounts, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const { year, everyday } = dataFor(testInfo.project.name)
    await expectTitleBlock(article(page), { name: 'Budget vs actual', account: 'All Accounts: ', dates: range(year) })
    await expect(article(page).locator('header')).toContainText(`${everyday.name} (${everyday.number})`)
  })

  test('puts the same identifying lines, and what is not counted, in every table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const tables = article(page).getByRole('table')
    expect(await tables.count()).toBe(7) // the months together, and six months
    for (let i = 0; i < 7; i++) {
      const identity = tables.nth(i).locator('thead tr').first()
      await expect(identity).toBeVisible() // on screen it is not
      await expect(identity).toContainText(`${TITLE} – Budget vs actual – All Accounts – ${range(year)}`)
      await expect(identity).toContainText(GENERATED)
      await expect(identity).toContainText(NOT_COUNTED) // so a loose page does not have to be read with the first
      // It is one of the table's heading rows, with the column headings: that is what makes a browser repeat it.
      expect(await tables.nth(i).locator('thead').evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
    }
  })

  test('names the page for Save as PDF: the app, the Report, the Accounts and the dates', async ({ page }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Budget vs actual – All Accounts – ${range(year)}`)
  })

  test('is black text on white paper, even from the dark theme, and an over-Budget status is black too', { tag: '@theme' }, async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expect(article(page).getByText('Over Budget').first()).toBeVisible()
    await expectBlackOnWhite(page, 100) // every word, including the muted ones, the money and the statuses, is black
  })

  test('has no text under 12pt', async ({ page }) => {
    await expectNoTextUnder12pt(page, article(page), 100)
  })

  test('is its own page with its own margins, repeats table headings and keeps a row whole', async ({ page }) => {
    await expectOwnPage(page)
  })

  test('is several A4 pages with the table headings on every page that has rows, and no row lost, repeated or cut across pages', async ({ page }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(3)
    const withRows = pages.filter((p) => rowsMarker(names).test(textOf(p)))
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
        // A row whose Budget changed says so under its name, between the name and the figures.
        const row = [names[key], MONTH_FIGURES[m]!.changed === key && `Budget changed from ${label}`, money(budget), spent(spentCents)].filter(Boolean).join(' ')
        expected.set(row, (expected.get(row) ?? 0) + 1)
      }
    }
    for (const [row, count] of expected) expect(all.split(row).length - 1, row).toBe(count)
    expect(expected.size).toBeGreaterThan(10)
    expect(pages.flatMap((p) => p.text).filter((t) => t.str === 'All months together')).toHaveLength(1) // the months together come once, before the months
    expect(all).toContain('1 of 6 months') // and a Category's months over Budget is in them
  })

  test('numbers every page "Page 2 of 5" in the bottom margin', async ({ page }) => {
    expectPageNumbers(await readPdf(await page.pdf({ format: 'A4' })))
  })

  test('says what the Report is, which Accounts and dates, who generated it and when, and what is not counted, at the top of every page the tables run onto', async ({ page }, testInfo) => {
    const { year, names } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const withRows = expectIdentityOnEveryPage(pages, rowsMarker(names), `${TITLE} – Budget vs actual – All Accounts – ${range(year)}`, 3)
    // What is not counted is in each page's own body too, not only in the first page's notes, so a loose page can be read alone.
    for (const p of withRows) expect(squash(textOf(p)), `page ${pages.indexOf(p) + 1}`).toContain(squash(NOT_COUNTED))
    expect(withRows.slice(1).length).toBeGreaterThanOrEqual(2) // and that is true of pages after the first, where the notes are not
  })

  test('has nothing in the top margin and only the page number in the bottom one', async ({ page }) => {
    expectBareMargins(await readPdf(await page.pdf({ format: 'A4' })))
  })

  test('sets every word of it, the page numbers and the statuses included, in at least 12pt type', async ({ page }) => {
    expectNoTypeUnder12pt(await readPdf(await page.pdf({ format: 'A4' })), 300)
  })

  test('prints the same from a phone-width window: still tables', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(article(page).getByRole('table').first()).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })

  test('says on paper too which dates were chosen when they are part of a month, so a printout never claims more than it covers', async ({ page }, testInfo) => {
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
    await signInAs(context, 'admin')
    await page.goto(address(`${year}-01-01`, `${year}-06-30`))
    await expect(page).toHaveTitle(`Mum's finances – Budget vs actual – All Accounts – ${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })

  test('shows a Member the same Report as the Admin, once the Admin has kept it', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['admin', 'member'] as const) {
      await signInToOpen(context, baseURL, role, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-06-30` })
      await page.goto(address(`${year}-01-01`, `${year}-06-30`))
      await expect(together(page).getByRole('table')).toBeVisible()
      seen.push((await article(page).getByRole('table').locator('tbody tr').allTextContents()).join('|'))
    }
    expect(seen[0]).toBe(seen[1])
  })
})
