import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'

// Ticket 18: the Report frame and the Transaction listing Report (spec stories 97 to 99). A Report opens in a new window, is
// laid out for paper, and says on its face what it is, which Account and dates it covers, and who generated it and when.
// The print layout is checked three ways: the page under print media (what the browser lays out), and the PDF it makes
// (page count, the text on each page, the page margins and the size of the type).

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const MEMBER_EMAIL = 'dev.member@example.com'
const TITLE = `Mum's "family" finances \\ Report` // quote, apostrophe and backslash: the Admin can type any of them
const NOW = new Date('2026-10-08T02:42:00.000Z') // 3:42 pm in NZ
const GENERATED = `Generated Thu 8 Oct 2026 at 3:42 pm by ${MEMBER_EMAIL}`

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
  const importRows = async (account: { number: string; name: string }, rows: { date: string; uniqueId: string; payee: string; amountCents: number; chequeNumber?: string }[]) => {
    const res = await context.request.post('/api/imports/chunks', {
      headers: { Origin: baseURL },
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: `${year}-01-01`, to: `${year}-12-31`, ledgerBalance: { cents: 0, date: `${year}-12-31` } },
        rows: rows.map((r) => ({ ...r, tranType: 'EFTPOS', chequeNumber: r.chequeNumber ?? null, bankMemo: 'EFTPOS' })),
      },
    })
    expect(res.ok()).toBe(true)
  }
  await importRows(
    savings,
    Array.from({ length: SHOPS }, (_, i) => ({ date: day(year, 4 * i), uniqueId: `RPT${year}S${i}`, payee: shop(i), amountCents: shopCents(i), chequeNumber: hasCheque(i) ? chequeNumber(i) : undefined })),
  )
  await importRows(cheque, [
    { date: day(year, 10), uniqueId: `RPT${year}C1`, payee: 'EXAMPLE WAGES', amountCents: 50000 },
    { date: day(year, 20), uniqueId: `RPT${year}C2`, payee: 'EXAMPLE RATES', amountCents: -30000 },
    { date: day(year, 30), uniqueId: `RPT${year}C3`, payee: 'EXAMPLE CAFE', amountCents: -1500 },
  ])

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

// The Settings are shared by every test and both themes, so each test leaves the defaults behind (as settings.spec.ts does).
test.afterEach(async ({ request, baseURL }) => {
  const reset = await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title: 'Fernledger' } })
  expect(reset.ok()).toBe(true)
})
const setTitle = async (request: APIRequestContext, baseURL: string | undefined, app_title: string) =>
  expect((await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title } })).ok()).toBe(true)

