import type { Page } from '@playwright/test'
import { expectDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { forgetKeptReportsAfterEach } from './report-helpers'
import { breadcrumb, mainNav, navGroup, navLink } from './shell-helpers'

// The six Report pages. Each has a page of its own, with its form (the Account and dates) and, once they are chosen, the Report below it (the specs of each Report check that, and its
// figures and print layout). Only the Admin makes Reports, so the Admin has the form, and the six are in the Admin's sidebar under Reports, a row each; a Member has no form and no
// row, and opens a Report the Admin has made from the Reports page (kept-reports.spec.ts, which also checks that page). This is what the pages have in common: where they say they are,
// and what they read when nothing is chosen.

const EXPECTED = [
  { name: 'Spending by Category', path: '/reports/spending' },
  { name: 'Income vs spending by month', path: '/reports/income-vs-spending' },
  { name: 'Loans', path: '/reports/loans' },
  { name: 'Transaction listing', path: '/reports/transactions' },
  { name: 'Balances over time', path: '/reports/balances' },
  { name: 'Budget vs actual', path: '/reports/budget-vs-actual' },
] as const

/** The links in the sidebar's Reports group, which is the list that follows its button. */
const reportsLinks = (page: Page) => navGroup(page, 'Reports').locator('xpath=following-sibling::ul').getByRole('link')

forgetKeptReportsAfterEach() // a page that shows a Report as the Admin keeps it

test.describe('the pages, as the Admin', () => {
  test.beforeEach(async ({ context }) => {
    await signInAs(context, 'admin')
  })

  test('are in the sidebar under Reports, after the Reports page and Net worth, a row each in the order the Reports are kept, and each is a link to its page', async ({ page }) => {
    await page.goto('/reports')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(reportsLinks(page)).toHaveText(['Reports', 'Net worth', ...EXPECTED.map((report) => report.name)])
    for (const report of EXPECTED) await expect(navLink(page, report.name)).toHaveAttribute('href', report.path)
  })

  test("each opens from the sidebar, in the same window, and says where it is: Reports, then the Report, with the Report's own row marked", async ({ page, context }) => {
    await page.goto('/reports')
    for (const report of EXPECTED) {
      await navLink(page, report.name).click()
      await expect(page.getByRole('heading', { level: 1, name: report.name, exact: true })).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(report.path)
      expect(context.pages()).toHaveLength(1)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible() // the form is on the page
      await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Reports', report.name])
      await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(report.name)
      await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
      await expect(navLink(page, report.name)).toHaveAttribute('data-active', 'true')
      await expect(navLink(page, 'Reports')).not.toHaveAttribute('data-active', 'true')
      await expect(mainNav(page).locator('[data-active="true"]')).toHaveCount(1)
      await expect(page.locator('main').getByRole('link', { name: 'Back to Reports' })).toHaveCount(0) // only a Report has the way back, at its foot
    }
  })

  test("on a Report's page the Reports in the breadcrumb is a link to the Reports page, which on a phone is the way back", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const report of EXPECTED) {
      await page.goto(report.path)
      const link = breadcrumb(page).getByRole('link', { name: 'Reports', exact: true })
      await expect(link).toBeVisible() // at this width too, where the rest of the trail is only the page
      await expect(link).toHaveAttribute('href', '/reports')
    }
    await breadcrumb(page).getByRole('link', { name: 'Reports', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(breadcrumb(page).getByRole('link')).toHaveCount(0) // the Reports page is where it points: its trail is words
  })

  test("each Report's page has no WCAG 2.2 AA violations with only its form on it", async ({ page }) => {
    for (const report of EXPECTED) {
      await page.goto(report.path)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
      await noAxeViolations(page)
    }
  })

  test("asks the Worker for no Report until one is chosen: the Reports page, and a Report's page with nothing in its address", async ({ page }) => {
    const asked: string[] = []
    await page.route('**/api/reports/**', (route) => {
      asked.push(new URL(route.request().url()).pathname)
      return route.continue()
    })
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    for (const report of EXPECTED) {
      await page.goto(report.path)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
    }
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])
  })

  test('says there are no Accounts yet, as a status, when there are none, and keeps the form on the page', async ({ page }) => {
    await page.route('**/api/accounts', (route) => route.fulfill({ json: [] }))
    for (const report of EXPECTED) {
      await page.goto(`${report.path}?from=2090-01-02&to=2090-03-04`)
      await expect(page.getByRole('status').filter({ hasText: /^There are no Accounts yet/ })).toBeVisible()
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
      await expect(page.getByRole('article')).toHaveCount(0)
    }
  })

  // The router takes out of the address what a page leaves out as not valid, so an address of nothing but dates that are not dates is the page for choosing, address and all.
  test('an address that chooses only dates that are not dates is the page for choosing: its address loses them and nothing is said to be missing', async ({ page }) => {
    for (const report of EXPECTED) {
      await page.goto(`${report.path}?from=x&to=y`)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`${report.path}$`))
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(page.getByRole('status').filter({ hasText: /^Choose the / })).toHaveCount(0)
    }
  })

  // The dates are in a year that no Transaction is in, so this reads no figures; it is only that the form is filled in from them.
  test('the address of each Report from before it had a page of its own still opens it, and its form is filled in from the dates in it', async ({ page }) => {
    for (const report of EXPECTED) {
      await page.goto(`${report.path}?from=2090-01-02&to=2090-03-04`)
      await expect(page.getByRole('heading', { level: 1, name: report.name, exact: true })).toBeVisible()
      const form = page.getByRole('form', { name: report.name, exact: true })
      await expectDate(form, report.name === 'Loans' ? 'From (optional)' : 'From', '2090-01-02')
      await expectDate(form, 'To', '2090-03-04')
    }
  })
})

