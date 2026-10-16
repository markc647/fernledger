import type { BrowserContext, Page } from '@playwright/test'
import { dateField, pickDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'
import {
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
  NOW,
  restoreAppTitleAfterEach,
  setTitle,
  signInToOpen,
  TITLE,
} from './report-helpers'

// Ticket 18: the Report frame and the Transaction listing Report (spec stories 97 to 99). A Report has a page of its own, with its form and, below it, the Report, which is laid
// out for paper and says on its face what it is, which Account and dates it covers, and who generated it and when. The Reports page is a card for each Report, and
// reports-pages.spec.ts checks the six pages' common ground. The print layout is checked three ways: the page under print media (what the browser lays out), and the PDF
// it makes (page count, the text on each page, the page margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts of its own and its own year (2013 and 2014),
// and a Report of one year lists only that project's Transactions. No other spec uses these years.
const dataFor = (project: string) => ({
  year: project === 'dark' ? 2014 : 2013,
  first: project === 'dark' ? 'Wed 1 Jan 2014' : 'Tue 1 Jan 2013',
  last: project === 'dark' ? 'Wed 31 Dec 2014' : 'Tue 31 Dec 2013',
  savings: { number: project === 'dark' ? '99-9999-9999999-62' : '99-9999-9999999-60', name: `Report savings ${project}` },
  cheque: { number: project === 'dark' ? '99-9999-9999999-63' : '99-9999-9999999-61', name: `Report cheque ${project}` },
})

const SHOPS = 70 // enough rows for several pages
const day = (year: number, offset: number) => new Date(Date.UTC(year, 0, 1 + offset)).toISOString().slice(0, 10)
const shop = (i: number) => `EXAMPLE SHOP ${String(i + 1).padStart(2, '0')}`
/** Every shop's amount is different, so a row can be told from the others in a PDF: −$10.00 to −$10.69. */
const shopCents = (i: number) => -(1000 + i)
const note = (i: number) => `Paid by cheque ${i}`
const hasNote = (i: number) => i % 10 === 0
const hasOverride = (i: number) => i % 7 === 0
/** An Import's only word about a payment is a cheque number, which a Report prints under the description. */
const hasCheque = (i: number) => i % 10 === 5
const chequeNumber = (i: number) => String(i + 100).padStart(6, '0')

type Seeded = { savingsId: number; chequeId: number; category: string }
const seeded = new Map<string, Seeded>()

/** The project's two Accounts, 70 Transactions in one and 3 in the other, some with a Note or an Override. Safe to repeat: an Import recognises rows it already holds. */
async function seed(context: BrowserContext, baseURL: string, project: string): Promise<Seeded> {
  const known = seeded.get(project)
  if (known) return known
  const { year, savings, cheque } = dataFor(project)
  await signInAs(context, 'admin')
  await importRows(context, baseURL, {
    account: savings,
    year,
    rows: Array.from({ length: SHOPS }, (_, i) => ({ date: day(year, 4 * i), uniqueId: `RPT${year}S${i}`, payee: shop(i), amountCents: shopCents(i), chequeNumber: hasCheque(i) ? chequeNumber(i) : undefined })),
  })
  await importRows(context, baseURL, {
    account: cheque,
    year,
    rows: [
      { date: day(year, 10), uniqueId: `RPT${year}C1`, payee: 'EXAMPLE WAGES', amountCents: 50000 },
      { date: day(year, 20), uniqueId: `RPT${year}C2`, payee: 'EXAMPLE RATES', amountCents: -30000 },
      { date: day(year, 30), uniqueId: `RPT${year}C3`, payee: 'EXAMPLE CAFE', amountCents: -1500 },
    ],
  })

  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const savingsId = accounts.find((a) => a.name === savings.name)!.id
  const chequeId = accounts.find((a) => a.name === cheque.name)!.id
  const category = ((await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[])[0]!
  const { transactions } = (await (await context.request.get(`/api/transactions?accountId=${savingsId}&from=${year}-01-01&to=${year}-12-31&sort=date&dir=asc&limit=200`)).json()) as { transactions: { id: number; description: string }[] }
  expect(transactions).toHaveLength(SHOPS)
  for (const [i, t] of transactions.entries()) {
    if (hasNote(i)) expect((await context.request.put(`/api/transactions/${t.id}/note`, { headers: { Origin: baseURL }, data: { note: note(i) } })).ok()).toBe(true)
    if (hasOverride(i)) expect((await context.request.put(`/api/transactions/${t.id}/override`, { headers: { Origin: baseURL }, data: { categoryId: category.id } })).ok()).toBe(true)
  }
  const result = { savingsId, chequeId, category: category.name }
  seeded.set(project, result)
  return result
}

restoreAppTitleAfterEach() // the Settings are shared by every test and both themes (as settings.spec.ts does)
forgetKeptReportsAfterEach() // so is the list of kept Reports, which the Admin showing a Report adds to

const reportAddress = (id: number, year: number, extra = '') => `/reports/transactions?account=${id}&from=${year}-01-01&to=${year}-12-31${extra}`
const article = (page: Page) => page.getByRole('article', { name: 'Transaction listing' })

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening a Report', () => {
  test('the Transactions page opens it in a new window, carrying the Account and dates', async ({ page, context, baseURL }, testInfo) => {
    const { year, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/transactions?account=${savingsId}&from=${year}-01-01&to=${year}-12-31`)

    const link = page.getByRole('link', { name: /Transaction listing Report/ })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    const href = new URL((await link.getAttribute('href'))!, baseURL)
    expect(href.pathname).toBe('/reports/transactions')
    expect(Object.fromEntries(href.searchParams)).toEqual({ account: String(savingsId), from: `${year}-01-01`, to: `${year}-12-31` })

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])
    await expect(popup.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
    await expect(popup.getByRole('article', { name: 'Transaction listing' })).toContainText(savings.name)
    await expect(page).toHaveURL(/\/transactions\?/) // the Transactions page is still where it was
  })

  test('the Transactions page offers no Report until it has dates, and points to the Report\'s page', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/transactions')
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Open a Transaction listing Report/ })).toHaveCount(0)
    await page.getByRole('link', { name: "choose dates on the Transaction listing Report's page" }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Transaction listing' })).toBeVisible()
  })

  test('its form shows the Report under it, on the same page, with the choice in the address and the form still filled in', async ({ page, context, baseURL }, testInfo) => {
    const { year, savings, cheque, last } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 1280, height: 420 }) // the Report starts below the bottom of the window
    await page.goto('/reports/transactions')
    await expect(article(page)).toHaveCount(0) // nothing is shown until it is asked for
    await expect(page.getByRole('alert')).toHaveCount(0)

    const form = page.getByRole('form', { name: 'Transaction listing' })
    await form.getByLabel('Account').selectOption({ label: savings.name })
    await pickDate(form, 'From', `${year}-01-01`)
    await pickDate(form, 'To', `${year}-12-31`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page).getByRole('table', { name: `Transactions in ${savings.name}` })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0) // the page moved to the Report, which is under the form
    await expect(article(page)).not.toContainText(cheque.name) // the one Account chosen
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ account: String(savingsId), from: `${year}-01-01`, to: `${year}-12-31` })
    await expect(form.getByLabel('Account')).toHaveValue(String(savingsId)) // the form is still where it was, filled in from the address
    await expect(dateField(form, 'To')).toContainText(last)
    expect(await form.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)).toBeLessThan(await article(page).evaluate((el) => el.getBoundingClientRect().top + window.scrollY)) // the form is above the Report

    // Another choice replaces the Report, and the Back button brings the form and the Report back together.
    await form.getByLabel('Account').selectOption({ label: 'All Accounts' })
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(article(page).getByRole('table', { name: `Transactions in ${cheque.name}` })).toBeVisible()
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ from: `${year}-01-01`, to: `${year}-12-31` })
    await page.goBack()
    await expect(article(page).getByRole('table', { name: `Transactions in ${savings.name}` })).toBeVisible()
    await expect(article(page)).not.toContainText(cheque.name)
    await expect(form.getByLabel('Account')).toHaveValue(String(savingsId))
  })

  test('the Back button puts every field of the form back as the address has it, a choice that was not asked for included', async ({ page, context, baseURL }, testInfo) => {
    const { year, savings, cheque, last } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(reportAddress(savingsId, year))
    await expect(article(page).getByRole('table')).toBeVisible()
    const form = page.getByRole('form', { name: 'Transaction listing' })

    await pickDate(form, 'To', `${year}-06-30`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(page).toHaveURL(new RegExp(`to=${year}-06-30`)) // the same Account, other dates
    await form.getByLabel('Account').selectOption({ label: cheque.name }) // not asked for
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`to=${year}-12-31`))
    await expect(form.getByLabel('Account')).toHaveValue(String(savingsId)) // the address's, and not the one chosen after it
    await expect(form.getByLabel('Account').locator('option:checked')).toHaveText(savings.name)
    await expect(dateField(form, 'To')).toContainText(last)
  })

  test('a Report opened from its address does not move the page: only asking for it on the form does', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto(reportAddress(savingsId, year))
    await expect(article(page).getByRole('table')).toBeVisible()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('asking for the Report that is open again reads it again: it is a snapshot, made when it is asked for', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    // A reading is a number of requests: those asked (the Worker has them) and those answered (the page has them).
    const asked: string[] = []
    const answered: string[] = []
    let slow = false // while it is, a request takes long enough for a second press to come in the middle of a reading
    await page.route('**/api/reports/transactions?**', async (route) => {
      asked.push(route.request().url())
      if (slow) await new Promise((resolve) => setTimeout(resolve, 600))
      await route.continue()
    })
    page.on('response', (response) => void (response.url().includes('/api/reports/transactions?') && answered.push(response.url())))
    await page.goto(reportAddress(savingsId, year))
    await expect(article(page).getByRole('table')).toBeVisible()
    const reading = answered.length // the requests one reading takes
    expect(reading).toBeGreaterThan(0)

    const show = page.getByRole('form', { name: 'Transaction listing' }).getByRole('button', { name: 'Show Report' })
    await show.click()
    await expect.poll(() => answered.length).toBe(2 * reading) // the same address, asked for again, is read again

    // A second press in the middle of a reading joins it, and does not start another: a Report is thousands of rows of the free plan's D1 reads (ADR 0004). Another reading
    // would have asked for its requests by the time the first one's slow answers come, so the count of those asked, when they have been, is how many readings there were.
    slow = true
    await show.dblclick()
    await expect.poll(() => answered.length).toBeGreaterThanOrEqual(3 * reading)
    expect(asked.length).toBe(3 * reading)
    await expect(article(page).getByRole('table')).toBeVisible()
  })

  test('the Reports form asks for real dates, in order, and shows nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/transactions')
    const form = page.getByRole('form', { name: 'Transaction listing' })
    const show = form.getByRole('button', { name: 'Show Report' })

    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await pickDate(form, 'From', '2013-12-31')
    await show.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await pickDate(form, 'To', '2013-01-01')
    await show.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(dateField(form, 'To')).toHaveAttribute('aria-invalid', 'true')
    expect(new URL(page.url()).search).toBe('') // nothing was asked for: the address is as it was
    await expect(article(page)).toHaveCount(0)
    await noAxeViolations(page)
  })

  test('a Report address with only some dates, dates the wrong way round, or no such Account explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'admin')
    for (const [address, words, alert] of [
      ['/reports/transactions?from=2013-01-01', 'Choose the first and last dates', false],
      ['/reports/transactions?from=2013-12-31&to=2013-01-01', 'before the “From” date', true],
      ['/reports/transactions?account=999999999&from=2013-01-01&to=2013-12-31', 'There is no such Account', true],
      ['/reports/transactions?account=abc&from=2013-01-01&to=2013-12-31', 'There is no such Account', true],
      ['/reports/transactions?account=0&from=2013-01-01&to=2013-12-31', 'There is no such Account', true],
      ['/reports/transactions?account=-1&from=2013-01-01&to=2013-12-31', 'There is no such Account', true],
      ['/reports/transactions?account=2', 'Choose the first and last dates', false],
    ] as const) {
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status').filter({ hasText: words })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Show Report' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without an Account and dates
    }
  })

  test('an address from before the form was on the page still opens its Report: a blank Account is every Account', async ({ page, context, baseURL }, testInfo) => {
    const { year, savings } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/reports/transactions?account=&from=${year}-01-01&to=${year}-12-31`)
    await expect(article(page).getByRole('heading', { level: 2, name: savings.name })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Transaction listing' }).getByLabel('Account')).toHaveValue('')
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.addInitScript(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => void ((window as unknown as { printed: number }).printed += 1)
    })
    await page.goto(reportAddress(savingsId, year))
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

  test('has the title block, then every Transaction in the dates with its Category and Note, oldest first, and the totals', async ({ page, context, request, baseURL }, testInfo) => {
    const { year, first, last, savings } = dataFor(testInfo.project.name)
    const { savingsId, category } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    await page.goto(reportAddress(savingsId, year))

    const report = article(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible() // the page's heading, above the form: the only h1 on screen
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const header = report.locator('header')
    await expect(header.getByRole('heading')).toHaveCount(0) // the title block says it too, but as text on screen: on paper it is the Report's own h1
    await expect(header.locator('p[aria-hidden="true"]')).toHaveText('Transaction listing')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText(`Account: ${savings.name} (${savings.number})`) // the bank's number is beside the name
    await expect(header).toContainText(`Dates: ${first} to ${last}`)
    await expect(header).toContainText(GENERATED)
    await expect(report.getByRole('heading', { level: 2, name: `${savings.name} (${savings.number})` })).toBeVisible()

    const table = report.getByRole('table', { name: `Transactions in ${savings.name}` })
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Description', 'Category', 'Note', 'Amount'])
    await expect(table.locator('tbody tr')).toHaveCount(SHOPS)
    // Oldest first. A cheque number, all an Import knows about a payment, is under the description.
    expect(await table.locator('tbody tr td:nth-child(2)').allTextContents()).toEqual(Array.from({ length: SHOPS }, (_, i) => shop(i) + (hasCheque(i) ? `Cheque number: ${chequeNumber(i)}` : '')))
    // The line that says what a page is belongs to paper: it is in the table's heading, and not on screen.
    await expect(table.locator('thead tr')).toHaveCount(2)
    await expect(table.locator('thead tr').first()).toBeHidden()
    const firstRow = table.locator('tbody tr').first()
    await expect(firstRow).toContainText(first)
    await expect(firstRow).toContainText(category) // an Override is the Category shown
    await expect(firstRow).toContainText(note(0))
    await expect(firstRow).toContainText('−$10.00')
    await expect(firstRow).toContainText('Money out')
    const secondRow = table.locator('tbody tr').nth(1)
    await expect(secondRow).toContainText('Uncategorised')
    await expect(secondRow.getByText('No Note')).toBeAttached() // a missing Note is said, not left blank

    await expect(report.locator('dl').last()).toContainText(/Money in\s*\$0\.00\s*Money out\s*−\$724\.15\s*Net\s*−\$724\.15/)
    await expect(report.getByText(`${SHOPS} Transactions, oldest first.`)).toBeVisible()
  })

  test('lists every Account, with the totals of them all, and says so for an Account with nothing in the dates', async ({ page, context, baseURL }, testInfo) => {
    const { year, savings, cheque } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/reports/transactions?from=${year}-01-01&to=${year}-12-31`)

    const report = article(page)
    await expect(report.getByRole('heading', { level: 2, name: savings.name })).toBeVisible()
    await expect(report.getByRole('heading', { level: 2, name: cheque.name })).toBeVisible()
    await expect(report.locator('header')).toContainText('Account: All Accounts: ')
    await expect(report.locator('header')).toContainText(`${savings.name} (${savings.number})`) // each Account with its bank number
    await expect(report.getByRole('table', { name: `Transactions in ${cheque.name}` }).locator('tbody tr')).toHaveCount(3)
    const total = report.getByRole('region', { name: 'All Accounts' })
    await expect(total).toContainText(`${SHOPS + 3} Transactions listed.`)
    await expect(total).toContainText(/Money in\s*\+\$500\.00\s*Money out\s*−\$1,039\.15\s*Net\s*−\$539\.15/)

    // Dates with nothing in them: the Account is still named, so a reader can see that nothing was left out.
    await page.goto(`/reports/transactions?account=${savingsId}&from=${year}-12-30&to=${year}-12-31`)
    await expect(article(page).getByRole('region', { name: savings.name })).toContainText('No Transactions in these dates.')
    await expect(article(page).getByRole('table')).toHaveCount(0)
  })

  test('is a Report for a single day when the dates are the same', async ({ page, context, baseURL }, testInfo) => {
    const { year, first, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/reports/transactions?account=${savingsId}&from=${year}-01-01&to=${year}-01-01`)
    await expect(article(page).locator('header dd').nth(1)).toHaveText(first) // one date, not "to" itself
    await expect(article(page).getByRole('table', { name: `Transactions in ${savings.name}` }).locator('tbody tr')).toHaveCount(1)
  })

  for (const role of ['admin', 'member'] as const) {
    test(`has no WCAG 2.2 AA violations as ${role === 'admin' ? 'the Admin' : 'a Member, who opens the Report the Admin kept'}`, async ({ page, context, baseURL }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
      await signInToOpen(context, baseURL, role, { report: 'transactions', accountId: savingsId, from: `${year}-01-01`, to: `${year}-12-31` })
      await page.goto(reportAddress(savingsId, year))
      await expect(article(page).getByRole('table')).toBeVisible()
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(reportAddress(savingsId, year))
    const cards = article(page).getByRole('list', { name: new RegExp('^Transactions in ') }).getByRole('listitem')
    await expect(cards).toHaveCount(SHOPS)
    await expect(cards.first()).toContainText(shop(0))
    await expect(cards.first()).toContainText(note(0))
    await expect(cards.first()).toContainText('−$10.00')
    await expect(cards.first()).toContainText('Category')
  })

  test('stops at 10,000 Transactions and says so, at the top and again before the end, and never says an Account it did not read has nothing', async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(120_000) // fifty full pages, and ten thousand rows to draw
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    // Three Accounts, the first with more than the cap in the range: every page is full, and there is always one more.
    // The cap falls part way through the first, so the other two are never read.
    const names = ['Example first', 'Example second', 'Example third']
    await page.route('**/api/accounts', (route) => route.fulfill({ json: names.map((name, i) => ({ id: i + 1, name, accountNumber: `99-9999-9999999-9${i}`, cutoverDate: null })) }))
    const asked: string[] = []
    await page.route('**/api/reports/transactions?**', async (route) => {
      const params = new URL(route.request().url()).searchParams
      asked.push(params.get('accountId')!)
      const limit = Number(params.get('limit'))
      const start = Number(params.get('after') ?? 0)
      const transactions = Array.from({ length: limit }, (_, k) => ({ id: start + k + 1, date: `${year}-10-01`, description: `EXAMPLE ${start + k + 1}`, amountCents: -100, categoryName: null, note: null, source: 'import', bankReference: null, bankCounterpartyAccount: null, bankCardSuffix: null, bankParticulars: null, bankPaymentCode: null }))
      await route.fulfill({ json: { transactions, next: String(start + limit) } })
    })
    await page.goto(`/reports/transactions?from=${year}-01-01&to=${year}-12-31`)

    const report = article(page)
    await expect(report.getByRole('alert')).toContainText('This Report stops after 10,000 Transactions', { timeout: 60_000 })
    await expect(report.getByText('10,000 Transactions listed, oldest first.')).toBeVisible()
    await expect(report.locator('tbody tr')).toHaveCount(10_000)
    await expect(report.getByText('This Report stops after 10,000 Transactions')).toHaveCount(2)
    await expect(report.getByRole('region', { name: 'All Accounts' })).toContainText('10,000 Transactions listed.')

    // The Account the cap fell in is partly listed; the others were not listed, which is not the same as having nothing in the dates.
    await expect(report.getByRole('region', { name: 'Example first' })).toContainText('Partly listed: this Report stopped part way through this Account.')
    for (const name of ['Example second', 'Example third']) {
      const section = report.getByRole('region', { name })
      await expect(section).toContainText('Not listed: this Report stopped before this Account.')
      await expect(section).not.toContainText('No Transactions in these dates')
      await expect(section.getByRole('table')).toHaveCount(0)
    }
    await expect(report.getByText('No Transactions in these dates')).toHaveCount(0)
    expect(new Set(asked)).toEqual(new Set(['1'])) // nothing was asked about the Accounts after the cut-off
    await expect(report.locator('dl').last()).toContainText('−$10,000.00')
  })

  test.describe('when a page of the Report fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: an incomplete listing never looks complete', async ({ page, context, baseURL }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'admin')
      await page.route('**/api/reports/transactions?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(reportAddress(savingsId, year))
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
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'admin')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(reportAddress(savingsId, year))
    await expect(article(page).getByRole('table')).toBeVisible()
  })

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    await expectTitleBlock(article(page), { name: 'Transaction listing', account: `${savings.name} (${savings.number})`, dates: `${first} to ${last}` })
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    await expectIdentityRow(page, `${TITLE} – Transaction listing – ${savings.name} (${savings.number}) – ${first} to ${last}`)
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Transaction listing – ${savings.name} – ${first} to ${last}`)
  })

  test('is black text on white paper, even from the dark theme', { tag: '@theme' }, async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expectBlackOnWhite(page, 100) // every word, including the muted ones and the money, is black
  })

  test('has no text under 12pt', async ({ page }) => {
    await expectNoTextUnder12pt(page, article(page), 100)
  })

  test('is its own page with its own margins, repeats table headings and keeps a row whole', async ({ page }) => {
    await expectOwnPage(page)
  })

  test('is several A4 pages with the table headings on every one, no Transaction lost, repeated or cut across pages', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(3)
    const withRows = pages.filter((p) => textOf(p).includes('EXAMPLE SHOP'))
    expect(withRows.length).toBeGreaterThanOrEqual(3)

    // Headings come back on every page the table runs onto, not only the first.
    for (const p of withRows) for (const heading of ['Date', 'Description', 'Category', 'Note', 'Amount']) expect(p.text.map((t) => t.str), `${heading} on page ${pages.indexOf(p) + 1}`).toContain(heading)

    // Every Transaction is on exactly one page, with its own amount beside it.
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    for (let i = 0; i < SHOPS; i++) {
      expect(all.split(shop(i)).length - 1, shop(i)).toBe(1)
      const where = pages.find((p) => textOf(p).includes(shop(i)))!
      expect(textOf(where), `${shop(i)} and its amount are on one page`).toContain(`−$${(-shopCents(i) / 100).toFixed(2)}`)
    }
  })

  test('numbers every page "Page 2 of 5" in the bottom margin', async ({ page }) => {
    expectPageNumbers(await readPdf(await page.pdf({ format: 'A4' })))
  })

  test('says what the Report is, which Account and dates, and who generated it and when, at the top of every page the table runs onto', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    // The Admin's title comes through as typed, quote and backslash too.
    expectIdentityOnEveryPage(pages, 'EXAMPLE SHOP', `${TITLE} – Transaction listing – ${savings.name} (${savings.number}) – ${first} to ${last}`, 3)
  })

  test('has nothing in the top margin and only the page number in the bottom one', async ({ page }) => {
    expectBareMargins(await readPdf(await page.pdf({ format: 'A4' })))
  })

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    expectNoTypeUnder12pt(await readPdf(await page.pdf({ format: 'A4' })), 300)
  })

  test('prints the same from a phone-width window: still a table', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(article(page).getByRole('table')).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Around a Report

test.describe('around a Report', () => {
  test('is titled for Save as PDF while a Report is open, and goes back to the app title when it is left', async ({ page, context, request, baseURL }, testInfo) => {
    const { year, first, last, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'admin')
    await page.goto(reportAddress(savingsId, year))
    await expect(page).toHaveTitle(`Mum's finances – Transaction listing – ${savings.name} – ${first} to ${last}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")

    await page.goto(`/reports/transactions?from=${year}-01-01&to=${year}-12-31`)
    await expect(page).toHaveTitle(`Mum's finances – Transaction listing – All Accounts – ${first} to ${last}`)
  })

  test('another printed page keeps the screen padding: only a Report sets its own margins', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/how-to-sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    const padding = () => page.locator('main').evaluate((el) => getComputedStyle(el).paddingLeft)
    const onScreen = await padding()
    expect(parseFloat(onScreen)).toBeGreaterThan(0)
    await page.emulateMedia({ media: 'print' })
    expect(await padding()).toBe(onScreen)
  })

  test('a Transaction from Sync shows everything the bank said under its description, with the parts it lacks left out', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    const row = { id: 1, date: `${year}-10-01`, amountCents: -100, categoryName: null, note: null, source: 'sync' }
    await page.route('**/api/reports/transactions?**', (route) =>
      route.fulfill({
        json: {
          transactions: [
            { ...row, description: 'EXAMPLE FULL', bankReference: 'Ref 77', bankCounterpartyAccount: '99-9999-9999999-97', bankCardSuffix: '1234', bankParticulars: 'Rent', bankPaymentCode: 'Oct' },
            { ...row, id: 2, description: 'EXAMPLE PARTLY', bankReference: null, bankCounterpartyAccount: '99-9999-9999999-97', bankCardSuffix: null, bankParticulars: ' ', bankPaymentCode: null },
            { ...row, id: 3, description: 'EXAMPLE NONE', bankReference: null, bankCounterpartyAccount: null, bankCardSuffix: null, bankParticulars: null, bankPaymentCode: null },
          ],
          next: null,
        },
      }),
    )
    await page.goto(reportAddress(savingsId, year))
    const rows = article(page).locator('tbody tr td:nth-child(2)')
    await expect(rows.nth(0)).toHaveText('EXAMPLE FULLReference: Ref 77 · Counterparty account: 99-9999-9999999-97 · Card: Ending 1234 · Particulars: Rent · Code: Oct')
    await expect(rows.nth(1)).toHaveText('EXAMPLE PARTLYCounterparty account: 99-9999-9999999-97')
    await expect(rows.nth(2)).toHaveText('EXAMPLE NONE')
  })
})