const reportAddress = (id: number, year: number, extra = '') => `/reports/transactions?account=${id}&from=${year}-01-01&to=${year}-12-31${extra}`
const article = (page: Page) => page.getByRole('article', { name: 'Transaction listing' })
const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening a Report', () => {
  test('the Transactions page opens it in a new window, carrying the Account and dates', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(`/transactions?account=${savingsId}&from=${year}-01-01&to=${year}-12-31`)

    const link = page.getByRole('link', { name: /Transaction listing Report/ })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    const href = new URL((await link.getAttribute('href'))!, baseURL)
    expect(href.pathname).toBe('/reports/transactions')
    expect(Object.fromEntries(href.searchParams)).toEqual({ account: String(savingsId), from: `${year}-01-01`, to: `${year}-12-31` })

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])
    await expect(popup.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
    await expect(popup.getByRole('article', { name: 'Transaction listing' })).toContainText(dataFor(testInfo.project.name).savings.name)
    await expect(page).toHaveURL(/\/transactions\?/) // the Transactions page is still where it was
  })

  test('the Transactions page offers no Report until it has dates, and points to the Reports page', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/transactions')
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Transaction listing Report/ })).toHaveCount(0)
    await page.getByRole('link', { name: 'choose dates on the Reports page' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
  })

  test('the Reports page is in every Member\'s navigation, and its form opens the Report in a new window', async ({ page, context, baseURL }, testInfo) => {
    const { year, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()

    await page.getByLabel('Account').selectOption({ label: savings.name })
    await page.getByLabel('From').fill(`${year}-01-01`)
    await page.getByLabel('To').fill(`${year}-12-31`)
    const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(popup.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
    expect(Object.fromEntries(new URL(popup.url()).searchParams)).toEqual({ account: String(savingsId), from: `${year}-01-01`, to: `${year}-12-31` })
  })

  test('the Reports form asks for real dates, in order, and opens nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    const open = page.getByRole('button', { name: 'Open Report in a new window' })

    await open.click()
    await expect(page.getByRole('alert')).toHaveText('Choose a From date.')
    await page.getByLabel('From').fill('2013-12-31')
    await open.click()
    await expect(page.getByRole('alert')).toHaveText('Choose a To date.')
    await page.getByLabel('To').fill('2013-01-01')
    await open.click()
    await expect(page.getByRole('alert')).toContainText('before the “From” date')
    await expect(page.getByLabel('To')).toHaveAttribute('aria-invalid', 'true')
    expect(context.pages()).toHaveLength(1)
    await noAxeViolations(page)
  })

  test('a Report address without dates, with dates the wrong way round, or with no such Account explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const [address, words, alert] of [
      ['/reports/transactions', 'Choose the first and last dates', false],
      ['/reports/transactions?from=2013-12-31&to=2013-01-01', 'before the “From” date', true],
      ['/reports/transactions?account=999999999&from=2013-01-01&to=2013-12-31', 'There is no such Account', true],
    ] as const) {
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status')).toContainText(words)
      await expect(page.getByRole('button', { name: 'Open Report in a new window' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without an Account and dates
    }
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
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
    await signInAs(context, 'member')
    await page.goto(reportAddress(savingsId, year))

    const report = article(page)
    await expect(report.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
    const header = report.locator('header')
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
    await signInAs(context, 'member')
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
    const { year, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(`/reports/transactions?account=${savingsId}&from=${year}-01-01&to=${year}-01-01`)
    await expect(article(page).locator('header dd').nth(1)).toHaveText(dataFor(testInfo.project.name).first) // one date, not "to" itself
    await expect(article(page).getByRole('table', { name: `Transactions in ${savings.name}` }).locator('tbody tr')).toHaveCount(1)
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}`, async ({ page, context, baseURL }, testInfo) => {
      const { year } = dataFor(testInfo.project.name)
      const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, role)
      await page.goto(reportAddress(savingsId, year))
      await expect(article(page).getByRole('table')).toBeVisible()
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
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
    await signInAs(context, 'member')
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
      await signInAs(context, 'member')
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
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(reportAddress(savingsId, year))
    await expect(article(page).getByRole('table')).toBeVisible()
  })

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
    await expect(page.getByRole('link')).toHaveCount(0)
    await expect(page.getByText('In the print window')).toBeHidden()
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    const header = article(page).locator('header')
    await expect(header).toBeVisible()
    await expect(header.getByText(TITLE, { exact: true })).toBeVisible() // the Admin's words, as typed
    await expect(header.getByRole('heading', { level: 1, name: 'Transaction listing' })).toBeVisible()
    await expect(header).toContainText(`Account: ${savings.name} (${savings.number})`)
    await expect(header).toContainText(`Dates: ${first} to ${last}`)
    await expect(header.getByText(GENERATED, { exact: true })).toBeVisible()
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    const identity = page.locator('thead tr').first()
    await expect(identity).toBeVisible() // on screen it is not
    await expect(identity).toContainText(`${TITLE} – Transaction listing – ${savings.name} (${savings.number}) – ${first} to ${last}`)
    await expect(identity).toContainText(GENERATED)
    // It is one of the table's heading rows, with the column headings: that is what makes a browser repeat it.
    expect(await page.locator('thead').evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Transaction listing – ${savings.name} – ${first} to ${last}`)
  })

  test('is black text on white paper, even from the dark theme', async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    const { unreadable, paper, texts } = await page.evaluate(() => {
      const rgb = (css: string) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.fillStyle = '#fff'
        ctx.fillStyle = css
        ctx.fillRect(0, 0, 1, 1)
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
      }
      const root = document.querySelector('.report-frame')!
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
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
    expect(texts).toBeGreaterThan(100)
    expect(unreadable).toEqual([]) // every word, including the muted ones and the money, is black
    expect(Math.min(...paper)).toBeGreaterThan(240)
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
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const margin = (20 / 25.4) * 72 // the bottom margin, 20mm, in points
    pages.forEach((p, index) => {
      const numbered = p.text.filter((t) => t.str === `Page ${index + 1} of ${pages.length}`)
      expect(numbered, `page ${index + 1}`).toHaveLength(1)
      expect(numbered[0]!.y).toBeLessThan(margin)
    })
  })

  test('says what the Report is, which Account and dates, and who generated it and when, at the top of every page the table runs onto', async ({ page }, testInfo) => {
    const { first, last, savings } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const withRows = pages.filter((p) => textOf(p).includes('EXAMPLE SHOP'))
    expect(withRows.length).toBeGreaterThanOrEqual(3)
    // In each page's own body, not its margins, so every browser prints it. The Admin's title comes through as typed, quote and backslash too.
    // (The line may wrap, even inside the Account's number at a hyphen, so the comparison ignores where it broke.)
    const squash = (text: string) => text.replace(/\s+/g, '')
    for (const p of withRows) {
      const text = squash(textOf(p))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(`${TITLE} – Transaction listing – ${savings.name} (${savings.number}) – ${first} to ${last}`))
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

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const sizes = pages.flatMap((p, index) => p.text.filter((t) => t.size < 11.95).map((t) => `page ${index + 1}: ${t.size}pt "${t.str}"`))
    expect(sizes).toEqual([])
    expect(pages.flatMap((p) => p.text).length).toBeGreaterThan(300)
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
    await signInAs(context, 'member')
    await page.goto(reportAddress(savingsId, year))
    await expect(page).toHaveTitle(`Mum's finances – Transaction listing – ${savings.name} – ${first} to ${last}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")

    await page.goto(`/reports/transactions?from=${year}-01-01&to=${year}-12-31`)
    await expect(page).toHaveTitle(`Mum's finances – Transaction listing – All Accounts – ${first} to ${last}`)
  })

  test('another printed page keeps the screen padding: only a Report sets its own margins', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.emulateMedia({ media: 'print' })
    await page.goto('/how-to-sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('16px')
  })

  test('a Transaction from Sync shows everything the bank said under its description, with the parts it lacks left out', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
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
