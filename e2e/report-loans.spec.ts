import type { BrowserContext, Locator, Page } from '@playwright/test'
import { clearDate, dateField, expectDate, pickDate } from './date-helpers'
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
  NOW,
  overrideCategories,
  restoreAppTitleAfterEach,
  setTitle,
  signInToOpen,
  squash,
  stubKeeping,
  TITLE,
  type SeedRow,
} from './report-helpers'

// Ticket 38: the Loans Report. It uses the Report frame of ticket 18, so it is shown on its own page, under its form, says on its face what it is, and prints with its table heading on
// every page. Which Transactions are loans is held to the shared spending definition in worker/report-loans.test.ts, and the sums and wording are in
// src/lib/report-loans.test.ts; this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it makes (page count, the
// text on each page, the margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// WHERE THE DATA IS. The light and dark projects share one local database with every other spec, and every year from 2000 to 2020 has an owner, so this spec takes the last three
// months of 2002 (light) and of 2003 (dark), and makes only what no other spec's figures can see:
// - Its Transactions are loans, Income and one Transfer (both halves). None is Spending, so the Spending by Category Report that owns those years (report-spending.spec.ts, all
//   Accounts, January to September) is the same with them there, and so are the Budget vs actual (2000 and 2001) and the Dashboard (2004), which add up Spending and Income by
//   Category. A Transfer is paired only with a Transaction of the same date and amount, and nothing else is dated in these months.
// - The specs that read every Account's Transactions, balances or Transfers over their dates have other years (the Transaction listing 2013 and 2014, balances 2005 to 2010
//   and 2015 to 2020, Transfers 2011, the Transactions page 2012, the Change Log 2017, Import 2018 and 2019), and a Transaction this old is last in an unfiltered list, never on
//   its first page.
// - Its Accounts have their own numbers, and a bank balance of nothing on 31 December, so their balances are nothing before and after the three months.
// - Its names are ones no other spec looks for by a part: Categories.spec finds the starter Category by /^Loans/, so nothing here begins with "Loans" (the Accounts and the wages
//   are "Lending ...", the loans "Loan – Name", which has no "s"), and Groceries and Wages and salary are not part of any name.
// In the other direction, a Report of all the Loans Categories lists what other specs made too, so a test of it looks for this spec's loans by name, and one that needs exact
// totals stubs the answer. Payees avoid "EXAMPLE", which other specs' Rules look for.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  const alice = light ? 'Alice' : 'Dana' // a person the parent lends to
  const ben = light ? 'Ben' : 'Eli' // a person the parent borrows from
  return {
    project,
    year: light ? 2002 : 2003,
    parent: { number: light ? '99-9999-9999999-48' : '99-9999-9999999-68', name: `Lending parent ${project}` },
    child: { number: light ? '99-9999-9999999-49' : '99-9999-9999999-69', name: `Lending child ${project}` },
    alice,
    ben,
    aliceLoan: `Loan – ${alice}`,
    benLoan: `Loan – ${ben}`,
    wages: `Lending spec wages ${project}`,
    unused: `Lending spec unused ${project}`, // a Loans Category nothing is ever put in
  }
}

// What the three months hold, by Category, in cents (money out is negative). Alice is lent $450.00 and, by a Transfer to her tracked Account that the Admin gave her Category
// on the half in the lender's Account, $50.00 more; she pays back $100.00 twice, once into each Account. Ben lends the parent $500.00 and is paid back $200.00. The parent also
// has wages ($1,234.56, Income), and the other half of the $50.00 Transfer is in the child's Account: neither is a loan.
const ALICE = { lent: -45_000, repaid1: 10_000, repaid2: 10_000, transferred: -5000 }
const BEN = { lends: 50_000, repaid: -20_000 }
const WAGES = 123_456
/** The day of each Transaction, as `MM-DD`. */
const ON = { aliceLent: '10-01', benLends: '10-15', repaid1: '11-01', benRepaid: '11-15', wages: '11-20', repaid2: '12-01', transferred: '12-15' }

/** What an amount reads as in a table: signed, as the app writes it. */
const signed = (cents: number) => `${cents > 0 ? '+' : ''}${money(cents)}`
/** The table's column headings in a PDF, in order and with no spaces: a narrow column breaks "Owed after" over two lines, so the words are not looked for one run at a time. */
const HEADINGS = squash('Date Description Account Note Amount Owed after')

type Seeded = { aliceId: number; benId: number; groceriesId: number }
const seeded = new Map<string, Seeded>()

