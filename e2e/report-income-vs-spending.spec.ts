import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'
import {
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
  GENERATED,
  importRows,
  money,
  noAxeViolations,
  NOT_COUNTED_AS_SPENDING_OR_INCOME,
  NOW,
  overrideCategories,
  restoreAppTitleAfterEach,
  setTitle,
  signedMoney,
  spent,
  squash,
  TITLE,
  type SeedRow,
} from './report-helpers'

// Ticket 22: the income-vs-spending-by-month Report (spec story 95). It uses the Report frame of ticket 18, so it opens in a new window, says on its face what it
// is, and prints with its table heading on every page. The Report's numbers are held to the Worker's spending totals in worker/report-income-vs-spending.test.ts;
// this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it makes (page count, the text on each page, the
// margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2000 and 2001, the oldest years a Report
// accepts), and a Report of that year lists only that project's Transactions even for every Account. No other spec uses these years, and they are older than
// every other spec's Transactions on purpose: the Summary's newest five and the first page of the Transactions list belong to the specs that look for theirs
// there. Payees avoid "EXAMPLE", which other specs' Rules look for. 2000 is a leap year, so no Transaction is dated 29 February.
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
/** A month as the Report writes it: "January 2000". */
const monthName = (year: number, index: number) => `${MONTH_NAMES[index]} ${year}`

// What the year holds, by month, as [Income, Spending] in cents (January first). Everything that is not Spending or Income is left out of both: the Transfer in
// March (the $200.00 out of Everyday is in Savings), the loan in July, and the dates with nothing in them. Spending goes below zero in August (only money
// back), and Income in June (only money out of an Income Category).
type Figures = [income: number, spending: number][]
const quiet: [number, number] = [0, 0]
const EVERYDAY: Figures = [[300_000, 13_000], [300_000, 1550], quiet, [300_000, 400], quiet, [-200, 0], quiet, [0, -2500], quiet, quiet, quiet, quiet]
const SAVINGS: Figures = [[0, 2000], quiet, quiet, [150, 0], quiet, quiet, quiet, quiet, quiet, quiet, quiet, quiet]
const ALL: Figures = EVERYDAY.map(([income, spending], i) => [income + SAVINGS[i]![0], spending + SAVINGS[i]![1]])
const totalOf = (figures: Figures) => figures.reduce<[number, number]>(([income, spending], [i, s]) => [income + i, spending + s], [0, 0])

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
    { date: `${year}-01-05`, payee: say('wages 1'), amountCents: 300_000, category: d.pay },
    { date: `${year}-01-10`, payee: say('food 1'), amountCents: -4000, category: d.food },
    { date: `${year}-01-20`, payee: say('fuel 1'), amountCents: -9000, category: d.fuel },
    { date: `${year}-02-05`, payee: say('wages 2'), amountCents: 300_000, category: d.pay },
    { date: `${year}-02-06`, payee: say('food 2'), amountCents: -2550, category: d.food },
    { date: `${year}-02-20`, payee: say('food refund'), amountCents: 1000, category: d.food }, // a refund comes off Spending
    { date: `${year}-03-05`, payee: say('to savings'), amountCents: -20_000 }, // the other half is in Savings: a Transfer, so March has nothing
    { date: `${year}-04-02`, payee: say('nobody has a Category for this'), amountCents: -700 },
    { date: `${year}-04-03`, payee: say('a payment in with no Category'), amountCents: 300 }, // Uncategorised is Spending, so this comes off it
    { date: `${year}-04-15`, payee: say('wages 3'), amountCents: 300_000, category: d.pay },
    { date: `${year}-06-12`, payee: say('interest taken back'), amountCents: -200, category: d.interest }, // only money out of an Income Category
    { date: `${year}-07-20`, payee: say('a loan'), amountCents: -50_000, category: d.loan }, // Loans: neither Spending nor Income
    { date: `${year}-08-10`, payee: say('fuel refund'), amountCents: 2500, category: d.fuel }, // only money back
  ]
  const savingsRows: SeedRow[] = [
    { date: `${year}-01-12`, payee: say('food in savings'), amountCents: -2000, category: d.food },
    { date: `${year}-03-05`, payee: say('from everyday'), amountCents: 20_000 },
    { date: `${year}-04-30`, payee: say('interest'), amountCents: 150, category: d.interest },
  ]
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

