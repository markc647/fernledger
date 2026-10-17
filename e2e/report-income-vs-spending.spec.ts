import type { BrowserContext, Page } from '@playwright/test'
import { dateField, pickDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { expectTableLook } from './table-look-helpers'
import { openHelp } from './help-helpers'
import { readPdf, textOf } from './pdf-text'
import {
  closeNotes,
  dateText,
  ensureCategory,
  expectBareMargins,
  expectBlackOnWhite,
  expectIdentityOnEveryPage,
  expectIdentityRow,
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
  notesButton,
  NOT_COUNTED_AS_SPENDING_OR_INCOME,
  NOW,
  openNotes,
  overrideCategories,
  restoreAppTitleAfterEach,
  setTitle,
  signedMoney,
  signInToOpen,
  spent,
  squash,
  TITLE,
  type SeedRow,
} from './report-helpers'

// Ticket 22: the income-vs-spending-by-month Report (spec story 95). It uses the Report frame of ticket 18, so it is shown on its own page, under its form, says on its face what it
// is, and prints with its table heading on every page. The Report's numbers are held to the Worker's spending totals in worker/report-income-vs-spending.test.ts;
// this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it makes (page count, the text on each page, the
// margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2000 and 2001, the oldest years a Report
// accepts), and a Report of that year lists only that project's Transactions even for every Account. Every Transaction here is dated SEPTEMBER TO DECEMBER. The
// Budget vs actual spec (report-budget.spec.ts) has the same two years the other way round, totals all Accounts, seeds January to April and asks for January to
// June and for July and August (when "both Budgets have ended"), so none of these lands in its dates and none of its lands in these. A test below holds this spec to
// it for January to August, and the Reports here, which add up every Account, would show a Transaction of its if one fell in September to December. The Summary's
// newest five and the first page of the Transactions list belong to the specs that look for theirs there, so these are older than every other spec's. Payees avoid
// "EXAMPLE", which other specs' Rules look for.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  return {
    project,
    year: light ? 2000 : 2001,
    everyday: { number: light ? '99-9999-9999999-50' : '99-9999-9999999-98', name: `Months everyday ${project}` },
    savings: { number: light ? '99-9999-9999999-59' : '99-9999-9999999-39', name: `Months savings ${project}` },
    pay: `Month pay ${project}`,
    interest: `Month interest ${project}`,
    food: `Month food ${project}`,
    fuel: `Month fuel ${project}`,
    loan: `Month loan ${project}`,
  }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** A month as the Report writes it: "September 2000". `index` counts from September, the first month of this spec's year. */
const monthName = (year: number, index: number) => `${MONTH_NAMES[8 + index]} ${year}`
const DIFFERENCE = 'Difference (income less spending)'
/** What is said above the totals when some money in has no Category (the Worker says how much). */
const noCategoryNotice = (cents: number) => `${money(cents)} of money in has no Category, so it comes off Spending and isn't counted as Income. Give it an Income Category to count it. The Difference is unaffected.`

// What September to December hold, by month, as [Income, Spending] in cents (September first). Everything that is not Spending or Income is left out of both: the
// Transfer and the loan in October, and $40 spent and refunded in full on the 25th and 26th, so October counts something and comes to nothing. November has $3.00 of money in that has no Category, which comes off Spending (the Report says so, and
// the Difference does not change). December has Spending below zero (money back) and Income below zero (money out of an Income Category) in one month.
type Figures = [income: number, spending: number][]
const quiet: [number, number] = [0, 0]
const EVERYDAY: Figures = [[300_000, 12_000], quiet, [300_000, 400], [-200, -2500]]
const SAVINGS: Figures = [[0, 2000], quiet, [150, 0], quiet]
const ALL: Figures = EVERYDAY.map(([income, spending], i) => [income + SAVINGS[i]![0], spending + SAVINGS[i]![1]])
const totalOf = (figures: Figures) => figures.reduce<[number, number]>(([income, spending], [i, s]) => [income + i, spending + s], [0, 0])
/** The money in with no Category, in cents: November's $3.00, which is in the Everyday Account. */
const NO_CATEGORY = 300

/** A month's cells as the Report writes them. */
const cells = (year: number, index: number, [income, spending]: [number, number]) => [monthName(year, index), money(income), spent(spending), signedMoney(income - spending)]

type Seeded = { everydayId: number; savingsId: number }
const seeded = new Map<string, Seeded>()