/** The project's two Accounts, its two Loans Categories, its wages and their Transactions (see ALICE and BEN). Safe to repeat: an Import recognises rows it already holds. */
async function seed(context: BrowserContext, baseURL: string, project: string): Promise<Seeded> {
  const known = seeded.get(project)
  if (known) return known
  const d = dataFor(project)
  const { year } = d
  await signInAs(context, 'admin')

  const categories = {
    [d.aliceLoan]: await ensureCategory(context, baseURL, d.aliceLoan, 'loans'),
    [d.benLoan]: await ensureCategory(context, baseURL, d.benLoan, 'loans'),
    [d.wages]: await ensureCategory(context, baseURL, d.wages, 'income'),
    [d.unused]: await ensureCategory(context, baseURL, d.unused, 'loans'),
  }
  const say = (what: string) => `LOANRPT ${project} ${what}`
  const parentRows: SeedRow[] = [
    { date: `${year}-${ON.aliceLent}`, payee: say('lent'), amountCents: ALICE.lent, category: d.aliceLoan },
    { date: `${year}-${ON.repaid1}`, payee: say('repaid first'), amountCents: ALICE.repaid1, category: d.aliceLoan },
    { date: `${year}-${ON.transferred}`, payee: say('lent by transfer'), amountCents: ALICE.transferred, category: d.aliceLoan }, // the other half is in the child's Account: a Transfer
    { date: `${year}-${ON.benLends}`, payee: say('lent to us'), amountCents: BEN.lends, category: d.benLoan },
    { date: `${year}-${ON.benRepaid}`, payee: say('paid back'), amountCents: BEN.repaid, category: d.benLoan },
    { date: `${year}-${ON.wages}`, payee: say('wages'), amountCents: WAGES, category: d.wages },
  ]
  const childRows: SeedRow[] = [
    { date: `${year}-${ON.repaid2}`, payee: say('repaid second'), amountCents: ALICE.repaid2, category: d.aliceLoan },
    { date: `${year}-${ON.transferred}`, payee: say('from parent by transfer'), amountCents: 5000 },
  ]
  await importRows(context, baseURL, { account: d.parent, rows: parentRows, idPrefix: `LRP${year}P`, year })
  await importRows(context, baseURL, { account: d.child, rows: childRows, idPrefix: `LRP${year}C`, year }) // the second Account pairs its $50.00 in with the first's $50.00 out

  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const idOf = (name: string) => accounts.find((a) => a.name === name)!.id
  await overrideCategories(context, baseURL, { accountId: idOf(d.parent.name), year, rows: parentRows, categories })
  await overrideCategories(context, baseURL, { accountId: idOf(d.child.name), year, rows: childRows, categories })
  // A Note on the first repayment, as the Transaction listing shows one.
  const { transactions } = (await (await context.request.get(`/api/transactions?accountId=${idOf(d.parent.name)}&from=${year}-01-01&to=${year}-12-31&limit=200&count=false`)).json()) as { transactions: { id: number; description: string }[] }
  const first = transactions.find((t) => t.description === say('repaid first'))
  expect(first).toBeDefined()
  expect((await context.request.put(`/api/transactions/${first!.id}/note`, { headers: { Origin: baseURL }, data: { note: 'First repayment' } })).ok()).toBe(true)

  const groceriesId = ((await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]).find((c) => c.name === 'Groceries')?.id ?? -1
  const result = { aliceId: categories[d.aliceLoan]!, benId: categories[d.benLoan]!, groceriesId }
  seeded.set(project, result)
  return result
}

restoreAppTitleAfterEach() // the Settings are shared by every test and both themes (as reports.spec.ts does)
forgetKeptReportsAfterEach() // so is the list of kept Reports, which the Admin showing a Report adds to

