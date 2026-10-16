import type { Page } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { helpButton as trigger, helpSheet as sheet } from './help-helpers'
import { forgetKeptReportsAfterEach } from './report-helpers'
import { chooseTextSize } from './shell-helpers'

// The page's "?" help sheet (src/components/help-sheet.tsx, CODING_STANDARDS.md#ui): the text a reader reads once is in a sheet that opens from the right, beside the page's heading, so a
// table or a form is not pushed down by it. The component is tested once, on the Transactions page; every page that uses it is then listed with a phrase of what it says, to check that the "?" is
// there, that the sheet has the phrase and that the page has not kept it. The Reports' print button, which sits with "Show Report", is in reports.spec.ts.

forgetKeptReportsAfterEach() // the Report pages below are opened as the Admin, which keeps what they show

/** The heading and the "?" are one row: the button is level with the heading and after it. */
async function expectBesideHeading(page: Page) {
  const heading = await page.getByRole('heading', { level: 1 }).boundingBox()
  const button = await trigger(page).boundingBox()
  expect(heading, 'the heading is drawn').not.toBeNull()
  expect(button, 'the "?" is drawn').not.toBeNull()
  expect(button!.x, 'after the heading, not under it').toBeGreaterThanOrEqual(heading!.x + heading!.width - 1)
  const middle = button!.y + button!.height / 2
  expect(middle, 'level with the heading').toBeGreaterThan(heading!.y)
  expect(middle).toBeLessThan(heading!.y + heading!.height)
}

test.describe('the sheet', () => {
  test.beforeEach(async ({ context }) => {
    await signInAs(context, 'admin')
  })

  test('opens from the "?" beside the heading, from the right, with its text and a Close button at the bottom; Esc and Close give focus back to the "?"', async ({ page }) => {
    await page.goto('/transactions')
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    await expectBesideHeading(page)
    await expect(sheet(page)).toHaveCount(0)

    await trigger(page).click()
    await expect(sheet(page)).toBeVisible()
    await expect(sheet(page).getByText('Search and filter every Transaction')).toBeVisible()
    await settle(page) // the slide has ended
    const viewport = page.viewportSize()!
    const box = (await sheet(page).boundingBox())!
    expect(viewport.width - (box.x + box.width), "the sheet's right edge is the window's, or the page's scrollbar's if it has one").toBeLessThanOrEqual(20)
    expect(viewport.width - (box.x + box.width)).toBeGreaterThanOrEqual(0)
    expect(box.x, 'and it leaves the page showing on the left').toBeGreaterThan(0)

    // Close is the last thing in the sheet, under the text, at its foot.
    const close = sheet(page).getByRole('button', { name: 'Close' })
    const closeBox = (await close.boundingBox())!
    const textBox = (await sheet(page).getByText('Search and filter every Transaction').boundingBox())!
    expect(closeBox.y).toBeGreaterThan(textBox.y + textBox.height)
    expect(box.y + box.height - (closeBox.y + closeBox.height), "close to the sheet's bottom edge").toBeLessThan(40)
    await expect(sheet(page).locator('button, a[href], [tabindex="0"]').last()).toHaveText('Close')

    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    await expect(trigger(page)).toBeFocused()

    await trigger(page).click()
    await sheet(page).getByRole('button', { name: 'Close' }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(trigger(page)).toBeFocused()
  })

  test('opens from the keyboard and holds focus while it is open', async ({ page }) => {
    await page.goto('/transactions')
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await expect(sheet(page)).toBeVisible()
    for (let presses = 0; presses < 6; presses++) await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), 'Tab stays in the sheet').toBe(true)
    await page.keyboard.press('Escape')
    await expect(trigger(page)).toBeFocused()
  })

  test('has no accessibility violations open', async ({ page }) => {
    await page.goto('/transactions')
    await trigger(page).click()
    await expect(sheet(page)).toBeVisible()
    await noAxeViolations(page, { within: '[role="dialog"]' }) // behind a modal, the rest of the page is hidden from a screen reader
  })

  test('fits a phone at the largest text size: beside the heading, inside the window, with Close in view and the long text scrolling in the sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 })
    await page.goto('/reports/loans') // the longest help: what it holds, what its form asks, and printing
    await chooseTextSize(page, 'Xtra Large')
    await expect(page.getByRole('heading', { level: 1, name: 'Loans' })).toBeVisible()
    await expectBesideHeading(page)

    await trigger(page).click()
    await expect(sheet(page)).toBeVisible()
    await settle(page)
    const box = (await sheet(page).boundingBox())!
    expect(box.x, 'inside the window').toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 1)
    expect(box.x, 'a strip of the page is left to tap on to close it').toBeGreaterThanOrEqual(20)
    const closeBox = (await sheet(page).getByRole('button', { name: 'Close' }).boundingBox())!
    expect(closeBox.y + closeBox.height, 'Close is in the window without scrolling').toBeLessThanOrEqual(600)
    expect(closeBox.height, 'a touch target').toBeGreaterThanOrEqual(44)
    // The text is longer than the room it has, so it scrolls inside the sheet and the Close button stays where it is.
    const scrolls = await sheet(page).locator('[tabindex="0"]').evaluate((el) => el.scrollHeight > el.clientHeight)
    expect(scrolls, 'the text scrolls inside the sheet').toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling').toBe(true)
    await noAxeViolations(page, { within: '[role="dialog"]' })
  })

  test('is drawn with a border, and the "?" with an edge and a focus outline, in Windows high contrast, where a shadow and a fill are dropped', { tag: '@theme' }, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/transactions')
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    const edge = await trigger(page).evaluate((el) => getComputedStyle(el).borderTopWidth)
    expect(parseFloat(edge), 'the "?" has an edge').toBeGreaterThanOrEqual(1)
    await trigger(page).focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab') // keyboard focus, so :focus-visible
    await expect(trigger(page)).toBeFocused()
    const outline = await trigger(page).evaluate((el) => getComputedStyle(el).outlineStyle)
    expect(outline, 'focus is an outline').not.toBe('none')
    await trigger(page).click()
    await expect(sheet(page)).toBeVisible()
    const side = await sheet(page).evaluate((el) => getComputedStyle(el).borderInlineStartWidth)
    expect(parseFloat(side), "the sheet's edge is a border, not a shadow").toBeGreaterThanOrEqual(1)
  })
})

