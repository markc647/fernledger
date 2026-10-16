import type { BrowserContext, Page } from '@playwright/test'
import { pickDate } from './date-helpers'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { ADMIN_EMAIL, dateText, ensureCategory, forgetKeptReports, forgetKeptReportsAfterEach, importRows, MEMBER_EMAIL, type KeptChoices } from './report-helpers'
import { actionsButton, menuAction, OPEN_MENU, openActions } from './row-actions-helpers'
import { breadcrumb, chooseTextSize, expectTextSize, navGroup, navLink } from './shell-helpers'

// UI ticket U7: Kept Reports. Only the Admin makes Reports. Each time the Admin shows one, its CHOICES (which Report, its dates, its Account) are kept, and the Reports page is a table of
// them: every Member can open or print one, and only the Admin can delete one. Opening a kept Report works it out again from today's data, so nothing is stored that goes stale. The
// Worker's side (the list, the dedupe, the Change Log, the Member who asks for a Report that is not kept) is in worker/kept-reports.test.ts; this is the page, in a browser.

test.describe.configure({ mode: 'serial' })
forgetKeptReportsAfterEach() // the list is shared by every spec and both themes, so each test leaves it as it found it: empty
test.beforeEach(async ({ request, baseURL }) => forgetKeptReports(request, baseURL)) // and a run that stopped part way leaves none for this one

// The light and dark projects share one local database, so each has an Account of its own, with one Transaction in 2012: a year that no Report of another spec covers (the Transactions
// page's specs have Transactions of their own then, found by a stamp, and are not added up).
const dataFor = (project: string) => {
  const dark = project === 'dark'
  return { year: 2012, account: { number: dark ? '99-9999-9999999-31' : '99-9999-9999999-30', name: `Kept savings ${project}` } }
}

async function seed(context: BrowserContext, baseURL: string, project: string) {
  const { year, account } = dataFor(project)
  await signInAs(context, 'admin')
  await importRows(context, baseURL, { account, year, rows: [{ date: `${year}-03-10`, uniqueId: `KEPT${year}`, payee: 'EXAMPLE KEPT SHOP', amountCents: -1234 }] })
  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  return { accountId: accounts.find((a) => a.name === account.name)!.id }
}

type Kept = { id: number; report: string; accountId: number | null; lastMadeAt: string }
const keptList = async (context: BrowserContext) => (await (await context.request.get('/api/kept-reports')).json()) as Kept[]

/** Keeps a Report as the Admin's showing it would have, without showing it. */
async function keep(context: BrowserContext, baseURL: string | undefined, choices: KeptChoices) {
  await signInAs(context, 'admin')
  const res = await context.request.post('/api/kept-reports', { headers: { Origin: baseURL! }, data: choices })
  expect(res.ok()).toBe(true)
}

/** The table's body rows, and the one that is of a Report (its name and, for a Report of one Account, the Account). */
const rows = (page: Page) => page.getByRole('table', { name: 'Kept Reports' }).locator('tbody tr')
const rowOf = (page: Page, text: string | RegExp) => rows(page).filter({ hasText: text })
const WHEN = /[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2,4} \d{4}, \d{1,2}:\d{2} (am|pm)$/

/** The menu's Save or Share, which says "Coming later" as well and is turned off. */
const turnedOff = (page: Page, word: string) => page.getByRole('menuitem', { name: new RegExp(`^${word}\\s*Coming later$`) })

/** What a row's "⋯" button is named for: the Report, its Loans Category if it has one, its dates and its Account. */
const rowName = (report: string, dates: string, account: string) => `${report}, ${dates}, ${account}`
const range = (year: number) => `${dateText(`${year}-01-01`)} to ${dateText(`${year}-12-31`)}`

/** Counts the times the page asks for the browser's print window, which a test cannot see. */
const stubPrint = (page: Page) =>
  page.addInitScript(() => {
    ;(window as unknown as { printed: number }).printed = 0
    window.print = () => void ((window as unknown as { printed: number }).printed += 1)
  })
const printed = (page: Page) => page.evaluate(() => (window as unknown as { printed: number }).printed)

