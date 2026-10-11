import type { BrowserContext, Locator, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'
import {
  dateText,
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
  noAxeViolations,
  NOW,
  restoreAppTitleAfterEach,
  setTitle,
  squash,
  TITLE,
} from './report-helpers'

// Ticket 38: the Loans Report. It uses the Report frame of ticket 18, so it opens in a new window, says on its face what it is, and prints with its table heading on
// every page. Which Transactions are loans is held to the shared spending definition in worker/report-loans.test.ts, and the sums and wording are in
// src/lib/report-loans.test.ts; this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it makes (page count, the
// text on each page, the margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2000 and 2001), and a Report that goes up to the end of
// its year lists only that project's Transactions even for every Loans Category. No other spec has Transactions before 2002, so a Report from the first Transaction to
// those years is the project's own. Payees avoid "EXAMPLE", which other specs' Rules look for.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  const alice = light ? 'Alice' : 'Dana' // a person the parent lends to
  const ben = light ? 'Ben' : 'Eli' // a person the parent borrows from
  return {
    project,
    year: light ? 2000 : 2001,
    parent: { number: light ? '99-9999-9999999-48' : '99-9999-9999999-68', name: `Loans parent ${project}` },
    child: { number: light ? '99-9999-9999999-49' : '99-9999-9999999-69', name: `Loans child ${project}` },
    alice,
    ben,
    aliceLoan: `Loan – ${alice}`,
    benLoan: `Loan – ${ben}`,
  }
}

// What the year holds, by Category, in cents (money out is negative). Alice is lent $450.00 and, by a Transfer to her tracked Account that the Admin gave her Category,
// $50.00 more; she pays back $100.00 twice, once into each Account. Ben lends the parent $500.00 and is paid back $200.00. The parent also spends $40.00, and the
// other half of the $50.00 Transfer is in the child's Account: neither is a loan.
const ALICE = { lent: -45_000, repaid1: 10_000, repaid2: 10_000, transferred: -5000 }
const BEN = { lends: 50_000, repaid: -20_000 }

/** The table's column headings in a PDF, in order and with no spaces: a narrow column breaks "Owed after" over two lines, so the words are not looked for one run at a time. */
const HEADINGS = squash('Date Description Account Note Amount Owed after')
/** What an amount reads as in a table: signed, with thousands and cents. */
const signed = (cents: number) => `${cents < 0 ? '−' : cents > 0 ? '+' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}`

type Seeded = { aliceId: number; benId: number; groceriesId: number }
const seeded = new Map<string, Seeded>()