/** The project's two Accounts and their Categories and Transactions (see EVERYDAY and SAVINGS). Safe to repeat: an Import recognises rows it already holds. */
async function seed(context: BrowserContext, baseURL: string, project: string): Promise<Seeded> {
  const known = seeded.get(project)
  if (known) return known
  const d = dataFor(project)
  const { year } = d
  await signInAs(context, 'admin')

  const categories: Record<string, number> = {
    [d.pay]: await ensureCategory(context, baseURL, d.pay, 'income'),
    [d.interest]: await ensureCategory(context, baseURL, d.interest, 'income'),
    [d.food]: await ensureCategory(context, baseURL, d.food, 'spending'),
    [d.fuel]: await ensureCategory(context, baseURL, d.fuel, 'spending'),
    [d.loan]: await ensureCategory(context, baseURL, d.loan, 'loans'),
  }

  const say = (what: string) => `MONTHRPT ${project} ${what}`
  const everydayRows: SeedRow[] = [
    { date: `${year}-09-05`, payee: say('wages 1'), amountCents: 300_000, category: d.pay },
    { date: `${year}-09-10`, payee: say('food 1'), amountCents: -4000, category: d.food },
    { date: `${year}-09-20`, payee: say('fuel 1'), amountCents: -9000, category: d.fuel },
    { date: `${year}-09-25`, payee: say('food refund'), amountCents: 1000, category: d.food }, // a refund comes off Spending
    { date: `${year}-10-05`, payee: say('to savings'), amountCents: -20_000 }, // the other half is in Savings: a Transfer
    { date: `${year}-10-20`, payee: say('a loan'), amountCents: -50_000, category: d.loan }, // Loans: neither Spending nor Income, so October has nothing
    { date: `${year}-10-25`, payee: say('food 2'), amountCents: -4000, category: d.food }, // $40 spent ...
    { date: `${year}-10-26`, payee: say('food 2 refunded'), amountCents: 4000, category: d.food }, // ... and refunded in full: October nets out to nothing, and still has a row
    { date: `${year}-11-02`, payee: say('nobody has a Category for this'), amountCents: -700 },
    { date: `${year}-11-03`, payee: say('a payment in with no Category'), amountCents: NO_CATEGORY }, // Uncategorised is Spending, so this comes off it
    { date: `${year}-11-15`, payee: say('wages 2'), amountCents: 300_000, category: d.pay },
    { date: `${year}-12-10`, payee: say('fuel refund 2'), amountCents: 2500, category: d.fuel }, // money back, with nothing spent
    { date: `${year}-12-12`, payee: say('interest taken back'), amountCents: -200, category: d.interest }, // money out of an Income Category
  ]
  const savingsRows: SeedRow[] = [
    { date: `${year}-09-12`, payee: say('food in savings'), amountCents: -2000, category: d.food },
    { date: `${year}-10-05`, payee: say('from everyday'), amountCents: 20_000 },
    { date: `${year}-11-30`, payee: say('interest'), amountCents: 150, category: d.interest },
  ]
  // None is dated before September, which is how none lands in the dates the Budget vs actual spec uses (see the top of this file).
  for (const row of [...everydayRows, ...savingsRows]) expect(row.date >= `${year}-09-01`, row.payee).toBe(true)
  await importRows(context, baseURL, { account: d.everyday, year, rows: everydayRows, idPrefix: `MRP${year}E` })
  await importRows(context, baseURL, { account: d.savings, year, rows: savingsRows, idPrefix: `MRP${year}S` }) // the second Account pairs its $200.00 in with the first's $200.00 out

  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const idOf = (name: string) => accounts.find((a) => a.name === name)!.id
  const result = { everydayId: idOf(d.everyday.name), savingsId: idOf(d.savings.name) }
  await overrideCategories(context, baseURL, { accountId: result.everydayId, year, rows: everydayRows, categories })
  await overrideCategories(context, baseURL, { accountId: result.savingsId, year, rows: savingsRows, categories })
  seeded.set(project, result)
  return result
}

restoreAppTitleAfterEach() // the Settings are shared by every test and both themes (as reports.spec.ts does)
forgetKeptReportsAfterEach() // so is the list of kept Reports, which the Admin showing a Report adds to