// Every page that has text to read once: `says` is a phrase of it. `roles` is who looks, the Admin alone unless the page is the same for a Member.
type Case = { path: string; heading: string; says: string; roles?: Role[] }
const BOTH: Role[] = ['admin', 'member']
const PAGES: Case[] = [
  { path: '/transactions', heading: 'Transactions', says: 'Search and filter every Transaction', roles: BOTH },
  { path: '/uncategorised', heading: 'Uncategorised', says: 'Transactions with no Category' },
  { path: '/import', heading: 'Import', says: 'Choose a bank export' },
  { path: '/categories', heading: 'Categories', says: 'A Category groups Transactions by purpose', roles: BOTH },
  { path: '/rules', heading: 'Rules', says: 'Rules are checked from the top of the list' },
  { path: '/rules', heading: 'Rules', says: 'Fernledger goes through every Transaction you have' }, // the Apply box's words
  { path: '/budgets', heading: 'Budgets', says: 'A Budget is the amount you plan to spend', roles: BOTH },
  { path: '/settings', heading: 'Settings', says: 'A Cutover Date is the day an Account stops taking Transactions' },
  { path: '/about-your-data', heading: 'About your data', says: 'This page explains how Fernledger handles', roles: BOTH },
  { path: '/change-log', heading: 'Change Log', says: 'Everything the Admin has changed', roles: BOTH },
  { path: '/reports', heading: 'Reports', says: 'Each Report you show is kept here' },
  { path: '/reports', heading: 'Reports', says: 'The Reports the Admin has made', roles: ['member'] },
  { path: '/', heading: 'Dashboard', says: 'Balance as of the last Transaction we hold' },
  { path: '/', heading: 'Summary', says: 'Each month stands alone', roles: ['member'] },
  { path: '/reports/net-worth', heading: 'Net worth', says: 'Only the money in these Accounts', roles: BOTH },
  { path: '/reports/spending', heading: 'Spending by Category', says: 'What each Category spent in the dates you choose', roles: BOTH },
  { path: '/reports/spending', heading: 'Spending by Category', says: 'A Report has one row for each Category with spending' }, // the form's note, which only the Admin has the form for
  { path: '/reports/income-vs-spending', heading: 'Income vs spending by month', says: 'What came in and what was spent in each month', roles: BOTH },
  { path: '/reports/loans', heading: 'Loans', says: 'How much each person owes, or is owed', roles: BOTH },
  { path: '/reports/transactions', heading: 'Transaction listing', says: 'Every Transaction in the dates you choose', roles: BOTH },
  { path: '/reports/balances', heading: 'Balances over time', says: "Each Account's balance at the end of every month", roles: BOTH },
  { path: '/reports/budget-vs-actual', heading: 'Budget vs actual', says: "Each Category's Budget against what it spent", roles: BOTH },
  { path: '/reports/budget-vs-actual', heading: 'Budget vs actual', says: 'In the print window, choose', roles: BOTH }, // how to print, in every Report's sheet
]

test.describe('every page with text to read once has the "?"', () => {
  for (const { path, heading, says, roles = ['admin'] as Role[] } of PAGES) {
    for (const role of roles) {
      test(`${path} as the ${role}: the sheet says "${says.slice(0, 40)}" and the page does not`, async ({ page, context }) => {
        await signInAs(context, role)
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
        await expect(trigger(page)).toBeVisible()
        await expectBesideHeading(page)
        await expect(page.getByText(says)).toBeHidden() // nothing on the page itself, in whichever state it is
        await trigger(page).click()
        await expect(sheet(page).getByText(says)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(trigger(page)).toBeFocused()
      })
    }
  }
})

test('a page with no text to read once has no "?"', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/accounts')
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
  await expect(trigger(page)).toHaveCount(0)
})