/** Lets the page draw `count` frames: a print is started two frames after a Report is painted, so a test that a print did not happen again waits a few frames and then looks. */
const frames = (page: Page, count: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)))
        next(n)
      }),
    count,
  )

/** The requests the page makes to keep a Report, as they are made. */
function keepRequests(page: Page) {
  const made: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/kept-reports') made.push(request.url())
  })
  return made
}

// ---------------------------------------------------------------------------------------------------------------
// Making a Report keeps it

test.describe('showing a Report as the Admin', () => {
  test('keeps its choices on the Reports page: the Report, its dates, its Account, when it was made and by whom', async ({ page, context, baseURL }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page.getByText('No Reports have been made yet.')).toBeVisible() // nothing is kept until a Report is shown

    await page.goto('/reports/spending')
    const form = page.getByRole('form', { name: 'Spending by Category' })
    await form.getByLabel('Account').selectOption({ label: account.name })
    await pickDate(form, 'From', `${year}-01-01`)
    await pickDate(form, 'To', `${year}-12-31`)
    await form.getByRole('button', { name: 'Show Report' }).click()
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()

    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first().getByRole('cell')).toHaveText(['Spending by Category', range(year), account.name, WHEN, ADMIN_EMAIL, ''])
  })

  test('adds no second row for the same choices: showing it again says when it was last made', async ({ page, context, baseURL }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto(`/reports/spending?account=${accountId}&from=${year}-01-01&to=${year}-12-31`)
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await expect.poll(async () => (await keptList(context)).length).toBe(1)
    const [first] = await keptList(context)

    // Asking for the Report that is open again reads it again, which is making it again.
    await page.getByRole('form', { name: 'Spending by Category' }).getByRole('button', { name: 'Show Report' }).click()
    await expect.poll(async () => (await keptList(context))[0]!.lastMadeAt).not.toBe(first!.lastMadeAt)
    expect(await keptList(context)).toHaveLength(1)
    expect((await keptList(context))[0]!.id).toBe(first!.id)

    // Opening its page again, another day or another window, is too.
    const second = (await keptList(context))[0]!.lastMadeAt
    await page.goto(`/reports/spending?account=${accountId}&from=${year}-01-01&to=${year}-12-31`)
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await expect.poll(async () => (await keptList(context))[0]!.lastMadeAt).not.toBe(second)
    expect(await keptList(context)).toHaveLength(1)

    await page.goto('/reports')
    await expect(rows(page)).toHaveCount(1)
    await expect(rowOf(page, account.name)).toHaveCount(1)
  })

  test('adds a row for other choices, says all Accounts for a Report with none, and keeps a Report of every Account and of one apart', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    for (const address of [
      `/reports/balances?account=${accountId}&from=${year}-01-01&to=${year}-12-31`,
      `/reports/balances?from=${year}-01-01&to=${year}-12-31`,
      `/reports/budget-vs-actual?from=${year}-01-01&to=${year}-06-30`,
    ]) {
      await page.goto(address)
      await expect(page.getByRole('article')).toBeVisible()
      await expect.poll(async () => (await keptList(context)).length).toBeGreaterThan(0)
    }
    await expect.poll(async () => (await keptList(context)).length).toBe(3)
    // A Loans Report has a Loans Category in place of an Account. Every Loans Category is the one the Report of them all has.
    await keep(context, baseURL, { report: 'loans', to: `${year}-12-31` })

    await page.goto('/reports')
    await expect(rows(page)).toHaveCount(4)
    await expect(rowOf(page, 'Budget vs actual')).toContainText(`${dateText(`${year}-01-01`)} to ${dateText(`${year}-06-30`)}`)
    await expect(rowOf(page, 'Budget vs actual')).toContainText('All Accounts') // a Budget is for all Accounts together
    await expect(rowOf(page, 'Loans')).toContainText('All loans') // the Loans Category, which a Loans Report has in place of an Account
    await expect(rowOf(page, 'Loans')).toContainText(`From the first Transaction to ${dateText(`${year}-12-31`)}`)
    await expect(rowOf(page, 'Balances over time')).toHaveCount(2)
    await expect(rowOf(page, /Balances over time.*All Accounts/)).toHaveCount(1)
    await expect(rows(page).first().getByRole('cell').first()).toContainText('Loans') // the one made last is first
  })

  test('keeps nothing for a Report it could not show', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    const keeps = keepRequests(page)
    for (const address of [
      `/reports/spending?account=999999999&from=${year}-01-01&to=${year}-12-31`, // no such Account
      `/reports/spending?from=${year}-12-31&to=${year}-01-01`, // the wrong way round
      `/reports/spending?from=${year}-01-01`, // no last date
    ]) {
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
      await expect(page.getByRole('alert').or(page.getByRole('status').filter({ hasText: /^Choose/ }))).toBeVisible()
      await frames(page, 5) // a Report that was shown would ask to be kept by now
    }
    expect(keeps).toEqual([])
    expect(await keptList(context)).toEqual([])
  })

})