/** The Report's address: `account` is left out for every Account. */
const address = (account: number | null, from: string, to: string) => `/reports/income-vs-spending?${account === null ? '' : `account=${account}&`}from=${from}&to=${to}`
/** The dates of this spec's Transactions: September to December. */
const halfYear = (year: number) => ({ from: `${year}-09-01`, to: `${year}-12-31` })
const NAME = 'Income vs spending by month'
const article = (page: Page) => page.getByRole('article', { name: NAME })
const tableOf = (page: Page) => article(page).getByRole('table', { name: 'Income and spending by month' })
const section = (page: Page) => article(page).getByRole('region', { name: 'Income and spending by month' })
/** The paragraph above the totals that says how much money in has no Category. */
const noticeOf = (page: Page) => section(page).locator(':scope > p', { hasText: 'of money in has no Category' })

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('its page has a form of its own, for all Accounts or one, that shows the Report under it', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    const { from, to } = halfYear(d.year)
    await signInAs(context, 'admin')
    await page.goto('/reports/income-vs-spending')
    await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible()

    const form = page.getByRole('form', { name: NAME })
    // The page's help sheet says what the Report holds, how the dates are counted, and the most months a Report covers, since Budget vs actual's says the opposite of the first and a different number of the second.
    await expect(form).not.toContainText('one row for each month')
    const help = await openHelp(page)
    await expect(help).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME)
    await expect(help).toContainText('one row for each month in your dates, with the income, the spending and the difference between them')
    await expect(help).toContainText('Your dates are counted exactly: a month they begin or end part way through counts only those dates, and the row says so.')
    await expect(help).toContainText('up to 120 months')
    await page.keyboard.press('Escape')
    await expect(form.getByLabel('Account')).toHaveValue('') // every Account unless one is chosen
    await pickDate(form, 'From', from)
    await pickDate(form, 'To', to)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page).locator('header')).toContainText('Account: All Accounts: ')
    expect(new URL(page.url()).pathname).toBe('/reports/income-vs-spending')
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ from, to }) // every Account: none in the address

    await form.getByLabel('Account').selectOption({ label: d.everyday.name })
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page).locator('header')).toContainText(`Account: ${d.everyday.name} (${d.everyday.number})`)
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ account: String(everydayId), from, to })
  })

  test('its form asks for real dates, in order, and shows nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/income-vs-spending')
    const form = page.getByRole('form', { name: NAME })
    const show = form.getByRole('button', { name: 'Show Report' })

    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await pickDate(form, 'From', '2022-12-31')
    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await pickDate(form, 'To', '2022-01-01')
    await show.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(dateField(form, 'To')).toHaveAttribute('aria-invalid', 'true')
    expect(new URL(page.url()).search).toBe('')
    await expect(article(page)).toHaveCount(0)
  })

  test('its form refuses dates that touch more than 120 months, naming the limit, and shows nothing', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/income-vs-spending')
    const form = page.getByRole('form', { name: NAME })
    await pickDate(form, 'From', '2000-01-31')
    await pickDate(form, 'To', '2010-01-01') // 121 months, though not quite ten years
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(form.getByRole('alert')).toHaveText('An Income vs spending by month Report covers at most 120 months (10 years). Choose dates that touch 120 months or fewer.')
    await expect(dateField(form, 'To')).toHaveAttribute('aria-invalid', 'true')
    await expect(article(page)).toHaveCount(0)

    await pickDate(form, 'To', '2009-12-01') // 120 months. This shows a Report of every Account over 2000 to 2009, which holds other specs' Transactions too: assert nothing of its figures
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page)).toBeVisible()
    await expect(form.getByRole('alert')).toHaveCount(0)
  })

  test('an address with only some dates, dates the wrong way round, too many months or no such Account explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'admin')
    for (const [path, words, alert] of [
      ['/reports/income-vs-spending?from=2022-01-01', 'Choose the first and last dates', false],
      ['/reports/income-vs-spending?from=2022-12-31&to=2022-01-01', 'before the “From” date', true],
      ['/reports/income-vs-spending?from=2000-01-01&to=2010-01-01', 'covers at most 120 months', true],
      ['/reports/income-vs-spending?account=999999999&from=2022-01-01&to=2022-12-31', 'There is no such Account', true],
      ['/reports/income-vs-spending?account=abc&from=2022-01-01&to=2022-12-31', 'There is no such Account', true],
      ['/reports/income-vs-spending?account=0&from=2022-01-01&to=2022-12-31', 'There is no such Account', true],
      ['/reports/income-vs-spending?account=-1&from=2022-01-01&to=2022-12-31', 'There is no such Account', true],
      ['/reports/income-vs-spending?account=2', 'Choose the first and last dates', false],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status').filter({ hasText: words })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Show Report' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without dates
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
    const { from, to } = halfYear(year)
    await page.goto(address(null, from, to))
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

  /** The table's rows as the page words them (a cell for each column), once the Report has loaded. */
  const rowsOf = async (page: Page) => {
    await expect(tableOf(page)).toBeVisible()
    return tableOf(page)
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((row) => Array.from(row.querySelectorAll('td'), (td) => td.textContent!.replace(/\s+/g, ' ').trim())))
  }
  /** The totals above the table. */
  const totalsOf = async (page: Page) => {
    const dl = section(page).locator('dl')
    await expect(dl).toBeVisible()
    return dl.evaluate((el) => Array.from(el.querySelectorAll('dt, dd'), (node) => node.textContent!.replace(/\s+/g, ' ').trim()))
  }
  const expectedTotals = (figures: Figures) => {
    const [income, spending] = totalOf(figures)
    return ['Total income', money(income), 'Total spending', spent(spending), DIFFERENCE, signedMoney(income - spending)]
  }

  test('has the title block, what is counted, the totals, and a row for each month, with nothing that is not Spending or Income in it', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    const { from, to } = halfYear(d.year)
    await page.goto(address(null, from, to))

    const report = article(page)
    await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible() // the page's heading, above the form: the Report's own title is text on screen and the h1 on paper
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Account: All Accounts: ')
    await expect(header).toContainText(`${d.everyday.name} (${d.everyday.number})`) // each Account, with its bank number
    await expect(header).toContainText(`${d.savings.name} (${d.savings.number})`)
    await expect(header).toContainText(`Dates: ${dateText(from)} to ${dateText(to)}`)
    await expect(header).toContainText(GENERATED)

    // The notes, behind the Report's "?": what Income and Spending are, that Uncategorised counts as Spending and so is not Income, what the Difference is, how the dates are
    // counted, and what is left out.
    const about = await openNotes(page, report)
    await expect(about).toContainText('Income is what the Income Categories brought in each month, less what went out of them.')
    await expect(about).toContainText('Spending is what the Spending Categories took out, less money back, such as a refund. A “back” amount is taken off the total.')
    await expect(about).toContainText('Uncategorised counts as spending, so money in that has no Category yet comes off Spending and is not counted as income.')
    await expect(about).toContainText('The difference is income less spending, so it is below zero when more was spent than came in.')
    await expect(about).toContainText('Your dates are counted exactly. A month they begin or end part way through counts only those dates, and its row says which.')
    await expect(about).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME)
    await closeNotes(page)

    expect(await totalsOf(page)).toEqual(expectedTotals(ALL))
    expect(await totalsOf(page)).toEqual(['Total income', '$5,999.50', 'Total spending', '$119.00', DIFFERENCE, '+$5,880.50']) // the same, written out
    // The line over the Difference is one line across the totals, not a piece over each of its two cells with a gap between them.
    const line = await section(page).locator('dl').evaluate((dl) => {
      const row = Array.from(dl.children).find((el) => el.tagName === 'DIV')!
      const box = (el: Element) => el.getBoundingClientRect()
      const border = (el: Element) => getComputedStyle(el).borderTopWidth
      return { sameWidth: Math.abs(box(row).width - box(dl).width) < 1, row: border(row), cells: Array.from(row.children).map(border) }
    })
    expect(line.sameWidth).toBe(true)
    expect(parseFloat(line.row)).toBeGreaterThan(0)
    expect(line.cells).toEqual(['0px', '0px'])
    await expect(tableOf(page).getByRole('columnheader')).toHaveText(['Month', 'Income', 'Spending', DIFFERENCE])
    await expectTableLook(tableOf(page))
    // A row for every month in the dates, oldest first, quiet ones too: a month with only a Transfer and a loan is a row of zeros, not a gap.
    const rows = await rowsOf(page)
    expect(rows).toEqual(ALL.map((figures, i) => cells(d.year, i, figures)))
    expect(rows[0]).toEqual([`September ${d.year}`, '$3,000.00', '$140.00', '+$2,860.00'])
    expect(rows[1]).toEqual([`October ${d.year}`, '$0.00', '$0.00', '$0.00']) // the Transfer and the loan are not counted, and $40 spent and refunded nets out to nothing
    await expect(report).not.toContainText('Counts only') // the dates cover whole months
    await expect(report).not.toContainText('not over yet') // and they are over, long since
    // The Transfer ($200.00) and the loan ($500.00) are in neither column or total.
    await expect(report).not.toContainText('$200.00')
    await expect(report).not.toContainText('$500.00')
    // The line that says what a page is belongs to paper: it is in the table's heading, and not on screen.
    await expect(tableOf(page).locator('thead tr')).toHaveCount(2)
    await expect(tableOf(page).locator('thead tr').first()).toBeHidden()
  })

  test("totals only the Account chosen, and says which; an Account's Transfer is neither its Income nor its Spending", async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId, savingsId } = await seed(context, baseURL!, testInfo.project.name)
    const { from, to } = halfYear(d.year)
    await signInAs(context, 'admin')

    await page.goto(address(everydayId, from, to))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.everyday.name} (${d.everyday.number})`)
    expect(await rowsOf(page)).toEqual(EVERYDAY.map((figures, i) => cells(d.year, i, figures)))
    expect(await totalsOf(page)).toEqual(expectedTotals(EVERYDAY))

    await page.goto(address(savingsId, from, to))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.savings.name} (${d.savings.number})`)
    expect(await rowsOf(page)).toEqual(SAVINGS.map((figures, i) => cells(d.year, i, figures))) // the $200.00 that came in is a Transfer: October is zeros
    expect(await totalsOf(page)).toEqual(['Total income', '$1.50', 'Total spending', '$20.00', DIFFERENCE, '−$18.50'])
  })

  test('adds up only the dates asked for, both ends included, and says which dates it counted in a month at each end it covers in part', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')

    // 10 September to 20 November: September's wages (the 5th) and November's interest (the 30th) are outside the dates; the rest of both months is in.
    await page.goto(address(null, `${d.year}-09-10`, `${d.year}-11-20`))
    const rows = await rowsOf(page)
    expect(rows).toHaveLength(3) // September, October and November, and no others
    expect(rows[0]).toEqual([`September ${d.year} Counts only ${dateText(`${d.year}-09-10`)} to ${dateText(`${d.year}-09-30`)}`, '$0.00', '$140.00', '−$140.00'])
    expect(rows[1]).toEqual(cells(d.year, 1, ALL[1]!)) // a whole month, with no note
    expect(rows[2]).toEqual([`November ${d.year} Counts only ${dateText(`${d.year}-11-01`)} to ${dateText(`${d.year}-11-20`)}`, '$3,000.00', '$4.00', '+$2,996.00'])
    expect(await totalsOf(page)).toEqual(['Total income', '$3,000.00', 'Total spending', '$144.00', DIFFERENCE, '+$2,856.00'])

    // One day: its month, counting only that day.
    await page.goto(address(null, `${d.year}-09-20`, `${d.year}-09-20`))
    expect(await rowsOf(page)).toEqual([[`September ${d.year} Counts only ${dateText(`${d.year}-09-20`)}`, '$0.00', '$90.00', '−$90.00']])
    await expect(article(page).locator('header dl div').filter({ hasText: 'Dates:' })).toHaveText(`Dates: ${dateText(`${d.year}-09-20`)}`) // one date, not a range
  })

  test('says "back" for Spending that is less than nothing and writes the minus of Income that is, in a row and in the totals', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(null, `${d.year}-12-01`, `${d.year}-12-31`)) // $2.00 of Income taken back, and $25.00 of Spending back, in one month
    expect(await rowsOf(page)).toEqual([[`December ${d.year}`, '−$2.00', '$25.00 back', '+$23.00']])
    expect(await totalsOf(page)).toEqual(['Total income', '−$2.00', 'Total spending', '$25.00 back', DIFFERENCE, '+$23.00'])
  })

  test('says how much money in has no Category, above the totals, only when there is some in the dates and the Accounts chosen', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId, savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    const { from, to } = halfYear(d.year)

    await page.goto(address(null, from, to))
    await expect(tableOf(page)).toBeVisible()
    await expect(noticeOf(page)).toHaveText(noCategoryNotice(NO_CATEGORY))
    // It is above the totals, in the Report's own section, and the Difference is the same figure it would be if the money in had a Category (the Worker's test holds that).
    expect(await section(page).evaluate((el) => el.querySelector('p')!.compareDocumentPosition(el.querySelector('dl')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy()

    await page.goto(address(everydayId, from, to))
    await expect(noticeOf(page)).toHaveText(noCategoryNotice(NO_CATEGORY))
    await page.goto(address(savingsId, from, to)) // no money in with no Category in this Account
    await expect(tableOf(page)).toBeVisible()
    await expect(noticeOf(page)).toHaveCount(0)
    await page.goto(address(null, `${d.year}-09-01`, `${d.year}-10-31`)) // and none in September and October
    await expect(tableOf(page)).toBeVisible()
    await expect(noticeOf(page)).toHaveCount(0)
    await page.goto(address(null, `${d.year}-11-04`, `${d.year}-12-31`)) // nor after November's $3.00 came in on the 3rd
    await expect(tableOf(page)).toBeVisible()
    await expect(noticeOf(page)).toHaveCount(0)
  })

  test('says there was no income or spending, and shows no table or totals, for dates with none', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(savingsId, `${d.year}-10-01`, `${d.year}-10-31`)) // this Account has only the Transfer in October: a whole month is named by its name
    await expect(section(page)).toContainText(`There was no income or spending in October ${d.year}.`)
    await expect(section(page).getByRole('table')).toHaveCount(0)
    await expect(section(page).locator('dl')).toHaveCount(0)
    await expect(notesButton(article(page))).toBeVisible() // the notes are there to read, whatever the dates hold

    await page.goto(address(null, `${d.year}-10-02`, `${d.year}-10-19`)) // every Account, several days: the Transfer is not counted, and the loan and the refunded food are later
    await expect(section(page)).toContainText(`There was no income or spending in ${dateText(`${d.year}-10-02`)} to ${dateText(`${d.year}-10-19`)}.`)
    await expect(section(page).getByRole('table')).toHaveCount(0)
  })

  test('shows its row, and the totals, for a month that nets out to nothing, which is not the same as no income or spending', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    // $40 spent on the 25th and refunded on the 26th: $0.00 spent, but something was counted.
    await page.goto(address(null, `${d.year}-10-24`, `${d.year}-10-31`))
    expect(await rowsOf(page)).toEqual([[`October ${d.year} Counts only ${dateText(`${d.year}-10-24`)} to ${dateText(`${d.year}-10-31`)}`, '$0.00', '$0.00', '$0.00']])
    expect(await totalsOf(page)).toEqual(['Total income', '$0.00', 'Total spending', '$0.00', DIFFERENCE, '$0.00'])
    await expect(section(page)).not.toContainText('There was no income or spending')
    // One day of it has $40 spent and nothing back yet.
    await page.goto(address(null, `${d.year}-10-25`, `${d.year}-10-25`))
    expect((await rowsOf(page))[0]).toEqual([`October ${d.year} Counts only ${dateText(`${d.year}-10-25`)}`, '$0.00', '$40.00', '−$40.00'])
    // The whole month: the Transfer and the loan are not counted, and the food is, so October is a row and the Report is not "nothing".
    await page.goto(address(null, `${d.year}-10-01`, `${d.year}-10-31`))
    expect(await rowsOf(page)).toEqual([[`October ${d.year}`, '$0.00', '$0.00', '$0.00']])
    await expect(section(page)).not.toContainText('There was no income or spending')
  })

  test('is titled for Save as PDF: the app, the Report, the Accounts and the dates', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    const { from, to } = halfYear(d.year)
    const range = `${dateText(from)} to ${dateText(to)}`
    await page.goto(address(null, from, to))
    await expect(page).toHaveTitle(`Mum's finances – ${NAME} – All Accounts – ${range}`)
    await page.goto(address(everydayId, from, to))
    await expect(page).toHaveTitle(`Mum's finances – ${NAME} – ${d.everyday.name} – ${range}`)
  })

  test('keeps to September to December: none of its Transactions is in January to August of either year, which are the months the Budget vs actual spec asks about', async ({ context, baseURL }, testInfo) => {
    const { everydayId, savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    for (const year of [2000, 2001]) {
      for (const accountId of [everydayId, savingsId]) {
        const res = await context.request.get(`/api/reports/income-vs-spending?accountId=${accountId}&from=${year}-01-01&to=${year}-08-31`)
        expect(res.ok()).toBe(true)
        const { months, totals } = (await res.json()) as { months: { incomeCents: number; spendingCents: number; uncategorisedInCents: number }[]; totals: { incomeCents: number; spendingCents: number } }
        expect(months).toHaveLength(8)
        expect(months.every((m) => m.incomeCents === 0 && m.spendingCents === 0 && m.uncategorisedInCents === 0), `${year}, Account ${accountId}`).toBe(true)
        expect(totals).toMatchObject({ incomeCents: 0, spendingCents: 0 })
      }
    }
  })

  for (const role of ['admin', 'member'] as const) {
    test(`has no WCAG 2.2 AA violations as ${role === 'admin' ? 'the Admin' : 'a Member, who opens the Report the Admin kept'}, with money back, a minus sign, a part month and the notice to show`, async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInToOpen(context, baseURL, role, { report: 'income-vs-spending', from: `${d.year}-09-10`, to: `${d.year}-12-31` })
      await page.goto(address(null, `${d.year}-09-10`, `${d.year}-12-31`))
      await expect(tableOf(page)).toBeVisible()
      await expect(tableOf(page)).toContainText('$25.00 back')
      await expect(tableOf(page)).toContainText('−$2.00')
      await expect(tableOf(page)).toContainText('Counts only ')
      await expect(noticeOf(page)).toBeVisible()
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 390, height: 844 })
    const { from, to } = halfYear(d.year)
    await page.goto(address(everydayId, from, to))
    const cards = article(page).getByRole('list', { name: 'Income and spending by month' }).getByRole('listitem')
    await expect(cards).toHaveCount(4)
    await expect(cards.first()).toContainText(`September ${d.year}`)
    for (const [label, value] of [['Income', '$3,000.00'], ['Spending', '$120.00'], [DIFFERENCE, '+$2,880.00']]) {
      await expect(cards.first()).toContainText(label!)
      await expect(cards.first()).toContainText(value!)
    }
    await expect(cards.nth(3)).toContainText('−$2.00')
    await expect(cards.nth(3)).toContainText('$25.00 back')
  })

  test('shows a Member the same Report as the Admin, once the Admin has kept it', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const { from, to } = halfYear(d.year)
    const seen: string[] = []
    for (const role of ['admin', 'member'] as const) {
      await signInToOpen(context, baseURL, role, { report: 'income-vs-spending', from, to })
      await page.goto(address(null, from, to))
      seen.push(JSON.stringify([await rowsOf(page), await totalsOf(page)]))
    }
    expect(seen[0]).toBe(seen[1])
  })

  test.describe('months that are not over', () => {
    test('says so on the row of a month that is under way or has not begun, so a row of zeros is not read as a quiet month', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account', accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
      const month = (m: string, state: string, incomeCents: number, spendingCents: number) => ({ month: m, state, incomeCents, spendingCents, differenceCents: incomeCents - spendingCents, uncategorisedInCents: 0, counted: Number(incomeCents !== 0 || spendingCents !== 0) })
      await page.route('**/api/reports/income-vs-spending?**', (route) =>
        route.fulfill({
          json: {
            from: '2026-09-01',
            to: '2026-11-30',
            months: [month('2026-09', 'ended', 100_000, 40_000), month('2026-10', 'under-way', 0, 2500), month('2026-11', 'not-begun', 0, 0)],
            totals: { incomeCents: 100_000, spendingCents: 42_500, differenceCents: 57_500, uncategorisedInCents: 0, counted: 2 },
          },
        }),
      )
      await page.goto('/reports/income-vs-spending?from=2026-09-01&to=2026-11-30')
      const rows = tableOf(page).locator('tbody tr')
      await expect(rows).toHaveCount(3)
      await expect(rows.nth(0)).toHaveText(/^September 2026\$1,000\.00\$400\.00\+\$600\.00$/) // nothing said of a month that is over
      await expect(rows.nth(1).locator('td').first()).toHaveText('October 2026 This month is not over yet, so these are the figures so far.')
      await expect(rows.nth(2).locator('td').first()).toHaveText('November 2026 This month has not begun, so there is nothing to show yet.')
    })
  })

  test.describe('when the request fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: figures that were not read never look like none', async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'admin')
      await page.route('**/api/reports/income-vs-spending?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      const { from, to } = halfYear(d.year)
      await page.goto(address(null, from, to))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByText('There was no income or spending')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The most months a Report covers

test.describe('120 months', () => {
  test('a Report of the most months is a row for each of them, and one of a month more is refused before it is asked for', async ({ page, context, baseURL }, testInfo) => {
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    // Every Account over 2000 to 2009 holds other specs' Transactions too (the Budget vs actual spec's, and 2002 and 2003 are the Spending by Category spec's and the
    // Loans Report spec's): this test asserts the number of rows and the names of the months, and never a figure.
    await page.goto(address(null, '2000-01-01', '2009-12-31'))
    await expect(tableOf(page)).toBeVisible()
    await expect(tableOf(page).locator('tbody tr')).toHaveCount(120)
    await expect(tableOf(page).locator('tbody tr').first().locator('td').first()).toHaveText('January 2000')
    await expect(tableOf(page).locator('tbody tr').last().locator('td').first()).toHaveText('December 2009')

    let asked = 0
    await page.route('**/api/reports/income-vs-spending?**', (route) => {
      asked += 1
      return route.abort()
    })
    await page.goto(address(null, '2000-01-01', '2010-01-01'))
    await expect(page.getByRole('alert')).toContainText('covers at most 120 months')
    expect(asked).toBe(0) // the page did not ask the Worker
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Printed

test.describe('printed', () => {
  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    const { from, to } = halfYear(d.year)
    await page.goto(address(everydayId, from, to))
    await expect(tableOf(page)).toBeVisible()
  })

  const range = (year: number) => `${dateText(halfYear(year).from)} to ${dateText(halfYear(year).to)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and when it was generated', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectTitleBlock(article(page), { name: NAME, account: `${d.everyday.name} (${d.everyday.number})`, dates: range(d.year) })
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page, and says what the Difference is, what is not counted and what has no Category', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectIdentityRow(page, `${TITLE} – ${NAME} – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`)
    const heading = page.locator('thead tr').first() // so a loose page does not have to be read with the first
    await expect(heading).toContainText('The Difference is income less spending.')
    await expect(heading).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME)
    await expect(heading).toContainText(noCategoryNotice(NO_CATEGORY))
  })

  test('says "All Accounts" in the table heading when no Account was chosen, and leaves the title block to list them', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await page.goto(address(null, halfYear(d.year).from, halfYear(d.year).to))
    await expect(tableOf(page)).toBeVisible()
    await expectIdentityRow(page, `${TITLE} – ${NAME} – All Accounts – ${range(d.year)}`)
    await expect(article(page).locator('header')).toContainText(`${d.everyday.name} (${d.everyday.number})`)
    await expect(page.locator('thead tr').first()).not.toContainText(d.everyday.name) // not once for every Account on every page
  })

  test('leaves the notice out of the table heading for an Account with no money in that has no Category', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await page.goto(address(savingsId, halfYear(d.year).from, halfYear(d.year).to))
    await expect(tableOf(page)).toBeVisible()
    await expect(page.locator('thead tr').first()).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME)
    await expect(page.locator('thead tr').first()).not.toContainText('of money in has no Category')
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – ${NAME} – ${d.everyday.name} – ${range(d.year)}`)
  })

  test('is black text on white paper, even from the dark theme', { tag: '@theme' }, async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expectBlackOnWhite(page, 20) // every word, including the money, the minus signs, "back" and the notice, is black
  })

  test('has no text under 12pt', async ({ page }) => {
    await expectNoTextUnder12pt(page, article(page), 20)
  })

  test('is its own page with its own margins, repeats the table heading and keeps a row whole', async ({ page }) => {
    await expectOwnPage(page)
  })

  test('prints every month, the totals, the notice and the page numbers, every figure in at least 12pt type, with the table heading on each page that has the table', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    for (const [i, figures] of EVERYDAY.entries()) {
      const row = cells(d.year, i, figures).join(' ')
      expect(all.split(row).length - 1, row).toBe(1) // each month once: not lost, not repeated, not cut across pages
    }
    const [income, spending] = totalOf(EVERYDAY)
    expect(all).toContain(`Total income ${money(income)}`)
    expect(all).toContain(`Total spending ${spent(spending)}`)
    expect(all).toContain(`${DIFFERENCE} ${signedMoney(income - spending)}`)
    expect(squash(all)).toContain(squash(noCategoryNotice(NO_CATEGORY)))
    expectPageNumbers(pages)
    expectBareMargins(pages)
    expectNoTypeUnder12pt(pages, 50)
    // The table's heading, with what the Report is, who generated it, what the Difference is, what is not counted and what has no Category, is on every page that has the table.
    const withTable = expectIdentityOnEveryPage(pages, 'The Difference is income less spending.', `${TITLE} – ${NAME} – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`, 1)
    for (const p of withTable) {
      expect(squash(textOf(p))).toContain(squash('The Difference is income less spending.'))
      expect(squash(textOf(p))).toContain(squash(NOT_COUNTED_AS_SPENDING_OR_INCOME))
      expect(squash(textOf(p))).toContain(squash(noCategoryNotice(NO_CATEGORY)))
    }
  })

  test('prints the same from a phone-width window: still a table', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(tableOf(page)).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })
})