/** The Report's address: `account` is left out for every Account. */
const address = (account: number | null, from: string, to: string) => `/reports/income-vs-spending?${account === null ? '' : `account=${account}&`}from=${from}&to=${to}`
const wholeYear = (year: number) => ({ from: `${year}-01-01`, to: `${year}-12-31` })
const NAME = 'Income vs spending by month'
const article = (page: Page) => page.getByRole('article', { name: NAME })
const tableOf = (page: Page) => article(page).getByRole('table', { name: 'Income and spending by month' })
const section = (page: Page) => article(page).getByRole('region', { name: 'Income and spending by month' })

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('the Reports page offers it with a form of its own, for all Accounts or one, and opens it in a new window', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
    await expect(page.getByRole('heading', { level: 2, name: NAME })).toBeVisible()

    const form = page.getByRole('form', { name: NAME })
    await expect(form).toContainText('one row for each month in your dates, with the income, the spending and the difference between them')
    await expect(page.getByRole('heading', { level: 2, name: NAME }).locator('xpath=following-sibling::p[1]')).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME)
    await expect(form.getByLabel('Account')).toHaveValue('') // every Account unless one is chosen
    await form.getByLabel('From').fill(`${d.year}-01-01`)
    await form.getByLabel('To').fill(`${d.year}-12-31`)
    const [all] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(all.getByRole('heading', { level: 1, name: NAME })).toBeVisible()
    expect(new URL(all.url()).pathname).toBe('/reports/income-vs-spending')
    expect(Object.fromEntries(new URL(all.url()).searchParams)).toEqual({ account: '', from: `${d.year}-01-01`, to: `${d.year}-12-31` })
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible() // the Reports page is still where it was

    await form.getByLabel('Account').selectOption({ label: d.everyday.name })
    const [one] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(one.getByRole('heading', { level: 1, name: NAME })).toBeVisible()
    expect(Object.fromEntries(new URL(one.url()).searchParams)).toEqual({ account: String(everydayId), from: `${d.year}-01-01`, to: `${d.year}-12-31` })
  })

  test('the Reports page has no WCAG 2.2 AA violations with its form on it', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(page.getByRole('form', { name: NAME })).toBeVisible()
    await noAxeViolations(page)
  })

  test('its form asks for real dates, in order, and opens nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    const form = page.getByRole('form', { name: NAME })
    const open = form.getByRole('button', { name: 'Open Report in a new window' })

    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await form.getByLabel('From').fill('2022-12-31')
    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await form.getByLabel('To').fill('2022-01-01')
    await open.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(form.getByLabel('To')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('form', { name: 'Transaction listing' }).getByRole('alert')).toHaveCount(0) // the other forms are untouched
    expect(context.pages()).toHaveLength(1)
  })

  test('an address without dates, with dates the wrong way round, or with no such Account explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const [path, words, alert] of [
      ['/reports/income-vs-spending', 'Choose the first and last dates', false],
      ['/reports/income-vs-spending?from=2022-12-31&to=2022-01-01', 'before the “From” date', true],
      ['/reports/income-vs-spending?account=999999999&from=2022-01-01&to=2022-12-31', 'There is no such Account', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status')).toContainText(words)
      await expect(page.getByRole('button', { name: 'Open Report in a new window' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without dates
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
    await page.goto(address(null, `${year}-01-01`, `${year}-12-31`))
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
    return ['Total income', money(income), 'Total spending', spent(spending), 'Difference', signedMoney(income - spending)]
  }

  test('has the title block, what is counted, the totals, and a row for each month of the year, with nothing that is not Spending or Income in it', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))

    const report = article(page)
    await expect(report.getByRole('heading', { level: 1, name: NAME })).toBeVisible()
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Account: All Accounts: ')
    await expect(header).toContainText(`${d.everyday.name} (${d.everyday.number})`) // each Account, with its bank number
    await expect(header).toContainText(`${d.savings.name} (${d.savings.number})`)
    await expect(header).toContainText(`Dates: ${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`)
    await expect(header).toContainText(GENERATED)

    // Said before the figures: what Income and Spending are, that Uncategorised counts as Spending, and what is left out.
    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('Income is what the Income Categories brought in each month, less what went out of them.')
    await expect(about).toContainText('Spending is what the Spending Categories took out, less money back, such as a refund. A “back” amount is taken off the total.')
    await expect(about).toContainText('Uncategorised counts as spending, so money in that has no Category yet comes off it.')
    await expect(about).toContainText('The difference is income less spending, so it is below zero when more was spent than came in.')
    await expect(about).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME)

    expect(await totalsOf(page)).toEqual(expectedTotals(ALL))
    expect(await totalsOf(page)).toEqual(['Total income', '$8,999.50', 'Total spending', '$144.50', 'Difference', '+$8,855.00']) // the same, written out
    await expect(tableOf(page).getByRole('columnheader')).toHaveText(['Month', 'Income', 'Spending', 'Difference'])
    // A row for every month in the dates, oldest first, quiet ones too: a month with only a Transfer or a loan is a row of zeros, not a gap.
    expect(await rowsOf(page)).toEqual(ALL.map((figures, i) => cells(d.year, i, figures)))
    expect((await rowsOf(page))[0]).toEqual([`January ${d.year}`, '$3,000.00', '$150.00', '+$2,850.00'])
    expect((await rowsOf(page))[2]).toEqual([`March ${d.year}`, '$0.00', '$0.00', '$0.00']) // only the Transfer
    expect((await rowsOf(page))[6]).toEqual([`July ${d.year}`, '$0.00', '$0.00', '$0.00']) // only the loan
    await expect(report).not.toContainText('Only ') // the dates cover whole months
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
    await signInAs(context, 'member')

    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.everyday.name} (${d.everyday.number})`)
    expect(await rowsOf(page)).toEqual(EVERYDAY.map((figures, i) => cells(d.year, i, figures)))
    expect(await totalsOf(page)).toEqual(expectedTotals(EVERYDAY))

    await page.goto(address(savingsId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.savings.name} (${d.savings.number})`)
    expect(await rowsOf(page)).toEqual(SAVINGS.map((figures, i) => cells(d.year, i, figures))) // the $200.00 that came in is a Transfer: March is zeros
    expect(await totalsOf(page)).toEqual(['Total income', '$1.50', 'Total spending', '$20.00', 'Difference', '−$18.50'])
  })

  test('adds up only the dates asked for, both ends included, and says which part of a month at each end it counted', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    // 10 January to 20 April: January's wages (the 5th) and April's interest (the 30th) are outside the dates; the rest of both months is in.
    await page.goto(address(null, `${d.year}-01-10`, `${d.year}-04-20`))
    const rows = await rowsOf(page)
    expect(rows).toHaveLength(4) // January, February, March and April, and no others
    expect(rows[0]).toEqual([`January ${d.year} Only ${dateText(`${d.year}-01-10`)} to ${dateText(`${d.year}-01-31`)}`, '$0.00', '$150.00', '−$150.00'])
    expect(rows[1]).toEqual(cells(d.year, 1, ALL[1]!)) // a whole month, with no note
    expect(rows[2]).toEqual(cells(d.year, 2, ALL[2]!))
    expect(rows[3]).toEqual([`April ${d.year} Only ${dateText(`${d.year}-04-01`)} to ${dateText(`${d.year}-04-20`)}`, '$3,000.00', '$4.00', '+$2,996.00'])
    expect(await totalsOf(page)).toEqual(['Total income', '$6,000.00', 'Total spending', '$169.50', 'Difference', '+$5,830.50'])

    // One day: its month, counting only that day.
    await page.goto(address(null, `${d.year}-01-20`, `${d.year}-01-20`))
    expect(await rowsOf(page)).toEqual([[`January ${d.year} Only ${dateText(`${d.year}-01-20`)}`, '$0.00', '$90.00', '−$90.00']])
    await expect(article(page).locator('header dl div').filter({ hasText: 'Dates:' })).toHaveText(`Dates: ${dateText(`${d.year}-01-20`)}`) // one date, not "… to …"
  })

  test('says "back" for Spending that is less than nothing and writes the minus of Income that is, in a row and in the totals', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-06-01`, `${d.year}-08-31`)) // $2.00 of Income taken back, a loan, and $25.00 of Spending back
    expect(await rowsOf(page)).toEqual([
      [`June ${d.year}`, '−$2.00', '$0.00', '−$2.00'],
      [`July ${d.year}`, '$0.00', '$0.00', '$0.00'],
      [`August ${d.year}`, '$0.00', '$25.00 back', '+$25.00'],
    ])
    expect(await totalsOf(page)).toEqual(['Total income', '−$2.00', 'Total spending', '$25.00 back', 'Difference', '+$23.00'])
  })

  test('says there was no income or spending, and shows no table or totals, for dates with none', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-09-01`, `${d.year}-12-31`))
    await expect(section(page)).toContainText(`There was no income or spending in ${dateText(`${d.year}-09-01`)} to ${dateText(`${d.year}-12-31`)}.`)
    await expect(section(page).getByRole('table')).toHaveCount(0)
    await expect(section(page).locator('dl')).toHaveCount(0)
    await expect(article(page).getByRole('region', { name: 'About these figures' })).toBeVisible()

    await page.goto(address(null, `${d.year}-07-01`, `${d.year}-07-31`)) // only a loan: a whole month is named by its name
    await expect(section(page)).toContainText(`There was no income or spending in July ${d.year}.`)
  })

  test('is titled for Save as PDF: the app, the Report, the Accounts and the dates', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    const range = `${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – ${NAME} – All Accounts – ${range}`)
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – ${NAME} – ${d.everyday.name} – ${range}`)
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}, with money back, a minus sign and a part month to show`, async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, role)
      await page.goto(address(null, `${d.year}-01-10`, `${d.year}-12-31`))
      await expect(tableOf(page)).toBeVisible()
      await expect(tableOf(page)).toContainText('$25.00 back')
      await expect(tableOf(page)).toContainText('−$2.00')
      await expect(tableOf(page)).toContainText('Only ')
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    const cards = article(page).getByRole('list', { name: 'Income and spending by month' }).getByRole('listitem')
    await expect(cards).toHaveCount(12)
    await expect(cards.first()).toContainText(`January ${d.year}`)
    for (const [label, value] of [['Income', '$3,000.00'], ['Spending', '$130.00'], ['Difference', '+$2,870.00']]) {
      await expect(cards.first()).toContainText(label!)
      await expect(cards.first()).toContainText(value!)
    }
    await expect(cards.nth(5)).toContainText('−$2.00')
    await expect(cards.nth(7)).toContainText('$25.00 back')
  })

  test('shows every Member the same Report as the Admin', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['member', 'admin'] as const) {
      await signInAs(context, role)
      await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
      seen.push(JSON.stringify([await rowsOf(page), await totalsOf(page)]))
    }
    expect(seen[0]).toBe(seen[1])
  })

  test.describe('when the request fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: figures that were not read never look like none', async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'member')
      await page.route('**/api/reports/income-vs-spending?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByText('There was no income or spending')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Printed

test.describe('printed', () => {
  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(tableOf(page)).toBeVisible()
  })

  const range = (year: number) => `${dateText(`${year}-01-01`)} to ${dateText(`${year}-12-31`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectTitleBlock(article(page), { name: NAME, account: `${d.everyday.name} (${d.everyday.number})`, dates: range(d.year) })
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page, and says what is not counted', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectIdentityRow(page, `${TITLE} – ${NAME} – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`)
    await expect(page.locator('thead tr').first()).toContainText(NOT_COUNTED_AS_SPENDING_OR_INCOME) // so a loose page does not have to be read with the first
  })

  test('says "All Accounts" in the table heading when no Account was chosen, and leaves the title block to list them', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(tableOf(page)).toBeVisible()
    await expectIdentityRow(page, `${TITLE} – ${NAME} – All Accounts – ${range(d.year)}`)
    await expect(article(page).locator('header')).toContainText(`${d.everyday.name} (${d.everyday.number})`)
    await expect(page.locator('thead tr').first()).not.toContainText(d.everyday.name) // not once for every Account on every page
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – ${NAME} – ${d.everyday.name} – ${range(d.year)}`)
  })

  test('is black text on white paper, even from the dark theme', async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expectBlackOnWhite(page, 20) // every word, including the money, the minus signs and "back", is black
  })

  test('has no text under 12pt', async ({ page }) => {
    await expectNoTextUnder12pt(page, article(page), 20)
  })

  test('is its own page with its own margins, repeats the table heading and keeps a row whole', async ({ page }) => {
    await expectOwnPage(page)
  })

  test('prints every month, the totals and the page numbers, every figure in at least 12pt type, with the table heading on each page that has the table', async ({ page }, testInfo) => {
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
    expect(all).toContain(`Difference ${signedMoney(income - spending)}`)
    expectPageNumbers(pages)
    expectBareMargins(pages)
    expectNoTypeUnder12pt(pages, 50)
    // The table's heading, with what the Report is, who generated it and what is not counted, is on every page that has the table.
    const withTable = expectIdentityOnEveryPage(pages, 'Difference', `${TITLE} – ${NAME} – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`, 1)
    for (const p of withTable) expect(squash(textOf(p))).toContain(squash(NOT_COUNTED_AS_SPENDING_OR_INCOME))
  })

  test('prints the same from a phone-width window: still a table', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(tableOf(page)).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })
})