test.describe('the pages, as a Member', () => {
  test.beforeEach(async ({ context }) => {
    await signInAs(context, 'member')
  })

  test("are not in a Member's sidebar, who makes none: Reports is, and a Report is a page of it, with Reports marked and the breadcrumb a way back to it", async ({ page }) => {
    await page.goto('/reports/balances')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(reportsLinks(page)).toHaveText(['Reports', 'Net worth', 'Accounts']) // Accounts after them, as it was, with Net worth between
    for (const report of EXPECTED) {
      await page.goto(report.path)
      await expect(page.getByRole('heading', { level: 1, name: report.name, exact: true })).toBeVisible()
      await expect(navLink(page, report.name)).toHaveCount(0)
      await expect(navLink(page, 'Reports')).toHaveAttribute('data-active', 'true')
      await expect(mainNav(page).locator('[data-active="true"]')).toHaveCount(1)
      await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Reports', report.name])
      await expect(breadcrumb(page).getByRole('link', { name: 'Reports', exact: true })).toHaveAttribute('href', '/reports')
    }
  })

  test('have no form and ask the Worker for nothing when nothing is chosen: they say the Admin makes Reports and point to the list', async ({ page }) => {
    const asked: string[] = []
    await page.route('**/api/reports/**', (route) => {
      asked.push(new URL(route.request().url()).pathname)
      return route.continue()
    })
    for (const report of EXPECTED) {
      await page.goto(report.path)
      await expect(page.getByRole('status').filter({ hasText: 'Only the Admin makes Reports.' })).toBeVisible()
      await expect(page.getByRole('form')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Show Report' })).toHaveCount(0)
      await noAxeViolations(page)
    }
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])
  })
})

// Net worth is a page of its own in the Reports group, not one of the Reports: it has a row for the Admin and a Member alike.
test.describe('Net worth', () => {
  test('is a page of its own and not a Report: it has no title block and no way back at its foot, and its breadcrumb is a group and a page, not a link back', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports/net-worth')
    await expect(page.getByRole('heading', { level: 1, name: 'Net worth' })).toBeVisible()
    await expect(page.getByRole('article')).toHaveCount(0) // a Report is an article, with its title block; this is a chart
    await expect(page.locator('main').getByRole('link', { name: 'Back to Reports' })).toHaveCount(0)
    await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Reports', 'Net worth'])
    await expect(breadcrumb(page).getByRole('link')).toHaveCount(0)
  })
})