test.describe('showing a Report as the Admin, when the list refuses it', () => {
  test.use({ expectedStatuses: [500] })
  test('is the Report, and a line that says it was not added to the list', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'admin')
    await page.route('**/api/kept-reports', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, json: { error: 'Something went wrong' } }) : route.continue()))
    await page.goto(`/reports/spending?account=${accountId}&from=${year}-01-01&to=${year}-12-31`)
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText("couldn't add this Report to the list on the Reports page")
    expect(await keptList(context)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The Reports page: a table of kept Reports

test.describe('the Reports page', () => {
  test('is a table of the kept Reports, newest first, and for the Admin says where to make one when there are none', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await signInAs(context, 'admin')
    await page.goto('/reports')
    await expect(page.getByRole('table')).toHaveCount(0)
    await expect(page.getByText('No Reports have been made yet.')).toBeVisible()
    await expect(page.getByText('Choose one under Reports in the sidebar to make the first.')).toBeVisible()

    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await keep(context, baseURL, { report: 'income-vs-spending', from: `${year}-01-01`, to: `${year}-12-31` })
    await page.reload()
    const table = page.getByRole('table', { name: 'Kept Reports' })
    await expect(table.getByRole('columnheader')).toHaveText(['Report', 'Dates', 'Account', 'Last made', 'Made by', 'Actions'])
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).first()).toContainText('Income vs spending by month')
    await expect(rows(page).first()).toContainText('All Accounts')
    await expect(rows(page).first()).toContainText(ADMIN_EMAIL)
    await expect(rows(page).first().getByRole('cell').nth(3)).toHaveText(WHEN)
    await expect(rows(page).last()).toContainText('Budget vs actual')
  })

  test('has no card for each Report any more: the six are in the sidebar, for the Admin', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports')
    await expect(page.locator('[data-slot="card"]')).toHaveCount(0)
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    for (const name of ['Spending by Category', 'Income vs spending by month', 'Loans', 'Transaction listing', 'Balances over time', 'Budget vs actual']) {
      await expect(navLink(page, name)).toBeVisible()
    }
  })

  test("has a menu on each row, with an icon for each item: Open, Print, Save and Share (turned off, as coming later), then Delete after a line, for the Admin", async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await page.goto('/reports')
    const name = rowName('Budget vs actual', `${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`, 'All Accounts')
    await openActions(actionsButton(page, name))
    await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Print', 'SaveComing later', 'ShareComing later', 'Delete'])
    for (const item of await page.getByRole('menuitem').all()) await expect(item.locator('svg')).toHaveCount(1)
    await expect(menuAction(page, 'Open')).toBeEnabled()
    await expect(menuAction(page, 'Print')).toBeEnabled()
    for (const word of ['Save', 'Share']) {
      await expect(turnedOff(page, word)).toHaveAttribute('aria-disabled', 'true')
      await expect(turnedOff(page, word)).toContainText('Coming later')
    }
    await expect(menuAction(page, 'Delete')).toBeEnabled()
    await expect(page.getByRole('separator')).toHaveCount(1) // the destructive one is last, after a line
    await noAxeViolations(page, { within: OPEN_MENU })
  })

  test('Save and Share do nothing for now: choosing one leaves the menu where it was and starts nothing', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await stubPrint(page)
    await page.goto('/reports')
    const name = rowName('Budget vs actual', `${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`, 'All Accounts')
    await openActions(actionsButton(page, name))
    for (const word of ['Save', 'Share']) {
      await turnedOff(page, word).click({ force: true })
      await expect(page.getByRole('menu')).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/\/reports$/)
    expect(await printed(page)).toBe(0)
    await expect(rows(page)).toHaveCount(1)
  })

  test('Open shows the Report, in this window, at its address, worked out again from today\'s data', async ({ page, context, baseURL }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await keep(context, baseURL, { report: 'spending', accountId, from: `${year}-01-01`, to: `${year}-12-31` })
    await signInAs(context, 'admin')
    const asked: string[] = []
    await page.route('**/api/reports/spending?**', (route) => {
      asked.push(route.request().url())
      return route.continue()
    })
    await page.goto('/reports')
    const name = rowName('Spending by Category', range(year), account.name)

    await openActions(actionsButton(page, name))
    await menuAction(page, 'Open').click()
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    expect(context.pages()).toHaveLength(1)
    expect(new URL(page.url()).pathname).toBe('/reports/spending')
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ account: String(accountId), from: `${year}-01-01`, to: `${year}-12-31` })
    await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Reports', 'Spending by Category'])
    expect(asked).toHaveLength(1)

    // Opened again from the list, it is read again: the figures are not what an earlier visit kept.
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await openActions(actionsButton(page, name))
    await menuAction(page, 'Open').click()
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await expect.poll(() => asked.length).toBe(2)
  })

  test('Print opens the Report and starts the browser\'s print window, once', async ({ page, context, baseURL }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await keep(context, baseURL, { report: 'spending', accountId, from: `${year}-01-01`, to: `${year}-12-31` })
    await signInAs(context, 'admin')
    await stubPrint(page)
    await page.goto('/reports')
    await openActions(actionsButton(page, rowName('Spending by Category', range(year), account.name)))
    await menuAction(page, 'Print').click()

    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await expect.poll(() => printed(page)).toBe(1)
    await frames(page, 5)
    expect(await printed(page)).toBe(1) // once
  })

  test('Delete asks first, in the row; keeping it puts focus back on the row\'s button, and deleting takes the row off the list and says so', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await keep(context, baseURL, { report: 'income-vs-spending', from: `${year}-01-01`, to: `${year}-12-31` })
    await page.goto('/reports')
    const name = rowName('Budget vs actual', `${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`, 'All Accounts')

    await openActions(actionsButton(page, name))
    await menuAction(page, 'Delete').click()
    const question = page.getByRole('group', { name: `Delete ${name}` })
    await expect(question).toBeVisible()
    await expect(question).toContainText('comes off this list')
    await expect(question).toContainText(`Delete the Budget vs actual Report, ${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}, all Accounts? It comes off`) // a phrase of the list is in lower case in the middle of a sentence
    await expect(question.getByRole('button', { name: 'Keep it' })).toBeFocused() // it opens on the safe answer
    await noAxeViolations(page)
    await question.getByRole('button', { name: 'Keep it' }).click()
    await expect(question).toHaveCount(0)
    await expect(actionsButton(page, name)).toBeFocused()
    await expect(rows(page)).toHaveCount(2)
    expect(await keptList(context)).toHaveLength(2)

    await openActions(actionsButton(page, name))
    await menuAction(page, 'Delete').click()
    await question.getByRole('button', { name: `Yes, delete ${name}` }).click()
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Income vs spending by month')
    const notice = page.getByRole('status').filter({ hasText: `Deleted ${name}.` })
    await expect(notice).toBeVisible()
    await expect(notice).toBeFocused()
    expect((await keptList(context)).map((k) => k.report)).toEqual(['income-vs-spending'])
    // The Change Log says what was removed, as for any other Admin change.
    await page.goto('/change-log')
    await expect(page.getByRole('listitem').filter({ hasText: 'Removed the kept Budget vs actual Report' }).first()).toContainText('Report change by admin@example.com')
  })

  test('Delete asks about a Loans Report in words that read as a sentence: all loans, from the first Transaction, all Accounts', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'loans', to: `${year}-12-31` })
    await page.goto('/reports')
    const name = rowName('Loans, All loans', `From the first Transaction to ${dateText(`${year}-12-31`)}`, 'All Accounts')
    await openActions(actionsButton(page, name))
    await menuAction(page, 'Delete').click()
    await expect(page.getByRole('group', { name: `Delete ${name}` })).toContainText(`Delete the Loans Report for all loans, from the first Transaction to ${dateText(`${year}-12-31`)}, all Accounts? It comes off`)
  })

  test('has no WCAG 2.2 AA violations as the Admin, with rows, and on a phone, where the rows are cards', async ({ page, context, baseURL }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await keep(context, baseURL, { report: 'spending', accountId, from: `${year}-01-01`, to: `${year}-12-31` })
    await keep(context, baseURL, { report: 'loans', to: `${year}-12-31` })
    await signInAs(context, 'admin')
    await page.goto('/reports')
    await expect(rows(page)).toHaveCount(2)
    await noAxeViolations(page)

    await page.setViewportSize({ width: 390, height: 844 })
    const cards = page.getByRole('list', { name: 'Kept Reports' }).getByRole('listitem')
    await expect(cards).toHaveCount(2)
    await expect(cards.last()).toContainText(account.name)
    await expect(cards.last()).toContainText('Last made')
    await noAxeViolations(page)
    await openActions(actionsButton(page, rowName('Spending by Category', range(year), account.name)))
    await expect(page.getByRole('menuitem')).toHaveCount(5)
    await noAxeViolations(page, { within: OPEN_MENU })
  })

  test('is at least 44px for the button and every item of its menu, at the Medium and Xtra Large text sizes', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await page.goto('/reports')
    const name = rowName('Budget vs actual', `${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`, 'All Accounts')
    for (const size of ['Medium', 'Xtra Large'] as const) {
      await chooseTextSize(page, size)
      await expectTextSize(page, size)
      await settle(page)
      const box = (await actionsButton(page, name).boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      await openActions(actionsButton(page, name))
      await settle(page)
      for (const item of await page.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await page.keyboard.press('Escape')
    }
  })

  // At 320px wide at 400% zoom, with the largest text: a long Account name and a long email wrap in the card and do not push the page wider.
  test('fits a narrow window with long names in it: no horizontal scrolling at 400% zoom and the largest text', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/kept-reports', (route) =>
      route.fulfill({
        json: [
          { id: 1, report: 'transactions', accountId: 1, accountName: `Example account with a long name ${'y'.repeat(60)}`, categoryId: null, categoryName: null, categoryRemoved: false, from: '2026-01-01', to: '2026-10-31', lastMadeAt: '2026-10-16T01:00:00.000Z', madeBy: `${'someone.with.a.long.address'.repeat(3)}@example.com` },
          { id: 2, report: 'loans', accountId: null, accountName: null, categoryId: 2, categoryName: `Loan – ${'Alexandra'.repeat(8)}`, categoryRemoved: false, from: null, to: '2026-10-31', lastMadeAt: '2026-10-15T01:00:00.000Z', madeBy: ADMIN_EMAIL },
        ],
      }),
    )
    for (const [width, height] of [[640, 360], [320, 256], [316, 256]] as const) {
      await page.setViewportSize({ width, height })
      await page.goto('/reports')
      await chooseTextSize(page, 'Xtra Large')
      await expect(page.getByText(/Example account with a long name/)).toBeVisible()
      await expectTextSize(page, 'Xtra Large')
      await settle(page)
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
      expect(scrollWidth, `${width}px wide`).toBeLessThanOrEqual(clientWidth)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// A Member

test.describe('a Member', () => {
  test('sees the table and the menu of Open and Print only: nothing to delete, nothing to change', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first().getByRole('cell').nth(4)).toHaveText(ADMIN_EMAIL) // who made it: the Admin, not the Member reading it
    await expect(page.getByText('Choose one under Reports in the sidebar')).toHaveCount(0)

    const name = rowName('Budget vs actual', `${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`, 'All Accounts')
    await openActions(actionsButton(page, name))
    await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Print', 'SaveComing later', 'ShareComing later'])
    await expect(page.getByRole('separator')).toHaveCount(0)
    await noAxeViolations(page, { within: OPEN_MENU })
    await page.keyboard.press('Escape')
    await noAxeViolations(page)
    // Their sidebar has the Reports page and no Report of its own.
    await expect(navLink(page, 'Reports')).toBeVisible()
    await expect(navLink(page, 'Budget vs actual')).toHaveCount(0)
  })

  test('is told no Reports have been made when there are none, and that the Admin makes them', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(page.getByText('No Reports have been made yet. The Admin makes them.')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
    await noAxeViolations(page)
  })

  test('opens a kept Report with no form on its page, and the Report is the same one: worked out again, as them', async ({ page, context, baseURL }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    await keep(context, baseURL, { report: 'spending', accountId, from: `${year}-01-01`, to: `${year}-12-31` })
    const lastMade = (await keptList(context))[0]!.lastMadeAt
    await signInAs(context, 'member')
    const keeps = keepRequests(page)
    await page.goto('/reports')
    await openActions(actionsButton(page, rowName('Spending by Category', range(year), account.name)))
    await menuAction(page, 'Open').click()

    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
    await expect(page.getByRole('form')).toHaveCount(0) // the form is the Admin's
    await expect(page.getByRole('button', { name: 'Show Report' })).toHaveCount(0)
    await expect(page.getByRole('article')).toContainText(`by ${MEMBER_EMAIL}`)
    await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Reports', 'Spending by Category'])
    await expect(navLink(page, 'Reports')).toHaveAttribute('data-active', 'true') // a Member's sidebar has no row for it: Reports is marked
    await frames(page, 5) // a Report that asked to be kept would have by now
    expect(keeps).toEqual([]) // a Member's view is not a showing: nothing is asked for, and nothing is changed
    expect(await keptList(context)).toHaveLength(1)
    expect((await keptList(context))[0]!.lastMadeAt).toBe(lastMade)
    await noAxeViolations(page)
  })

  test('prints a kept Report from its row, which is how a Member saves a PDF on their own computer', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await signInAs(context, 'member')
    await stubPrint(page)
    await page.goto('/reports')
    await openActions(actionsButton(page, rowName('Budget vs actual', `${dateText(`${year}-01-01`)} to ${dateText(`${year}-03-31`)}`, 'All Accounts')))
    await menuAction(page, 'Print').click()
    await expect(page.getByRole('article', { name: 'Budget vs actual' })).toBeVisible()
    await expect.poll(() => printed(page)).toBe(1)
  })

  test('is told, on a Report\'s page with nothing in its address, that the Admin makes Reports and where to open one', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const path of ['/reports/spending', '/reports/transactions', '/reports/loans', '/reports/balances', '/reports/budget-vs-actual', '/reports/income-vs-spending']) {
      await page.goto(path)
      await expect(page.getByRole('status').filter({ hasText: 'Only the Admin makes Reports.' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'list of Reports' })).toHaveAttribute('href', '/reports')
      await expect(page.getByRole('form')).toHaveCount(0)
    }
  })

  test('is told the Admin makes Reports, not to use a form they do not have, when an address cannot show a Report: dates the wrong way round, no such Account, too many months', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const path of [
      '/reports/spending?from=2012-12-31&to=2012-01-01',
      '/reports/spending?account=999999999&from=2012-01-01&to=2012-12-31',
      '/reports/budget-vs-actual?from=2001-01-01&to=2030-12-31',
    ]) {
      await page.goto(path)
      await expect(page.getByRole('status').filter({ hasText: 'Only the Admin makes Reports.' }), path).toBeVisible()
      await expect(page.getByRole('link', { name: 'list of Reports' })).toHaveAttribute('href', '/reports')
      await expect(page.getByText(/in the form|Change one of them|Choose dates/)).toHaveCount(0)
      await expect(page.getByRole('form')).toHaveCount(0)
    }
  })

  test("is not offered the Transaction listing Report on the Transactions page, which only the Admin makes", async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/transactions?from=2026-01-01&to=2026-10-31')
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Transaction listing Report/ })).toHaveCount(0)
    await expect(page.getByText('To print Transactions as a Report')).toHaveCount(0)
    await signInAs(context, 'admin')
    await page.reload()
    await expect(page.getByRole('link', { name: /Open a Transaction listing Report/ })).toBeVisible()
  })
})