// A Report with the most months a Report covers, which is more than a page holds: ten years. The data is stubbed (and so are the Accounts), so the test adds
// nothing for the other specs to find and needs nothing of them.
test.describe('printed over several pages', () => {
  const YEARS = 10
  const FROM_YEAR = 2000
  const MONTHS = YEARS * 12
  /** Every month's figures are different, so a row can be told from the others in a PDF. */
  const incomeOf = (i: number) => 300_000 + i * 137
  const spendingOf = (i: number) => 250_000 - i * 211
  const monthAt = (i: number) => `${FROM_YEAR + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
  const rowOf = (i: number) => [`${MONTH_NAMES[i % 12]} ${FROM_YEAR + Math.floor(i / 12)}`, money(incomeOf(i)), spent(spendingOf(i)), signedMoney(incomeOf(i) - spendingOf(i))].join(' ')
  const NO_CATEGORY_STUB = 123_456

  test.beforeEach(async ({ page, context, request, baseURL }) => {
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account', accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
    const months = Array.from({ length: MONTHS }, (_, i) => ({
      month: monthAt(i),
      state: 'ended',
      incomeCents: incomeOf(i),
      spendingCents: spendingOf(i),
      differenceCents: incomeOf(i) - spendingOf(i),
      uncategorisedInCents: i === 0 ? NO_CATEGORY_STUB : 0,
      counted: 3,
    }))
    const sum = (pick: (m: (typeof months)[number]) => number) => months.reduce((total, m) => total + pick(m), 0)
    await page.route('**/api/reports/income-vs-spending?**', (route) =>
      route.fulfill({
        json: {
          from: `${FROM_YEAR}-01-01`,
          to: `${FROM_YEAR + YEARS - 1}-12-31`,
          months,
          totals: { incomeCents: sum((m) => m.incomeCents), spendingCents: sum((m) => m.spendingCents), differenceCents: sum((m) => m.differenceCents), uncategorisedInCents: NO_CATEGORY_STUB, counted: sum((m) => m.counted) },
        },
      }),
    )
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(null, `${FROM_YEAR}-01-01`, `${FROM_YEAR + YEARS - 1}-12-31`)) // every Account, so the heading says so
    await expect(tableOf(page)).toBeVisible()
  })

  test('is several A4 pages with the table headings on every one, no month lost, repeated or cut across pages', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(3)
    const withRows = pages.filter((p) => /(January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d /.test(textOf(p)))
    expect(withRows.length).toBeGreaterThanOrEqual(3)
    // Headings come back on every page the table runs onto, not only the first.
    for (const p of withRows) for (const heading of ['Month', 'Income', 'Spending', 'Difference']) expect(squash(textOf(p)), `${heading} on page ${pages.indexOf(p) + 1}`).toContain(squash(heading))

    // Every month is on exactly one page, as one row: its name and its three figures.
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    for (let i = 0; i < MONTHS; i++) expect(all.split(rowOf(i)).length - 1, rowOf(i)).toBe(1)
  })

  test('says what the Report is, which Accounts and dates, when it was generated, what the Difference is, what is not counted and what has no Category, at the top of every page the table runs onto', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    // The Admin's title comes through as typed, quote and backslash too; the heading says "All Accounts", not each of them on every page.
    const withRows = expectIdentityOnEveryPage(pages, 'The Difference is income less spending.', `${TITLE} – ${NAME} – All Accounts – ${dateText(`${FROM_YEAR}-01-01`)} to ${dateText(`${FROM_YEAR + YEARS - 1}-12-31`)}`, 3)
    for (const p of withRows) {
      const text = squash(textOf(p))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash('The Difference is income less spending.'))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(NOT_COUNTED_AS_SPENDING_OR_INCOME))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(noCategoryNotice(NO_CATEGORY_STUB)))
    }
  })

  test('numbers every page "Page 2 of 5" in the bottom margin, and has nothing else in the margins', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expectPageNumbers(pages)
    expectBareMargins(pages)
  })

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    expectNoTypeUnder12pt(await readPdf(await page.pdf({ format: 'A4' })), 400) // 120 rows of four, and the rest
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Around the Report

test.describe('around the Report', () => {
  test('is titled for Save as PDF while it is open, and goes back to the app title when it is left', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    const { from, to } = halfYear(d.year)
    await page.goto(address(null, from, to))
    await expect(page).toHaveTitle(`Mum's finances – ${NAME} – All Accounts – ${dateText(from)} to ${dateText(to)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })
})