type Row = { date: string; payee: string; amountCents: number; category?: 'alice' | 'ben'; note?: string }
/** The project's two Accounts, its two Loans Categories and their Transactions (see ALICE and BEN). Safe to repeat: an Import recognises rows it already holds. */
async function seed(context: BrowserContext, baseURL: string, project: string): Promise<Seeded> {
  const known = seeded.get(project)
  if (known) return known
  const d = dataFor(project)
  const { year } = d
  const headers = { Origin: baseURL }
  await signInAs(context, 'admin')

  // Categories of this project's own, found again if an earlier run left them.
  const existing = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  const categoryId = async (name: string, kind: 'spending' | 'loans') => {
    const found = existing.find((c) => c.name === name)
    if (found) return found.id
    const res = await context.request.post('/api/categories', { headers, data: { name, kind } })
    expect(res.ok()).toBe(true)
    return ((await res.json()) as { id: number }).id
  }
  const categories = { alice: await categoryId(d.aliceLoan, 'loans'), ben: await categoryId(d.benLoan, 'loans') }

  const say = (what: string) => `LOANRPT ${project} ${what}`
  const parentRows: Row[] = [
    { date: `${year}-02-01`, payee: say('lent'), amountCents: ALICE.lent, category: 'alice' },
    { date: `${year}-03-01`, payee: say('repaid first'), amountCents: ALICE.repaid1, category: 'alice', note: 'First repayment' },
    { date: `${year}-05-01`, payee: say('lent by transfer'), amountCents: ALICE.transferred, category: 'alice' }, // the other half is in the child's Account: a Transfer
    { date: `${year}-02-15`, payee: say('lent to us'), amountCents: BEN.lends, category: 'ben' },
    { date: `${year}-03-15`, payee: say('paid back'), amountCents: BEN.repaid, category: 'ben' },
    { date: `${year}-02-20`, payee: say('shopping'), amountCents: -4000 },
  ]
  const childRows: Row[] = [
    { date: `${year}-04-01`, payee: say('repaid second'), amountCents: ALICE.repaid2, category: 'alice' },
    { date: `${year}-05-01`, payee: say('from parent by transfer'), amountCents: 5000 },
  ]
  const importRows = async (account: { number: string; name: string }, rows: Row[], tag: string) => {
    const res = await context.request.post('/api/imports/chunks', {
      headers,
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: `${year}-01-01`, to: `${year}-12-31`, ledgerBalance: { cents: 0, date: `${year}-12-31` } },
        rows: rows.map((r, i) => ({ date: r.date, uniqueId: `LRP${year}${tag}${i}`, tranType: 'EFTPOS', chequeNumber: null, payee: r.payee, bankMemo: 'EFTPOS', amountCents: r.amountCents })),
      },
    })
    expect(res.ok()).toBe(true)
  }
  await importRows(d.parent, parentRows, 'P')
  await importRows(d.child, childRows, 'C') // the second Account pairs its $50.00 in with the first's $50.00 out

  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const idOf = (name: string) => accounts.find((a) => a.name === name)!.id
  for (const [accountId, rows] of [[idOf(d.parent.name), parentRows], [idOf(d.child.name), childRows]] as const) {
    const { transactions } = (await (await context.request.get(`/api/transactions?accountId=${accountId}&from=${year}-01-01&to=${year}-12-31&limit=200&count=false`)).json()) as { transactions: { id: number; description: string }[] }
    expect(transactions).toHaveLength(rows.length)
    for (const row of rows) {
      const found = transactions.find((t) => t.description === row.payee)
      expect(found, row.payee).toBeDefined()
      if (row.category) expect((await context.request.put(`/api/transactions/${found!.id}/override`, { headers, data: { categoryId: categories[row.category] } })).ok()).toBe(true)
      if (row.note) expect((await context.request.put(`/api/transactions/${found!.id}/note`, { headers, data: { note: row.note } })).ok()).toBe(true)
    }
  }
  const groceriesId = existing.find((c) => c.name === 'Groceries')?.id ?? -1
  const result = { aliceId: categories.alice, benId: categories.ben, groceriesId }
  seeded.set(project, result)
  return result
}