test.describe('a Member, when they ask for a Report that is not kept', () => {
  test.use({ expectedStatuses: [403] })

  test('is told a Report has not been made, and where the ones that have are: a Report with other dates is not the one that was made', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await keep(context, baseURL, { report: 'budget-vs-actual', from: `${year}-01-01`, to: `${year}-03-31` })
    await signInAs(context, 'member')
    const refused = page.waitForResponse((response) => response.url().includes('/api/reports/budget-vs-actual') && response.status() === 403)
    await page.goto(`/reports/budget-vs-actual?from=${year}-01-01&to=${year}-04-30`)
    await refused
    await expect(page.getByRole('alert')).toContainText('The Admin has not made this Report')
    await expect(page.getByRole('link', { name: 'list of Reports' })).toHaveAttribute('href', '/reports')
    await expect(page.getByRole('article')).toHaveCount(0)
    await expect(page.getByRole('form')).toHaveCount(0)
    await noAxeViolations(page)
  })

  test('is refused by the Worker, once: asking again would only be refused again', async ({ page, context }) => {
    await signInAs(context, 'member')
    let asked = 0
    await page.route('**/api/reports/spending?**', (route) => {
      asked += 1
      return route.continue()
    })
    await page.goto('/reports/spending?from=2002-01-01&to=2002-12-31')
    await expect(page.getByRole('alert')).toContainText('The Admin has not made this Report')
    expect(asked).toBe(1)
  })
})

