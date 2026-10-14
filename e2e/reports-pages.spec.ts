import type { Page } from '@playwright/test'
import { expectDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { mainNav, navGroup, navLink, navigateTo, siteHeader } from './shell-helpers'

// The Reports page and the six pages it links to. Each Report has a page of its own, with its form and, once the dates are chosen, the Report below it (the specs of each Report
// check that, and its figures and print layout); this is what the pages have in common: the cards that lead to them, where they say they are, and who can open them.

const REPORTS = [
  { name: 'Spending by Category', path: '/reports/spending', summary: 'What each Category spent, the most spent first, with the total.' },
  { name: 'Income vs spending by month', path: '/reports/income-vs-spending', summary: 'What came in and what was spent in each month, with the difference and the totals.' },
  { name: 'Loans', path: '/reports/loans', summary: 'How much each person owes, or is owed, on a loan, with the lending and repayments listed.' },
  { name: 'Transaction listing', path: '/reports/transactions', summary: 'Every Transaction, with its Category and Note, Account by Account, oldest first.' },
  { name: 'Balances over time', path: '/reports/balances', summary: "Each Account's balance at the end of every month, with any Balance Check differences." },
  { name: 'Budget vs actual', path: '/reports/budget-vs-actual', summary: "Each Category's Budget against what it spent, month by month." },
] as const

const trail = (page: Page) => siteHeader(page).getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem')
/** The links in the sidebar's Reports group, which is the list that follows its button. */
const reportsLinks = (page: Page) => navGroup(page, 'Reports').locator('xpath=following-sibling::ul').getByRole('link')

for (const role of ['member', 'admin'] as const) {
  test.describe(`as a ${role}`, () => {
    test('the Reports page is a card for each of the six Reports, in order, each with its name, a line about it and a link to its page', async ({ page, context }) => {
      await signInAs(context, role)
      await page.goto('/')
      await navigateTo(page, 'Reports', 'Reports')
      await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(REPORTS.map((report) => report.name))
      await expect(page.getByRole('form')).toHaveCount(0) // the forms are on the pages the cards lead to

      const cards = page.locator('[data-slot="card"]')
      await expect(cards).toHaveCount(6)
      for (const [i, report] of REPORTS.entries()) {
        const card = cards.nth(i)
        await expect(card.getByRole('heading', { level: 2, name: report.name })).toBeVisible()
        await expect(card).toContainText(report.summary)
        await expect(card.getByRole('link')).toHaveCount(1)
        await expect(card.getByRole('link', { name: `Open ${report.name}` })).toHaveAttribute('href', report.path)
      }
      await noAxeViolations(page)
    })

    test('each card opens its Report\'s page, in the same window, which says where it is: Reports, then the Report, with Reports marked in the sidebar', async ({ page, context }) => {
      await signInAs(context, role)
      for (const report of REPORTS) {
        await page.goto('/reports')
        await page.getByRole('link', { name: `Open ${report.name}` }).click()
        await expect(page.getByRole('heading', { level: 1, name: report.name, exact: true })).toBeVisible()
        expect(new URL(page.url()).pathname).toBe(report.path)
        expect(context.pages()).toHaveLength(1)
        await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible() // the form is on the page
        await expect(trail(page)).toHaveText(['Reports', report.name])
        await expect(siteHeader(page).locator('[aria-current="page"]')).toHaveText(report.name)
        await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
        await expect(navLink(page, 'Reports')).toHaveAttribute('data-active', 'true')
        await expect(mainNav(page).locator('[data-active="true"]')).toHaveCount(1)
        await expect(page.locator('main').getByRole('link', { name: 'Back to Reports' })).toHaveCount(0) // only a Report has the way back, at its foot
      }
    })

    test('a Report\'s page has no WCAG 2.2 AA violations with only its form on it', async ({ page, context }) => {
      await signInAs(context, role)
      for (const report of REPORTS) {
        await page.goto(report.path)
        await expect(page.getByRole('form', { name: report.name, exact: true })).toBeVisible()
        await noAxeViolations(page)
      }
    })
  })
}

test.describe('the sidebar', () => {
  test('lists the Reports page and Charts under Reports, and none of the six Reports', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/reports/loans')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(reportsLinks(page)).toHaveText(['Reports', 'Charts'])
    await expect(navLink(page, 'Loans')).toHaveCount(0)
  })

  test('puts a Member\'s Accounts after them, as it did', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports/balances')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(reportsLinks(page)).toHaveText(['Reports', 'Charts', 'Accounts'])
  })
})

test.describe('an address from before each Report had a page of its own', () => {
  test('still works for each Report: the page is at the same address, and its form is filled in from the choice in it', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const report of REPORTS) {
      await page.goto(`${report.path}?from=2012-01-02&to=2012-03-04`)
      await expect(page.getByRole('heading', { level: 1, name: report.name, exact: true })).toBeVisible()
      const form = page.getByRole('form', { name: report.name, exact: true })
      await expectDate(form, report.name === 'Loans' ? 'From (optional)' : 'From', '2012-01-02')
      await expectDate(form, 'To', '2012-03-04')
    }
  })
})