/** The Report's address: `category` is left out for every Loans Category, `from` for the first Transaction. */
const address = (category: number | null, from: string | null, to: string) => `/reports/loans?${category === null ? '' : `category=${category}&`}${from === null ? '' : `from=${from}&`}to=${to}`
const article = (page: Page) => page.getByRole('article', { name: 'Loans', exact: true })
const sectionOf = (page: Page, name: string) => article(page).getByRole('region', { name, exact: true })
const tableOf = (page: Page, name: string) => article(page).getByRole('table', { name: `Transactions in ${name}` })
/** A table's rows as the text of their cells, spaces collapsed. */
const rowsOf = async (table: Locator) => {
  await table.locator('tbody tr').first().waitFor() // the Report has loaded
  return table.locator('tbody tr').evaluateAll((rows) => rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.replace(/\s+/g, ' ').trim())))
}
/** The section's figures as `[term, details]`. */
const figuresOf = async (section: Locator) => {
  await section.locator('dl > div').first().waitFor() // the Report has loaded
  return section.locator('dl > div').evaluateAll((rows) => rows.map((div) => [div.querySelector('dt')!.textContent!.trim(), div.querySelector('dd')!.textContent!.trim()]))
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('its page has a form of its own, for one Loans Category or all of them, that shows the Report under it', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await page.goto('/reports/loans')
    await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()

    const form = page.getByRole('form', { name: 'Loans' })
    // The hint for the From date, which may be left blank, stays with the field; how the Report knows who owes whom is in the page's help sheet.
    await expect(dateField(form, 'From (optional)')).toHaveAccessibleDescription('Leave From blank to begin at the first Transaction, or choose a date to see what was owed before it.')
    await expect(form).not.toContainText('Name each Category')
    const help = await openHelp(page)
    await expect(help).toContainText('Name each Category for its person, like “Loan – Alice”')
    await expect(help).not.toContainText('Leave From blank')
    await page.keyboard.press('Escape')
    const loan = form.getByLabel('Loan', { exact: true })
    await expect(loan).toHaveValue('') // every Loans Category unless one is chosen
    // Only Loans Categories are offered: the starter one and the Admin's own, and no Spending or Income Category.
    const offered = await loan.locator('option').allTextContents()
    expect(offered).toEqual(expect.arrayContaining(['All loans', 'Loans', d.aliceLoan, d.benLoan]))
    expect(offered).not.toContain('Groceries')
    expect(offered).not.toContain(d.wages)
    await expect(form.getByRole('status')).toContainText('Loans Categories to choose from.') // said to a screen reader when the list arrives

    // The last date starts at today (the NZ date), and the first is blank.
    await expectDate(form, 'To', '2026-10-08')
    await expectDate(form, 'From (optional)', '')
    await pickDate(form, 'To', `${d.year}-12-31`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page).locator('header')).toContainText('Loans: All Loans Categories')
    expect(new URL(page.url()).pathname).toBe('/reports/loans')
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ to: `${d.year}-12-31` }) // every Loans Category, from the first Transaction: neither in the address

    await loan.selectOption({ label: d.aliceLoan })
    await pickDate(form, 'From (optional)', `${d.year}-11-01`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page).locator('header')).toContainText(`Loans: ${d.aliceLoan}`)
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ category: String(aliceId), from: `${d.year}-11-01`, to: `${d.year}-12-31` })
    await expect(loan).toHaveValue(String(aliceId)) // the form is still there, filled in from the address
  })

  test('the Back button puts the Loan back as the address has it, a choice that was not asked for included', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(aliceId, null, `${d.year}-12-31`))
    const form = page.getByRole('form', { name: 'Loans' })
    const loan = form.getByLabel('Loan', { exact: true })
    await expect(loan.locator('option:checked')).toHaveText(d.aliceLoan)

    await pickDate(form, 'To', `${d.year}-11-30`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(page).toHaveURL(new RegExp(`to=${d.year}-11-30`)) // the same Loan, another date
    await loan.selectOption({ label: d.benLoan }) // not asked for
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`to=${d.year}-12-31`))
    await expect(loan).toHaveValue(String(aliceId)) // the address's, and not the one chosen after it
    await expect(loan.locator('option:checked')).toHaveText(d.aliceLoan)
  })

  test('its form needs only the date to go up to: the start date may be left blank, and a start date must be a date, in order', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/loans')
    const form = page.getByRole('form', { name: 'Loans' })
    const show = form.getByRole('button', { name: 'Show Report' })
    const to = dateField(form, 'To')

    await clearDate(form, 'To') // it starts at today
    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.') // not "Choose a From date."
    await pickDate(form, 'To', '2001-12-31')
    await pickDate(form, 'From (optional)', '2001-12-31')
    await pickDate(form, 'To', '2001-01-01')
    await show.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(to).toHaveAttribute('aria-invalid', 'true')
    expect(new URL(page.url()).search).toBe('') // nothing was asked for

    await clearDate(form, 'From (optional)') // blank is allowed
    await show.click()
    await expect(form.getByRole('alert')).toHaveCount(0)
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ to: '2001-01-01' })
  })

  test('an address without the date to go up to, with dates the wrong way round, or with no such Loans Category explains itself and offers the form', async ({ page, context, baseURL }, testInfo) => {
    const { groceriesId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    for (const [path, words, alert] of [
      ['/reports/loans?from=2001-01-01', 'Choose the last date this Report covers.', false],
      ['/reports/loans?category=3', 'Choose the last date this Report covers.', false],
      ['/reports/loans?from=2001-12-31&to=2001-01-01', 'before the “From” date', true],
      ['/reports/loans?category=999999999&to=2001-12-31', 'It may have been removed, or may no longer be a Loans Category', true],
      ['/reports/loans?category=abc&to=2001-12-31', 'There is no such Loans Category', true],
      ['/reports/loans?category=0&to=2001-12-31', 'There is no such Loans Category', true],
      // A Spending Category is not a loan, so it has no Report even when its ID is asked for.
      [`/reports/loans?category=${groceriesId}&to=2001-12-31`, 'There is no such Loans Category', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status').filter({ hasText: words })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Show Report' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without a Loans Category and the date
    }
  })

  test('an address from before the form was on the page, with a blank Loan and a blank From, is the Report of every Loans Category from the first Transaction', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/reports/loans?category=&from=&to=${d.year}-12-31`) // what the form used to send for All loans and no start date
    await expect(article(page).locator('header')).toContainText('Loans: All Loans Categories')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('its page with nothing in the address is the form alone, with no complaint that nothing is chosen', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/loans')
    await expect(page.getByRole('form', { name: 'Loans' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: /^Choose the / })).toHaveCount(0)
    await expect(article(page)).toHaveCount(0)
  })

  test('says there are no Loans Categories yet, and links to where to make one, when there are none', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/categories', (route) => route.fulfill({ json: [{ id: 1, name: 'Groceries', kind: 'spending' }, { id: 2, name: 'Wages and salary', kind: 'income' }] }))
    await page.goto('/reports/loans?to=2001-12-31')
    await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'There are no Loans Categories to report on yet.' })).toBeVisible()
    const form = page.getByRole('form', { name: 'Loans' })
    await expect(form).toContainText('The Admin makes one for each person on the Categories page, named like Loan – Alice, and sets its kind to Loans.') // where to make one, and how to name it
    await expect(form.getByRole('link', { name: 'Categories page' })).toHaveAttribute('href', '/categories')
    await expect(form.getByRole('status')).toHaveText('There are no Loans Categories yet.') // and what a screen reader hears when the list arrives
    await expect(article(page)).toHaveCount(0)
    await expect(form.getByLabel('Loan', { exact: true }).locator('option')).toHaveText(['All loans'])
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.addInitScript(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => void ((window as unknown as { printed: number }).printed += 1)
    })
    await page.goto(address(null, null, `${d.year}-12-31`))
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

  test('has the title block, what the figures are, and a section for each Loans Category, each with how much is owed on the last date', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    await page.goto(address(null, null, `${d.year}-12-31`))

    const report = article(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible() // the page's heading, above the form: the Report's own title is text on screen and the h1 on paper
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Loans: All Loans Categories')
    await expect(header).toContainText('Account: All Accounts: ')
    await expect(header).toContainText(`${d.parent.name} (${d.parent.number})`) // each Account, with its bank number
    await expect(header).toContainText(`${d.child.name} (${d.child.number})`)
    await expect(header).toContainText(`Dates: From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
    await expect(header).toContainText(GENERATED)

    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('Each loan is a Loans Category, one for each person, named like Loan – Alice.')
    await expect(about).toContainText('the person owes the difference to the Accounts')
    await expect(about).toContainText("Loans aren't counted as spending or income")
    // How a Transfer counts: on the half in the lender's Account only, because giving it to both cancels out.
    await expect(about).toContainText("Give it to the half in the lender's Account only")

    // Each Loans Category of this project has its section, in order of name.
    const headings = await report.getByRole('heading', { level: 2 }).allTextContents()
    expect(headings.indexOf(d.aliceLoan)).toBeGreaterThanOrEqual(0)
    expect(headings.indexOf(d.benLoan)).toBeGreaterThan(headings.indexOf(d.aliceLoan))

    // Money out of $500.00 and repayments in of $200.00: the person owes $300.00 to the Accounts. Reversed, they are owed it.
    const lastDay = `Owed on ${dateText(`${d.year}-12-31`)}`
    expect(await figuresOf(sectionOf(page, d.aliceLoan))).toEqual([
      ['Money out', signed(ALICE.lent + ALICE.transferred)],
      ['Money in', signed(ALICE.repaid1 + ALICE.repaid2)],
      [lastDay, `${d.alice} owes $300.00 to the Accounts`],
    ])
    expect(await figuresOf(sectionOf(page, d.benLoan))).toEqual([
      ['Money out', signed(BEN.repaid)],
      ['Money in', signed(BEN.lends)],
      [lastDay, `${d.ben} is owed $300.00`],
    ])
    await expect(sectionOf(page, d.aliceLoan)).not.toContainText('Opening balance') // there is no start date
    await expect(report.getByText('we owe', { exact: false })).toHaveCount(0)
  })

  test('says once, in the words of the Report, which Loans Categories nothing has happened on yet, and leaves them out of the sections', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(null, null, `${d.year}-12-31`))
    const report = article(page)
    await expect(sectionOf(page, d.aliceLoan)).toBeVisible()
    // This spec's own Loans Category, which nothing has ever been put in, is no empty section: it is named in the one line instead.
    await expect(sectionOf(page, d.unused)).toHaveCount(0)
    const note = report.getByText(/^Nothing has been lent or repaid up to .* on .*, so (it is|they are) not shown\.$/)
    await expect(note).toContainText(dateText(`${d.year}-12-31`))
    await expect(note).toContainText(d.unused)
  })

  test('lists a loan\'s lending and repayments oldest first, from either Account, with the Account, the Note and what is owed after each', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(null, null, `${d.year}-12-31`))

    const table = tableOf(page, d.aliceLoan)
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Description', 'Account', 'Note', 'Amount', 'Owed after'])
    const rows = await rowsOf(table)
    expect(rows.map((r) => [r[0], r[1], r[2], r[4], r[5]])).toEqual([
      [dateText(`${d.year}-${ON.aliceLent}`), `LOANRPT ${d.project} lent`, d.parent.name, `${signed(ALICE.lent)} Money out`, `$450.00 ${d.alice} owes`],
      [dateText(`${d.year}-${ON.repaid1}`), `LOANRPT ${d.project} repaid first`, d.parent.name, `${signed(ALICE.repaid1)} Money in`, `$350.00 ${d.alice} owes`],
      [dateText(`${d.year}-${ON.repaid2}`), `LOANRPT ${d.project} repaid second`, d.child.name, `${signed(ALICE.repaid2)} Money in`, `$250.00 ${d.alice} owes`],
      // The half of a Transfer the Admin gave this Category is a loan; the other half, in the child's Account, is not.
      [dateText(`${d.year}-${ON.transferred}`), `LOANRPT ${d.project} lent by transfer`, d.parent.name, `${signed(ALICE.transferred)} Money out`, `$300.00 ${d.alice} owes`],
    ])
    expect(rows[1]![3]).toBe('First repayment') // the Note, as the Transaction listing shows it
    expect(rows[0]![3]).toContain('No Note')
    // The last balance is what is owed on the last date.
    await expect(sectionOf(page, d.aliceLoan).locator('dl')).toContainText(`${d.alice} owes $300.00 to the Accounts`)

    // The Accounts owe Ben: what is owed after each Transaction is the other way round, and says so.
    const benRows = await rowsOf(tableOf(page, d.benLoan))
    expect(benRows.map((r) => [r[1], r[4], r[5]])).toEqual([
      [`LOANRPT ${d.project} lent to us`, `${signed(BEN.lends)} Money in`, `$500.00 ${d.ben} is owed`],
      [`LOANRPT ${d.project} paid back`, `${signed(BEN.repaid)} Money out`, `$300.00 ${d.ben} is owed`],
    ])
  })

  test('leaves out what is not a loan: wages, the other half of a Transfer, and the other person\'s loan', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(null, null, `${d.year}-12-31`))
    const alice = sectionOf(page, d.aliceLoan)
    await expect(alice.getByRole('table')).toBeVisible()
    await expect(alice).not.toContainText('wages')
    await expect(alice).not.toContainText('from parent by transfer')
    await expect(alice).not.toContainText('lent to us')
    await expect(sectionOf(page, d.benLoan)).not.toContainText('lent by transfer')
    await expect(article(page)).not.toContainText('wages')
    await expect(article(page)).not.toContainText(money(WAGES))
  })

  test('lists one Loans Category when one is chosen, and says which in the title block and the page title', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    await page.goto(address(aliceId, null, `${d.year}-12-31`))

    await expect(article(page).locator('header')).toContainText(`Loans: ${d.aliceLoan}`)
    await expect(article(page).getByRole('heading', { level: 2 })).toHaveText(['About these figures', d.aliceLoan]) // only that loan, and no summary of one
    await expect(page).toHaveTitle(`Mum's finances – Loans – ${d.aliceLoan} – From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
    await page.goto(address(null, null, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText('Loans: All Loans Categories')
    await expect(page).toHaveTitle(`Mum's finances – Loans – All loans – From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
  })

  test('with several loans, begins with what each owes on the last date and the totals owed to and by the Accounts, which it never nets', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(address(null, null, `${d.year}-12-31`))

    const summary = sectionOf(page, 'All loans')
    const table = summary.getByRole('table', { name: 'What each loan owes' })
    await expect(table.getByRole('columnheader')).toHaveText(['Loan', `Owed on ${dateText(`${d.year}-12-31`)}`])
    await expectTableLook(table)
    const lines = await rowsOf(table)
    // This spec's loans are among the ones in the Report, a line each, and in the order of the sections below.
    expect(lines).toContainEqual([d.aliceLoan, `${d.alice} owes $300.00 to the Accounts`])
    expect(lines).toContainEqual([d.benLoan, `${d.ben} is owed $300.00`])
    expect(lines.findIndex((l) => l[0] === d.aliceLoan)).toBeLessThan(lines.findIndex((l) => l[0] === d.benLoan))
    // Two totals, each at least this spec's own (other specs' loans may add to them, if they were before these dates), and neither the difference of the two.
    const totals = Object.fromEntries(await figuresOf(summary))
    const dollars = (text: string) => Number(text.replace(/[$,]/g, ''))
    expect(dollars(totals['Owed to the Accounts']!)).toBeGreaterThanOrEqual(300)
    expect(dollars(totals['Owed by the Accounts']!)).toBeGreaterThanOrEqual(300)
    expect(Object.keys(totals)).toEqual(['Owed to the Accounts', 'Owed by the Accounts'])
  })

  test('with a start date, begins with what was owed before it, and goes on from there to the same amount owed on the last date', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId, benId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    const start = `${d.year}-11-01`

    await page.goto(address(aliceId, start, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Dates: ${dateText(start)} to ${dateText(`${d.year}-12-31`)}`)
    expect(await figuresOf(sectionOf(page, d.aliceLoan))).toEqual([
      [`Opening balance (before ${dateText(start)})`, `${d.alice} owes $450.00 to the Accounts`],
      ['Money out', signed(ALICE.transferred)],
      ['Money in', signed(ALICE.repaid1 + ALICE.repaid2)],
      [`Owed on ${dateText(`${d.year}-12-31`)}`, `${d.alice} owes $300.00 to the Accounts`],
    ])
    expect((await rowsOf(tableOf(page, d.aliceLoan))).map((r) => [r[1], r[5]])).toEqual([
      [`LOANRPT ${d.project} repaid first`, `$350.00 ${d.alice} owes`], // from the opening $450.00, not from nothing
      [`LOANRPT ${d.project} repaid second`, `$250.00 ${d.alice} owes`],
      [`LOANRPT ${d.project} lent by transfer`, `$300.00 ${d.alice} owes`],
    ])

    await page.goto(address(benId, start, `${d.year}-12-31`))
    expect(await figuresOf(sectionOf(page, d.benLoan))).toEqual([
      [`Opening balance (before ${dateText(start)})`, `${d.ben} is owed $500.00`],
      ['Money out', signed(BEN.repaid)],
      ['Money in', signed(0)],
      [`Owed on ${dateText(`${d.year}-12-31`)}`, `${d.ben} is owed $300.00`],
    ])
  })

  test('stops at the date chosen: what was owed up to it, and nothing after', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')

    await page.goto(address(aliceId, null, `${d.year}-11-30`))
    expect((await rowsOf(tableOf(page, d.aliceLoan))).map((r) => r[1])).toEqual([`LOANRPT ${d.project} lent`, `LOANRPT ${d.project} repaid first`])
    expect(await figuresOf(sectionOf(page, d.aliceLoan))).toContainEqual([`Owed on ${dateText(`${d.year}-11-30`)}`, `${d.alice} owes $350.00 to the Accounts`])
  })

  test('says what is owed when a loan has nothing in the dates, and plainly that it was never used when it was not', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')

    // Before the first Transaction: nothing has been lent or repaid up to the date.
    await page.goto(address(aliceId, null, `${d.year}-09-30`))
    let alice = sectionOf(page, d.aliceLoan)
    await expect(alice).toContainText(`Nothing has been lent or repaid on this loan up to ${dateText(`${d.year}-09-30`)}.`)
    await expect(alice.getByRole('table')).toHaveCount(0)
    await expect(alice.locator('dl')).toHaveCount(0)

    // After its last Transaction: nothing in the dates, and what was owed before them is what is owed.
    await page.goto(address(aliceId, `${d.year}-12-16`, `${d.year}-12-31`))
    alice = sectionOf(page, d.aliceLoan)
    await expect(alice).toContainText('No Transactions in these dates.')
    expect(await figuresOf(alice)).toEqual([
      [`Opening balance (before ${dateText(`${d.year}-12-16`)})`, `${d.alice} owes $300.00 to the Accounts`],
      ['Money out', signed(0)],
      ['Money in', signed(0)],
      [`Owed on ${dateText(`${d.year}-12-31`)}`, `${d.alice} owes $300.00 to the Accounts`],
    ])
  })

  test('is in no spending: the Spending by Category Report for the same months says nothing was spent, with the loans, the wages and the Transfer all in them', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/reports/spending?from=${d.year}-10-01&to=${d.year}-12-31`)
    const spending = page.getByRole('article', { name: 'Spending by Category' })
    // Nobody else has Transactions in these months (see the note on this spec's data), so this is only what this spec holds.
    await expect(spending.getByRole('region', { name: 'Spending in each Category' })).toContainText('Nothing was spent in')
    await expect(spending.getByRole('table')).toHaveCount(0)
    await expect(spending).not.toContainText(d.aliceLoan)
    await expect(spending).not.toContainText(d.benLoan)
  })

  for (const role of ['admin', 'member'] as const) {
    test(`has no WCAG 2.2 AA violations as ${role === 'admin' ? 'the Admin' : 'a Member, who opens the Report the Admin kept'}, with a loan owed to and one owed by`, async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInToOpen(context, baseURL, role, { report: 'loans', from: `${d.year}-11-01`, to: `${d.year}-12-31` })
      await page.goto(address(null, `${d.year}-11-01`, `${d.year}-12-31`))
      await expect(tableOf(page, d.aliceLoan)).toBeVisible()
      await expect(tableOf(page, d.benLoan)).toContainText(`${d.ben} is owed`)
      await expect(sectionOf(page, 'All loans')).toBeVisible()
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(address(aliceId, null, `${d.year}-12-31`))
    const cards = article(page).getByRole('list', { name: `Transactions in ${d.aliceLoan}` }).getByRole('listitem')
    await expect(cards).toHaveCount(4)
    await expect(cards.first()).toContainText(`LOANRPT ${d.project} lent`)
    await expect(cards.first()).toContainText('Owed after')
    await expect(cards.first()).toContainText('$450.00')
    await expect(cards.first()).toContainText(`${d.alice} owes`)
    await expect(cards.last()).toContainText('$300.00')
    await expect(cards.last()).toContainText(`${d.alice} owes`)
    await expect(cards.nth(1)).toContainText('First repayment')
  })

  test('shows a Member the same Report as the Admin, once the Admin has kept it', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['admin', 'member'] as const) {
      await signInToOpen(context, baseURL, role, { report: 'loans', to: `${d.year}-12-31` })
      await page.goto(address(null, null, `${d.year}-12-31`))
      await expect(tableOf(page, d.aliceLoan)).toBeVisible()
      seen.push(JSON.stringify([await rowsOf(tableOf(page, d.aliceLoan)), await figuresOf(sectionOf(page, d.aliceLoan)), await figuresOf(sectionOf(page, d.benLoan))]))
    }
    expect(seen[0]).toBe(seen[1])
  })

  test.describe('when the request fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: a loan that was not read never looks like one with nothing owed', async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'admin')
      await page.route('**/api/reports/loans?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(address(null, null, `${d.year}-12-31`))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByText('owes nothing')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })

  // The totals and the loans nothing has happened on need exact answers, which the shared database cannot give (other specs have loans too), so the Worker's answers are stubbed.
  test.describe('with the Worker\'s answers stubbed', () => {
    type Stub = { id: number; name: string; opening?: { cents: number; count: number }; rows: { amountCents: number; date?: string }[] }
    const stubLoans = async (page: Page, loans: Stub[]) => {
      await stubKeeping(page)
      await page.route('**/api/categories', (route) => route.fulfill({ json: loans.map((l) => ({ id: l.id, name: l.name, kind: 'loans' })) }))
      await page.route('**/api/reports/loans?**', (route) => {
        const params = new URL(route.request().url()).searchParams
        const loan = loans.find((l) => l.id === Number(params.get('categoryId')))!
        return route.fulfill({
          json: {
            category: { id: loan.id, name: loan.name },
            opening: params.get('after') === null ? (loan.opening ?? { cents: 0, count: 0 }) : null,
            transactions: loan.rows.map((r, i) => ({ id: loan.id * 100 + i, date: r.date ?? '2002-10-01', description: `Stub payment ${loan.id}.${i}`, amountCents: r.amountCents, accountName: 'Stub account', note: null })),
            next: null,
          },
        })
      })
    }

    test('adds up what the Accounts are owed and what they owe, each on its own and never as the difference, and leaves out a loan with no amount', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await stubLoans(page, [
        { id: 1, name: 'Loan – Alice', rows: [{ amountCents: -50_000 }, { amountCents: 20_000 }] }, // owes $300.00
        { id: 2, name: 'Loan – Ben', rows: [{ amountCents: 30_000 }] }, // is owed $300.00
        { id: 3, name: 'Loan – Carol', rows: [{ amountCents: -100_000 }] }, // owes $1,000.00
        { id: 4, name: 'Loan – Dan', rows: [{ amountCents: 1 }, { amountCents: -1 }] }, // level
      ])
      await page.goto('/reports/loans?to=2002-12-31')
      const summary = sectionOf(page, 'All loans')
      expect(await rowsOf(summary.getByRole('table', { name: 'What each loan owes' }))).toEqual([
        ['Loan – Alice', 'Alice owes $300.00 to the Accounts'],
        ['Loan – Ben', 'Ben is owed $300.00'],
        ['Loan – Carol', 'Carol owes $1,000.00 to the Accounts'],
        ['Loan – Dan', 'Dan owes nothing'],
      ])
      expect(await figuresOf(summary)).toEqual([['Owed to the Accounts', '$1,300.00'], ['Owed by the Accounts', '$300.00']]) // not $1,000.00, the difference
      await expect(summary).not.toContainText('leave out')
    })

    test('leaves the Loans Categories nothing has happened on out of the sections, naming them once, and says so when that is every one', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await stubLoans(page, [
        { id: 1, name: 'Loan – Alice', rows: [{ amountCents: -50_000 }] },
        { id: 2, name: 'Loans', rows: [] }, // the starter Category, never used
        { id: 3, name: 'Loan – Carol', rows: [], opening: { cents: 0, count: 2 } }, // lent and paid back before the dates: not unused
      ])
      await page.goto('/reports/loans?from=2002-10-01&to=2002-12-31')
      const report = article(page)
      await expect(sectionOf(page, 'Loan – Alice')).toBeVisible()
      await expect(sectionOf(page, 'Loan – Carol')).toContainText('No Transactions in these dates.')
      expect(await figuresOf(sectionOf(page, 'Loan – Carol'))).toContainEqual([`Owed on ${dateText('2002-12-31')}`, 'Carol owes nothing'])
      await expect(sectionOf(page, 'Loans')).toHaveCount(0)
      await expect(report.getByText(`Nothing has been lent or repaid up to ${dateText('2002-12-31')} on Loans, so it is not shown.`)).toBeVisible()
      await expect(sectionOf(page, 'All loans')).toBeVisible() // two loans were used, so there is a summary of them

      // Only the unused one: nothing at all to list.
      await page.unroute('**/api/reports/loans?**')
      await page.unroute('**/api/categories')
      await stubLoans(page, [{ id: 2, name: 'Loans', rows: [] }, { id: 5, name: 'Loan – Eve', rows: [] }])
      await page.goto('/reports/loans?to=2002-12-31')
      await expect(report.getByText(`Nothing has been lent or repaid on any Loans Category up to ${dateText('2002-12-31')}.`)).toBeVisible()
      await expect(report.getByRole('region', { name: 'Loan – Eve' })).toHaveCount(0)

      // Asked for by name, an unused loan is a section that says so plainly.
      await page.goto('/reports/loans?category=5&to=2002-12-31')
      await expect(sectionOf(page, 'Loan – Eve')).toContainText(`Nothing has been lent or repaid on this loan up to ${dateText('2002-12-31')}.`)
    })
  })

  test.describe('when it stops at the cap of 5,000 Transactions', () => {
    test('says so at the top and the end, marks the loan it stopped in partly listed with no amount owed at the end, and the loans after it not listed, unread', async ({ page, context }) => {
      test.setTimeout(120_000) // five full pages, and five thousand rows to draw
      await signInAs(context, 'admin')
      // Three loans, the first with more than the cap in the range: every page is full, and there is always one more. The cap falls part way through the first.
      const loans = [{ id: 1, name: 'Loan – First', kind: 'loans' }, { id: 2, name: 'Loan – Second', kind: 'loans' }, { id: 3, name: 'Loan – Third', kind: 'loans' }]
      await page.route('**/api/categories', (route) => route.fulfill({ json: loans }))
      const asked: string[] = []
      const limits: number[] = []
      await page.route('**/api/reports/loans?**', async (route) => {
        const params = new URL(route.request().url()).searchParams
        asked.push(params.get('categoryId')!)
        const limit = Number(params.get('limit'))
        limits.push(limit)
        const after = params.get('after')
        const start = after === null ? 0 : Number(after.split(':')[1])
        const transactions = Array.from({ length: limit }, (_, k) => ({ id: start + k + 1, date: '2002-10-02', description: `Stub ${start + k + 1}`, amountCents: -100, accountName: 'Stub account', note: null }))
        await route.fulfill({ json: { category: { id: 1, name: 'Loan – First' }, opening: after === null ? { cents: 0, count: 0 } : null, transactions, next: `2002-10-02:${start + limit}` } })
      })
      await page.goto('/reports/loans?to=2002-12-31')

      const report = article(page)
      await expect(report.getByRole('alert')).toContainText('This Report stops after 5,000 Transactions', { timeout: 60_000 })
      await expect(report.getByText('5,000 Transactions listed, oldest first.')).toBeVisible()
      await expect(report.locator('tbody tr')).toHaveCount(5000 + 3) // and the three loans' lines in the summary
      await expect(report.getByText('This Report stops after 5,000 Transactions')).toHaveCount(2) // at the top, and again at the end
      const first = sectionOf(page, 'Loan – First')
      await expect(first).toContainText('Partly listed: this Report stopped part way through this loan.')
      expect(await figuresOf(first)).toContainEqual([`Owed on ${dateText('2002-12-31')}`, 'Not worked out']) // $5,000.00 would read as the amount owed
      for (const name of ['Loan – Second', 'Loan – Third']) {
        const section = sectionOf(page, name)
        await expect(section).toContainText('Not listed: this Report stopped before this loan.')
        await expect(section).not.toContainText('No Transactions in these dates')
        await expect(section.getByRole('table')).toHaveCount(0)
      }
      // The summary says the same, and keeps all three out of both totals.
      const summary = sectionOf(page, 'All loans')
      expect(await rowsOf(summary.getByRole('table'))).toEqual([['Loan – First', 'Not worked out'], ['Loan – Second', 'Not worked out'], ['Loan – Third', 'Not worked out']])
      expect(await figuresOf(summary)).toEqual([['Owed to the Accounts', '$0.00'], ['Owed by the Accounts', '$0.00']])
      await expect(summary).toContainText('These totals leave out 3 loans this Report did not work out')
      expect(new Set(asked)).toEqual(new Set(['1'])) // nothing was asked about the loans after the cut-off
      expect(Math.max(...limits)).toBe(1000) // a page is a thousand, and the last asks for one more to find out whether there is any
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Printed

test.describe('printed', () => {
  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(aliceId, `${d.year}-11-01`, `${d.year}-12-31`))
    await expect(tableOf(page, d.aliceLoan)).toBeVisible()
  })

  const range = (year: number) => `${dateText(`${year}-11-01`)} to ${dateText(`${year}-12-31`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Loans Category, the Accounts, the dates, and when it was generated', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectTitleBlock(article(page), { name: 'Loans', account: 'All Accounts: ', dates: range(d.year) })
    await expect(article(page).locator('header')).toContainText(`Loans: ${d.aliceLoan}`)
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectIdentityRow(page, `${TITLE} – Loans – ${d.aliceLoan} – ${range(d.year)}`)
  })

  test('names the page for Save as PDF: the app, the Report, the Loans Category and the dates', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Loans – ${d.aliceLoan} – ${range(d.year)}`)
  })

  test('is black text on white paper, even from the dark theme', { tag: '@theme' }, async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expectBlackOnWhite(page, 30) // every word, including the money, is black
  })

  test('has no text under 12pt', async ({ page }, testInfo) => {
    await expectNoTextUnder12pt(page, tableOf(page, dataFor(testInfo.project.name).aliceLoan), 30)
  })

  test('is its own page with its own margins, repeats the table heading and keeps a row whole', async ({ page }) => {
    await expectOwnPage(page)
  })

  test('prints the opening balance, every Transaction and what is owed on the last date, with the page numbers, every figure in at least 12pt type', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const all = squash(pages.map(textOf).join(' '))
    expect(all).toContain(squash(`Opening balance (before ${dateText(`${d.year}-11-01`)}) ${d.alice} owes $450.00 to the Accounts`))
    expect(all).toContain(squash(`Owed on ${dateText(`${d.year}-12-31`)} ${d.alice} owes $300.00 to the Accounts`))
    for (const what of ['repaid first', 'repaid second', 'lent by transfer']) expect(all, what).toContain(squash(`LOANRPT ${d.project} ${what}`))
    for (const amount of [ALICE.repaid1, ALICE.repaid2, ALICE.transferred]) expect(all, signed(amount)).toContain(squash(signed(amount)))
    expect(all).toContain(squash('First repayment'))
    expectPageNumbers(pages)
    expectBareMargins(pages)
    expectNoTypeUnder12pt(pages, 40)
    // The table's headings, and the lines that say what the Report is, are at the top of every page that has some of its rows.
    const withRows = expectIdentityOnEveryPage(pages, 'LOANRPT', `${TITLE} – Loans – ${d.aliceLoan} – ${range(d.year)}`, 1)
    for (const p of withRows) expect(squash(textOf(p)), `headings on page ${pages.indexOf(p) + 1}`).toContain(HEADINGS)
  })

  test('prints the same from a phone-width window: still a table', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(tableOf(page, dataFor(testInfo.project.name).aliceLoan)).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })
})