test.describe('a Member, when the Admin takes back a Report between the list and the Report', () => {
  test.use({ expectedStatuses: [403] })

  test('opens it later without printing: a Print that was refused is not left waiting for the next time the Report is shown', async ({ page, context, baseURL, request }, testInfo) => {
    const { year, account } = dataFor(testInfo.project.name)
    const { accountId } = await seed(context, baseURL!, testInfo.project.name)
    const choices = { report: 'spending', accountId, from: `${year}-01-01`, to: `${year}-12-31` }
    await keep(context, baseURL, choices)
    await signInAs(context, 'member')
    await stubPrint(page)
    await page.goto('/reports')
    const row = actionsButton(page, rowName('Spending by Category', range(year), account.name))
    await expect(row).toBeVisible()

    // The Admin takes it off the list after this page read it, so Print opens a Report that the Worker refuses.
    await forgetKeptReports(request, baseURL)
    await openActions(row)
    await menuAction(page, 'Print').click()
    await expect(page.getByRole('alert')).toContainText('The Admin has not made this Report')
    expect(await printed(page)).toBe(0)

    // The Admin makes it again, and the Member opens it, from the same list, without printing.
    expect((await request.post('/api/kept-reports', { headers: { Origin: baseURL! }, data: choices })).ok()).toBe(true)
    await navLink(page, 'Reports').click()
    await openActions(row)
    await menuAction(page, 'Open').click()
    await expect(page.getByRole('article', { name: 'Spending by Category' })).toBeVisible()
    await frames(page, 5)
    expect(await printed(page)).toBe(0)
  })
})

test.describe('a Member, when a kept Loans Report is of a Category that has since been removed', () => {
  test.use({ expectedStatuses: [404] })

  test('is told the Admin makes Reports, and where to open one, and not to choose a Category in a form they do not have', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await signInAs(context, 'admin')
    const categoryId = await ensureCategory(context, baseURL!, `Kept loan ${testInfo.project.name} ${Date.now()}`, 'loans')
    await keep(context, baseURL, { report: 'loans', categoryId, to: `${year}-12-31` })
    expect((await context.request.delete(`/api/categories/${categoryId}`, { headers: { Origin: baseURL! }, data: {} })).ok()).toBe(true)
    await signInAs(context, 'member')

    await page.goto(`/reports/loans?category=${categoryId}&to=${year}-12-31`)

    await expect(page.getByRole('status').filter({ hasText: 'Only the Admin makes Reports.' })).toBeVisible()
    await expect(page.getByText('Choose one in the form above')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'list of Reports' })).toHaveAttribute('href', '/reports')
  })
})