restoreAppTitleAfterEach() // the Settings are shared by every test and both themes (as reports.spec.ts does)

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
  test('the Reports page offers it with a form of its own, for one Loans Category or all of them, and opens it in a new window', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Loans' })).toBeVisible()

    const form = page.getByRole('form', { name: 'Loans' })
    await expect(form).toContainText('Leave From blank to begin at the first Transaction')
    const loan = form.getByLabel('Loan', { exact: true })
    await expect(loan).toHaveValue('') // every Loans Category unless one is chosen
    // Only Loans Categories are offered: the starter one and the Admin's own, and no Spending or Income Category.
    const offered = await loan.locator('option').allTextContents()
    expect(offered).toEqual(expect.arrayContaining(['All loans', 'Loans', d.aliceLoan, d.benLoan]))
    expect(offered).not.toContain('Groceries')
    expect(offered).not.toContain('Wages and salary')
    await expect(form.getByRole('status')).toContainText('Loans Categories to choose from.') // said to a screen reader when the list arrives

    await form.getByLabel('To', { exact: true }).fill(`${d.year}-12-31`)
    const [all] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(all.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
    expect(new URL(all.url()).pathname).toBe('/reports/loans')
    expect(Object.fromEntries(new URL(all.url()).searchParams)).toEqual({ category: '', from: '', to: `${d.year}-12-31` })
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible() // the Reports page is still where it was

    await loan.selectOption({ label: d.aliceLoan })
    await form.getByLabel('From (optional)').fill(`${d.year}-03-01`)
    const [one] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(one.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
    expect(Object.fromEntries(new URL(one.url()).searchParams)).toEqual({ category: String(aliceId), from: `${d.year}-03-01`, to: `${d.year}-12-31` })
  })

  test('the Reports page has no WCAG 2.2 AA violations with all its forms on it', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(page.getByRole('form').first()).toBeVisible()
    await expect(page.getByRole('form')).toHaveCount(await page.getByRole('heading', { level: 2 }).count()) // one form for each Report
    await expect(page.getByRole('form', { name: 'Loans' }).getByRole('status')).toContainText('to choose from')
    await noAxeViolations(page)
  })

  test('its form needs only the date to go up to: the start date may be left blank, and a start date must be a date, in order', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    const form = page.getByRole('form', { name: 'Loans' })
    const open = form.getByRole('button', { name: 'Open Report in a new window' })
    const from = form.getByLabel('From (optional)')
    const to = form.getByLabel('To', { exact: true })

    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.') // not "Choose a From date."
    await to.fill('2001-12-31')
    await from.fill('2001-12-31')
    await to.fill('2001-01-01')
    await open.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(to).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('form', { name: 'Transaction listing' }).getByRole('alert')).toHaveCount(0) // the other forms are untouched
    expect(context.pages()).toHaveLength(1)

    await from.fill('') // blank is allowed
    const [report] = await Promise.all([context.waitForEvent('page'), open.click()])
    await expect(report.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
  })

  test('an address without the date to go up to, with dates the wrong way round, or with no such Loans Category explains itself and offers the form', async ({ page, context, baseURL }, testInfo) => {
    const { groceriesId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    for (const [path, words, alert] of [
      ['/reports/loans', 'Choose the last date this Report covers.', false],
      ['/reports/loans?from=2001-12-31&to=2001-01-01', 'before the “From” date', true],
      ['/reports/loans?category=999999999&to=2001-12-31', 'There is no such Loans Category', true],
      // A Spending Category is not a loan, so it has no Report even when its ID is asked for.
      [`/reports/loans?category=${groceriesId}&to=2001-12-31`, 'There is no such Loans Category', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status').filter({ hasText: words })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open Report in a new window' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without a Loans Category and the date
    }
  })

  test('says there are no Loans Categories yet, and where to make one, when there are none', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.route('**/api/categories', (route) => route.fulfill({ json: [{ id: 1, name: 'Groceries', kind: 'spending' }, { id: 2, name: 'Wages and salary', kind: 'income' }] }))
    await page.goto('/reports/loans?to=2001-12-31')
    await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'There are no Loans Categories to report on yet.' })).toBeVisible()
    const form = page.getByRole('form', { name: 'Loans' })
    await expect(form).toContainText('The Admin makes one for each person on the Categories page, such as Loan – Alice') // where to make one
    await expect(form.getByRole('status')).toHaveText('There are no Loans Categories yet.') // and what a screen reader hears when the list arrives
    await expect(article(page)).toHaveCount(0)
    await expect(form.getByLabel('Loan', { exact: true }).locator('option')).toHaveText(['All loans'])
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
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

  test('has the title block, what the figures are, and a section for each Loans Category, each with how much is owed at the end', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(null, null, `${d.year}-12-31`))

    const report = article(page)
    await expect(report.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Loans: All Loans Categories')
    await expect(header).toContainText('Account: All Accounts: ')
    await expect(header).toContainText(`${d.parent.name} (${d.parent.number})`) // each Account, with its bank number
    await expect(header).toContainText(`${d.child.name} (${d.child.number})`)
    await expect(header).toContainText(`Dates: From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
    await expect(header).toContainText(GENERATED)

    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('Each loan is a Loans Category, one for each person')
    await expect(about).toContainText('If more money went out than came in, the person owes the difference')
    await expect(about).toContainText("Loans aren't counted as spending or income")

    // Each Loans Category of this project has its section, in order of name, and the household's other Loans Categories (the starter one) are sections too.
    const headings = await report.getByRole('heading', { level: 2 }).allTextContents()
    expect(headings.indexOf(d.aliceLoan)).toBeGreaterThanOrEqual(0)
    expect(headings.indexOf(d.benLoan)).toBeGreaterThan(headings.indexOf(d.aliceLoan))
    expect(headings).toContain('Loans')
    // The starter Loans Category names no one, so the Report says the Accounts are owed or owe, and not a name. (Nothing of anyone's is dated before 2002.)
    expect(await figuresOf(sectionOf(page, 'Loans'))).toContainEqual(['Owed at the end', 'Nothing is owed'])

    // Money out of $500.00 and repayments in of $200.00: the person owes $300.00. Reversed, they are owed it.
    const alice = sectionOf(page, d.aliceLoan)
    expect(await figuresOf(alice)).toEqual([
      ['Money out', signed(ALICE.lent + ALICE.transferred)],
      ['Money in', signed(ALICE.repaid1 + ALICE.repaid2)],
      ['Owed at the end', `${d.alice} owes $300.00`],
    ])
    const ben = sectionOf(page, d.benLoan)
    expect(await figuresOf(ben)).toEqual([
      ['Money out', signed(BEN.repaid)],
      ['Money in', signed(BEN.lends)],
      ['Owed at the end', `${d.ben} is owed $300.00`],
    ])
    await expect(alice).not.toContainText('Opening balance') // there is no start date
    await expect(report.getByText('we owe', { exact: false })).toHaveCount(0)
  })

  test('lists a loan\'s lending and repayments oldest first, from either Account, with the Account, the Note and what is owed after each', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, null, `${d.year}-12-31`))

    const table = tableOf(page, d.aliceLoan)
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Description', 'Account', 'Note', 'Amount', 'Owed after'])
    const rows = await rowsOf(table)
    expect(rows.map((r) => [r[0], r[1], r[2], r[4], r[5]])).toEqual([
      [dateText(`${d.year}-02-01`), `LOANRPT ${d.project} lent`, `${d.parent.name}`, `${signed(ALICE.lent)} Money out`, `$450.00 ${d.alice} owes`],
      [dateText(`${d.year}-03-01`), `LOANRPT ${d.project} repaid first`, `${d.parent.name}`, `${signed(ALICE.repaid1)} Money in`, `$350.00 ${d.alice} owes`],
      [dateText(`${d.year}-04-01`), `LOANRPT ${d.project} repaid second`, `${d.child.name}`, `${signed(ALICE.repaid2)} Money in`, `$250.00 ${d.alice} owes`],
      // The half of a Transfer the Admin gave this Category is a loan; the other half, in the child's Account, is not.
      [dateText(`${d.year}-05-01`), `LOANRPT ${d.project} lent by transfer`, `${d.parent.name}`, `${signed(ALICE.transferred)} Money out`, `$300.00 ${d.alice} owes`],
    ])
    expect(rows[1]![3]).toBe('First repayment') // the Note, as the Transaction listing shows it
    expect(rows[0]![3]).toContain('No Note')
    // The last balance is what is owed at the end.
    await expect(sectionOf(page, d.aliceLoan).locator('dl')).toContainText(`${d.alice} owes $300.00`)

    // The household owes Ben: what is owed after each Transaction is the other way round, and says so.
    const benRows = await rowsOf(tableOf(page, d.benLoan))
    expect(benRows.map((r) => [r[1], r[4], r[5]])).toEqual([
      [`LOANRPT ${d.project} lent to us`, `${signed(BEN.lends)} Money in`, `$500.00 ${d.ben} is owed`],
      [`LOANRPT ${d.project} paid back`, `${signed(BEN.repaid)} Money out`, `$300.00 ${d.ben} is owed`],
    ])
  })

  test('leaves out what is not a loan: spending, the other half of a Transfer, and the other person\'s loan', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, null, `${d.year}-12-31`))
    const alice = sectionOf(page, d.aliceLoan)
    await expect(alice.getByRole('table')).toBeVisible()
    await expect(alice).not.toContainText('shopping')
    await expect(alice).not.toContainText('from parent by transfer')
    await expect(alice).not.toContainText('lent to us')
    await expect(sectionOf(page, d.benLoan)).not.toContainText('lent by transfer')
    await expect(article(page)).not.toContainText('shopping')
  })

  test('lists one Loans Category when one is chosen, and says which in the title block and the page title', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(aliceId, null, `${d.year}-12-31`))

    await expect(article(page).locator('header')).toContainText(`Loans: ${d.aliceLoan}`)
    await expect(article(page).getByRole('heading', { level: 2 })).toHaveText(['About these figures', d.aliceLoan]) // only that loan
    await expect(page).toHaveTitle(`Mum's finances – Loans – ${d.aliceLoan} – From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
    await page.goto(address(null, null, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText('Loans: All Loans Categories')
    await expect(page).toHaveTitle(`Mum's finances – Loans – All loans – From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
  })

  test('with a start date, begins with what was owed before it, and goes on from there to the same amount owed at the end', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId, benId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    await page.goto(address(aliceId, `${d.year}-03-01`, `${d.year}-12-31`))
    const alice = sectionOf(page, d.aliceLoan)
    await expect(article(page).locator('header')).toContainText(`Dates: ${dateText(`${d.year}-03-01`)} to ${dateText(`${d.year}-12-31`)}`)
    expect(await figuresOf(alice)).toEqual([
      [`Opening balance (before ${dateText(`${d.year}-03-01`)})`, `${d.alice} owes $450.00`],
      ['Money out', signed(ALICE.transferred)],
      ['Money in', signed(ALICE.repaid1 + ALICE.repaid2)],
      ['Owed at the end', `${d.alice} owes $300.00`],
    ])
    expect((await rowsOf(tableOf(page, d.aliceLoan))).map((r) => [r[1], r[5]])).toEqual([
      [`LOANRPT ${d.project} repaid first`, `$350.00 ${d.alice} owes`], // from the opening $450.00, not from nothing
      [`LOANRPT ${d.project} repaid second`, `$250.00 ${d.alice} owes`],
      [`LOANRPT ${d.project} lent by transfer`, `$300.00 ${d.alice} owes`],
    ])

    await page.goto(address(benId, `${d.year}-03-01`, `${d.year}-12-31`))
    expect(await figuresOf(sectionOf(page, d.benLoan))).toEqual([
      [`Opening balance (before ${dateText(`${d.year}-03-01`)})`, `${d.ben} is owed $500.00`],
      ['Money out', signed(BEN.repaid)],
      ['Money in', signed(0)],
      ['Owed at the end', `${d.ben} is owed $300.00`],
    ])
  })

  test('stops at the date chosen: what was owed up to it, and nothing after', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    await page.goto(address(aliceId, null, `${d.year}-03-31`))
    expect((await rowsOf(tableOf(page, d.aliceLoan))).map((r) => r[1])).toEqual([`LOANRPT ${d.project} lent`, `LOANRPT ${d.project} repaid first`])
    expect(await figuresOf(sectionOf(page, d.aliceLoan))).toContainEqual(['Owed at the end', `${d.alice} owes $350.00`])
  })

  test('says what is owed when a loan has nothing in the dates: before it began, and after its last Transaction', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    await page.goto(address(aliceId, null, `${d.year}-01-31`)) // before the first Transaction
    let alice = sectionOf(page, d.aliceLoan)
    await expect(alice).toContainText('No Transactions in these dates.')
    await expect(alice.getByRole('table')).toHaveCount(0)
    expect(await figuresOf(alice)).toContainEqual(['Owed at the end', `${d.alice} owes nothing`])

    await page.goto(address(aliceId, `${d.year}-06-01`, `${d.year}-12-31`)) // after the last one
    alice = sectionOf(page, d.aliceLoan)
    await expect(alice).toContainText('No Transactions in these dates.')
    expect(await figuresOf(alice)).toEqual([
      [`Opening balance (before ${dateText(`${d.year}-06-01`)})`, `${d.alice} owes $300.00`],
      ['Money out', signed(0)],
      ['Money in', signed(0)],
      ['Owed at the end', `${d.alice} owes $300.00`],
    ])
  })

  test('is in no spending: the Spending by Category Report for the same dates leaves the loans out', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(`/reports/spending?from=${d.year}-01-01&to=${d.year}-12-31`)
    const spending = page.getByRole('article', { name: 'Spending by Category' })
    // The shopping ($40.00) is the only spending in the year; the loans' $450.00, $500.00 and the rest are in no figure.
    await expect(spending.getByRole('region', { name: 'Spending in each Category' }).locator('dl')).toContainText('$40.00')
    await expect(spending).not.toContainText(d.aliceLoan)
    await expect(spending).not.toContainText(d.benLoan)
    await expect(spending).not.toContainText('$450.00')
    await expect(spending).not.toContainText('$500.00')
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}, with a loan owed to and one owed by`, async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, role)
      await page.goto(address(null, `${d.year}-03-01`, `${d.year}-12-31`))
      await expect(tableOf(page, d.aliceLoan)).toBeVisible()
      await expect(tableOf(page, d.benLoan)).toContainText(`${d.ben} is owed`)
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { aliceId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
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

  test('shows every Member the same Report as the Admin', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['member', 'admin'] as const) {
      await signInAs(context, role)
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
      await signInAs(context, 'member')
      await page.route('**/api/reports/loans?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(address(null, null, `${d.year}-12-31`))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByText('owes nothing')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })

  test.describe('when it stops at the cap of 10,000 Transactions', () => {
    test('says so at the top and the end, marks the loan it stopped in partly listed with no amount owed at the end, and the loans after it not listed, unread', async ({ page, context }) => {
      test.setTimeout(120_000) // fifty full pages, and ten thousand rows to draw
      await signInAs(context, 'member')
      // Three loans, the first with more than the cap in the range: every page is full, and there is always one more. The cap falls part way through the first.
      const loans = [{ id: 1, name: 'Loan – First', kind: 'loans' }, { id: 2, name: 'Loan – Second', kind: 'loans' }, { id: 3, name: 'Loan – Third', kind: 'loans' }]
      await page.route('**/api/categories', (route) => route.fulfill({ json: loans }))
      const asked: string[] = []
      await page.route('**/api/reports/loans?**', async (route) => {
        const params = new URL(route.request().url()).searchParams
        asked.push(params.get('categoryId')!)
        const limit = Number(params.get('limit'))
        const after = params.get('after')
        const start = after === null ? 0 : Number(after.split(':')[1])
        const transactions = Array.from({ length: limit }, (_, k) => ({ id: start + k + 1, date: '2000-01-02', description: `Stub ${start + k + 1}`, amountCents: -100, accountName: 'Stub account', note: null }))
        await route.fulfill({ json: { category: { id: 1, name: 'Loan – First' }, openingCents: after === null ? 0 : null, transactions, next: `2000-01-02:${start + limit}` } })
      })
      await page.goto(address(null, null, '2000-12-31'))

      const report = article(page)
      await expect(report.getByRole('alert')).toContainText('This Report stops after 10,000 Transactions', { timeout: 60_000 })
      await expect(report.getByText('10,000 Transactions listed, oldest first.')).toBeVisible()
      await expect(report.locator('tbody tr')).toHaveCount(10_000)
      await expect(report.getByText('This Report stops after 10,000 Transactions')).toHaveCount(2) // at the top, and again at the end
      const first = sectionOf(page, 'Loan – First')
      await expect(first).toContainText('Partly listed: this Report stopped part way through this loan.')
      expect(await figuresOf(first)).toContainEqual(['Owed at the end', 'Not worked out']) // $10,000.00 would read as the amount owed
      for (const name of ['Loan – Second', 'Loan – Third']) {
        const section = sectionOf(page, name)
        await expect(section).toContainText('Not listed: this Report stopped before this loan.')
        await expect(section).not.toContainText('No Transactions in these dates')
        await expect(section.getByRole('table')).toHaveCount(0)
      }
      expect(new Set(asked)).toEqual(new Set(['1'])) // nothing was asked about the loans after the cut-off
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
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(aliceId, `${d.year}-03-01`, `${d.year}-12-31`))
    await expect(tableOf(page, d.aliceLoan)).toBeVisible()
  })

  const range = (year: number) => `${dateText(`${year}-03-01`)} to ${dateText(`${year}-12-31`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Loans Category, the Accounts, the dates, and who generated it and when', async ({ page }, testInfo) => {
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

  test('is black text on white paper, even from the dark theme', async ({ page }, testInfo) => {
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

  test('prints the opening balance, every Transaction and what is owed at the end, with the page numbers, every figure in at least 12pt type', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const all = squash(pages.map(textOf).join(' '))
    expect(all).toContain(squash(`Opening balance (before ${dateText(`${d.year}-03-01`)}) ${d.alice} owes $450.00`))
    expect(all).toContain(squash(`Owed at the end ${d.alice} owes $300.00`))
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
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.route('**/api/categories', (route) => route.fulfill({ json: [{ id: 1, name: 'Loan – Stub', kind: 'loans' }] }))
    await page.route('**/api/reports/loans?**', (route) =>
      route.fulfill({
        json: {
          category: { id: 1, name: 'Loan – Stub' },
          openingCents: -25_000,
          transactions: Array.from({ length: ROWS }, (_, i) => ({ id: i + 1, date: '2000-02-03', description: description(i), amountCents: cents(i), accountName: 'Stub account', note: i % 7 === 0 ? `Stub note ${i}` : null })),
          next: null,
        },
      }),
    )
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(1, '2000-01-01', '2000-12-31'))
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

  test('says what the Report is, which Loans Category and dates, and who generated it and when, at the top of every page the table runs onto', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    // The Admin's title comes through as typed, quote and backslash too.
    expectIdentityOnEveryPage(pages, 'Stub payment', `${TITLE} – Loans – Loan – Stub – ${dateText('2000-01-01')} to ${dateText('2000-12-31')}`, 2)
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
    await signInAs(context, 'member')
    await page.goto(address(null, null, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – Loans – All loans – From the first Transaction to ${dateText(`${d.year}-12-31`)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })
})