// A loan with more Transactions than a page holds. The data is stubbed so the test adds no Transactions for the other specs to find.
test.describe('printed over several pages', () => {
  const ROWS = 70
  const description = (i: number) => `Stub payment ${String(i + 1).padStart(2, '0')}`
  /** Every amount is different, so a row can be told from the others in a PDF. */
  const cents = (i: number) => (i % 3 === 0 ? 10_000 + i : -(1000 + i))

  test.beforeEach(async ({ page, context, request, baseURL }) => {
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await stubKeeping(page) // Loan – Stub is only in the stubbed answers
    await page.route('**/api/categories', (route) => route.fulfill({ json: [{ id: 1, name: 'Loan – Stub', kind: 'loans' }] }))
    await page.route('**/api/reports/loans?**', (route) =>
      route.fulfill({
        json: {
          category: { id: 1, name: 'Loan – Stub' },
          opening: { cents: -25_000, count: 1 },
          transactions: Array.from({ length: ROWS }, (_, i) => ({ id: i + 1, date: '2002-02-03', description: description(i), amountCents: cents(i), accountName: 'Stub account', note: i % 7 === 0 ? `Stub note ${i}` : null })),
          next: null,
        },
      }),
    )
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(1, '2002-01-01', '2002-12-31'))
    await expect(tableOf(page, 'Loan – Stub')).toBeVisible()
  })

  test('is several A4 pages with the table headings on every one, no Transaction lost, repeated or cut across pages', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const withRows = pages.filter((p) => textOf(p).includes('Stub payment'))
    expect(withRows.length).toBeGreaterThanOrEqual(2)
    for (const p of withRows) expect(squash(textOf(p)), `headings on page ${pages.indexOf(p) + 1}`).toContain(HEADINGS)

    // Every Transaction is on exactly one page, as one row: its description and its amount.
    const all = squash(textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) }))
    for (let i = 0; i < ROWS; i++) {
      const row = squash(`${description(i)}`)
      expect(all.split(row).length - 1, row).toBe(1)
      expect(all, row).toContain(squash(signed(cents(i))))
    }
  })

  test('says what the Report is, which Loans Category and dates, and when it was generated, at the top of every page the table runs onto', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    // The Admin's title comes through as typed, quote and backslash too.
    expectIdentityOnEveryPage(pages, 'Stub payment', `${TITLE} – Loans – Loan – Stub – ${dateText('2002-01-01')} to ${dateText('2002-12-31')}`, 2)
  })

  test('numbers every page "Page 2 of 5" in the bottom margin, and has nothing else in the margins', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expectPageNumbers(pages)
    expectBareMargins(pages)
  })

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    expectNoTypeUnder12pt(await readPdf(await page.pdf({ format: 'A4' })), 300)
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
    await page.goto(address(null, null, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – Loans – All loans – From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })
})