// A Report with more months than a page holds: fifteen years. The data is stubbed so the test adds nothing for the other specs to find.
test.describe('printed over several pages', () => {
  const YEARS = 15
  const FROM_YEAR = 2000
  const MONTHS = YEARS * 12
  /** Every month's figures are different, so a row can be told from the others in a PDF. */
  const incomeOf = (i: number) => 300_000 + i * 137
  const spendingOf = (i: number) => 250_000 - i * 211
  const monthAt = (i: number) => `${FROM_YEAR + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
  const rowOf = (i: number) => [monthName(FROM_YEAR + Math.floor(i / 12), i % 12), money(incomeOf(i)), spent(spendingOf(i)), signedMoney(incomeOf(i) - spendingOf(i))].join(' ')

  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    const months = Array.from({ length: MONTHS }, (_, i) => ({ month: monthAt(i), incomeCents: incomeOf(i), spendingCents: spendingOf(i), differenceCents: incomeOf(i) - spendingOf(i) }))
    const sum = (pick: (m: (typeof months)[number]) => number) => months.reduce((total, m) => total + pick(m), 0)
    await page.route('**/api/reports/income-vs-spending?**', (route) =>
      route.fulfill({
        json: {
          from: `${FROM_YEAR}-01-01`,
          to: `${FROM_YEAR + YEARS - 1}-12-31`,
          months,
          totals: { incomeCents: sum((m) => m.incomeCents), spendingCents: sum((m) => m.spendingCents), differenceCents: sum((m) => m.differenceCents) },
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
    for (const p of withRows) for (const heading of ['Month', 'Income', 'Spending', 'Difference']) expect(p.text.map((t) => t.str), `${heading} on page ${pages.indexOf(p) + 1}`).toContain(heading)

    // Every month is on exactly one page, as one row: its name and its three figures.
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    for (let i = 0; i < MONTHS; i++) expect(all.split(rowOf(i)).length - 1, rowOf(i)).toBe(1)
  })

  test('says what the Report is, which Accounts and dates, who generated it and when, and what is not counted, at the top of every page the table runs onto', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    // The Admin's title comes through as typed, quote and backslash too; the heading says "All Accounts", not each of them on every page.
    const withRows = expectIdentityOnEveryPage(pages, 'Difference', `${TITLE} – ${NAME} – All Accounts – ${dateText(`${FROM_YEAR}-01-01`)} to ${dateText(`${FROM_YEAR + YEARS - 1}-12-31`)}`, 3)
    for (const p of withRows) expect(squash(textOf(p)), `page ${pages.indexOf(p) + 1}`).toContain(squash(NOT_COUNTED_AS_SPENDING_OR_INCOME))
  })

  test('numbers every page "Page 2 of 5" in the bottom margin, and has nothing else in the margins', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expectPageNumbers(pages)
    expectBareMargins(pages)
  })

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    expectNoTypeUnder12pt(await readPdf(await page.pdf({ format: 'A4' })), 600) // 180 rows of four, and the rest
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Around the Report

test.describe('around the Report', () => {
  test('is titled for Save as PDF while it is open, and goes back to the app title when it is left', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    const { from, to } = wholeYear(d.year)
    await page.goto(address(null, from, to))
    await expect(page).toHaveTitle(`Mum's finances – ${NAME} – All Accounts – ${dateText(from)} to ${dateText(to)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })
})
