import type { Page } from '@playwright/test'
import { expectDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { breadcrumb, mainNav, navGroup, navLink, navigateTo } from './shell-helpers'

// The Reports page and the six pages it links to. Each Report has a page of its own, with its form and, once the dates are chosen, the Report below it (the specs of each Report
// check that, and its figures and print layout); this is what the pages have in common: the cards that lead to them, where they say they are, and what they read when nothing is chosen.

const EXPECTED = [
  { name: 'Spending by Category', path: '/reports/spending', summary: 'What each Category spent, the most spent first, with the total.' },
  { name: 'Income vs spending by month', path: '/reports/income-vs-spending', summary: 'What came in and what was spent in each month, with the difference and the totals.' },
  { name: 'Loans', path: '/reports/loans', summary: 'How much each person owes, or is owed, on a loan, with the lending and repayments listed.' },
  { name: 'Transaction listing', path: '/reports/transactions', summary: 'Every Transaction, with its Category and Note, Account by Account, oldest first.' },
  { name: 'Balances over time', path: '/reports/balances', summary: "Each Account's balance at the end of every month, with any Balance Check differences." },
  { name: 'Budget vs actual', path: '/reports/budget-vs-actual', summary: "Each Category's Budget against what it spent, month by month." },
] as const

/** The links in the sidebar's Reports group, which is the list that follows its button. */
const reportsLinks = (page: Page) => navGroup(page, 'Reports').locator('xpath=following-sibling::ul').getByRole('link')

// Every Member and the Admin are shown the same six Reports, so one of them is enough for what the pages have in common; the sidebar differs by role, and is checked as each.
test.describe('the pages', () => {
  test.beforeEach(async ({ context }) => {
    await signInAs(context, 'member')
  })

  test('the Reports page is a card for each of the six Reports, in order, each with its name, a line about it and a link to its page', async ({ page }) => {
    await page.goto('/')
    await navigateTo(page, 'Reports', 'Reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(EXPECTED.map((report) => report.name))
    await expect(page.getByRole('form')).toHaveCount(0) // the forms are on the pages the cards lead to

    const cards = page.locator('[data-slot="card"]')
    await expect(cards).toHaveCount(6)
    for (const [i, report] of EXPECTED.entries()) {
      const card = cards.nth(i)
      await expect(card.getByRole('heading', { level: 2, name: report.name })).toBeVisible()
      await expect(card).toContainText(report.summary)
      await expect(card.getByRole('link')).toHaveCount(1)
      await expect(card.getByRole('link', { name: `Open ${report.name}` })).toHaveAttribute('href', report.path)
    }
    await noAxeViolations(page)
  })

  test('each card opens its Report\'s page, in the same window, which says where it is: Reports, then the Report, with Reports marked in the sidebar', async ({ page, context }) => {
    for (const report of EXPECTED) {
      await page.goto('/reports')
      await page.getByRole('link', { name: `Open ${report.name}` }).click()
      await expect(page.getByRole('heading', { level: 1, name: report.name, exact: true })).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(report.path)
      expect(context.pages()).toHaveLength(1)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible() // the form is on the page
      await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Reports', report.name])
      await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(report.name)
      await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
      await expect(navLink(page, 'Reports')).toHaveAttribute('data-active', 'true')
      await expect(mainNav(page).locator('[data-active="true"]')).toHaveCount(1)
      await expect(page.locator('main').getByRole('link', { name: 'Back to Reports' })).toHaveCount(0) // only a Report has the way back, at its foot
    }
  })

  test('on a Report\'s page the Reports in the breadcrumb is a link to the Reports page, which on a phone is the way back', async ({ page }) => {
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

  test('each Report\'s page has no WCAG 2.2 AA violations with only its form on it', async ({ page }) => {
    for (const report of EXPECTED) {
      await page.goto(report.path)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
      await noAxeViolations(page)
    }
  })

  test('asks the Worker for no Report until one is chosen: the Reports page, and a Report\'s page with nothing in its address', async ({ page }) => {
    const asked: string[] = []
    await page.route('**/api/reports/**', (route) => {
      asked.push(new URL(route.request().url()).pathname)
      return route.continue()
    })
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 2, name: 'Loans' })).toBeVisible()
    for (const report of EXPECTED) {
      await page.goto(report.path)
      await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
    }
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])
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

test.describe('the sidebar', () => {
  test('lists only the Reports page under Reports for the Admin, and none of the six Reports', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/loans')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(reportsLinks(page)).toHaveText(['Reports'])
    await expect(navLink(page, 'Loans')).toHaveCount(0)
  })

  test('puts a Member\'s Accounts after them, as it did', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports/balances')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(reportsLinks(page)).toHaveText(['Reports', 'Accounts'])
  })
})
