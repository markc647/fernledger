import type { Locator, Page } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'
import { stubBalances } from './balances-helpers'
import { NET_WORTH_PATH, showNetWorth, stubNetWorth } from './chart-helpers'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { HELP_LABEL, helpButton as trigger, helpSheet as sheet } from './help-helpers'
import { chooseTextSize } from './shell-helpers'

// The page's "?" help sheet (src/components/help-sheet.tsx, CODING_STANDARDS.md#ui): the text a reader reads once is in a sheet that opens from the right, beside the page's heading, so a
// table or a form is not pushed down by it. The component is tested once, on the Transactions page (its colours are scanned open in contrast.spec.ts); every page that uses it is then listed
// with phrases of what it says, to check that the "?" is there, that the sheet has the phrases and that the page has not kept them. The Reports' print button, which sits with "Show Report",
// is in reports.spec.ts.

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
    const button = (await trigger(page).boundingBox())!
    expect(button.width, 'a touch target, as every button is').toBeGreaterThanOrEqual(44)
    expect(button.height).toBeGreaterThanOrEqual(44)
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

    // The text is a region the dialog's title names, and Close is the last thing in the sheet, under the text, at its foot.
    await expect(sheet(page).getByRole('region', { name: HELP_LABEL })).toBeVisible()
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
    await noAxeViolations(page, { within: '[role="dialog"]' }) // behind a modal, the rest of the page is hidden from a screen reader
  })

  test('draws the "?" with an outline when it has focus in Windows high contrast, and the sheet with a border, where a shadow and a fill are dropped', { tag: '@theme' }, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/transactions')
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    await trigger(page).focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab') // keyboard focus, so :focus-visible
    await expect(trigger(page)).toBeFocused()
    await settle(page) // the outline grows from nothing to 2px in the button's transition
    // The browser's own focus ring is `auto`, so only the page's outline is a solid one of 2px or more.
    const outline = await trigger(page).evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }))
    expect(outline.style, 'focus is the page\'s outline').toBe('solid')
    expect(outline.width).toBeGreaterThanOrEqual(2)
    await trigger(page).click()
    await expect(sheet(page)).toBeVisible()
    const side = await sheet(page).evaluate((el) => getComputedStyle(el).borderInlineStartWidth)
    expect(parseFloat(side), "the sheet's edge is a border, not a shadow").toBeGreaterThanOrEqual(1)
  })

  test('About your data has its first sentence on the page, on the screen and on paper, once, and no "?"', async ({ page }) => {
    const sentence = page.getByText('This page explains how Fernledger handles the financial information in it') // one match: a second, for paper only, would make this fail
    await page.goto('/about-your-data')
    await expect(page.getByRole('heading', { level: 1, name: 'About your data' })).toBeVisible()
    await expect(sentence).toBeVisible()
    await expect(trigger(page)).toHaveCount(0)
    await page.emulateMedia({ media: 'print' })
    await expect(sentence).toBeVisible()
  })
})

// Every page that has text to read once. `says` is what the sheet has for everyone who has the page, `adminSays` and `memberSays` what it has for one of them (a Member has no form, and the
// Reports page says one thing to each). `roles` is who looks: the Admin alone unless the page is the same for a Member. `ready` waits for what used to be drawn with the text, which comes
// after the heading when it needs data (a card's table, a form of the Settings, a drawn chart), so that "the page does not say it" is not true only because the page was not yet drawn.
type Case = {
  path: string
  heading: string | Record<Role, string>
  says: string[]
  adminSays?: string[]
  memberSays?: string[]
  roles?: Role[]
  setup?: (page: Page) => Promise<void>
  ready?: (page: Page, role: Role) => Promise<void>
}
const BOTH: Role[] = ['admin', 'member']
const PRINTING = 'In the print window, choose' // every Report's sheet says how to print
const form = (name: string) => async (page: Page, role: Role) => {
  if (role === 'admin') await expect(page.getByRole('form', { name })).toBeVisible()
  else await expect(page.getByRole('status').filter({ hasText: 'Only the Admin makes Reports.' })).toBeVisible()
}
const card = (page: Page, name: string): Locator => page.getByRole('region', { name })

const PAGES: Case[] = [
  { path: '/transactions', heading: 'Transactions', says: ['Search and filter every Transaction'], adminSays: ['To print Transactions as a Report'], roles: BOTH, ready: (page) => expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible() },
  { path: '/uncategorised', heading: 'Uncategorised', says: ['Transactions with no Category'] },
  { path: '/import', heading: 'Import', says: ['Choose a bank export'], ready: (page) => expect(page.getByLabel('Bank export file')).toBeVisible() },
  { path: '/categories', heading: 'Categories', says: ['A Category groups Transactions by purpose'], adminSays: ["Add, rename or remove them to suit you"], memberSays: ['Only the Admin can change them.'], roles: BOTH },
  {
    path: '/rules',
    heading: 'Rules',
    says: ['Rules are checked from the top of the list', 'The Transactions you already have change only when you choose', 'Fernledger goes through every Transaction you have', 'Change the Rules first, then apply them once.'],
    ready: (page) => expect(page.getByRole('button', { name: 'Apply the Rules to all Transactions' })).toBeVisible(),
  },
  { path: '/budgets', heading: 'Budgets', says: ['A Budget is the amount you plan to spend'], adminSays: ['Choose Edit on a Category'], memberSays: ['Only the Admin can change them.'], roles: BOTH },
  { path: '/settings', heading: 'Settings', says: ["The Admin is set when Fernledger is deployed", 'A Cutover Date is the day an Account stops taking Transactions'], ready: (page) => expect(page.getByLabel('App title')).toBeVisible() },
  { path: '/change-log', heading: 'Change Log', says: ['Everything the Admin has changed'], roles: BOTH },
  {
    path: '/reports',
    heading: 'Reports',
    says: [],
    adminSays: [
      'Each Report you create is saved here for quick access at a later date.',
      'Select Open from the Actions menu to view or print.',
      'To have a Report show here, choose one of the Report types in the sidebar and it will be saved here.',
    ],
    memberSays: ['The Reports the Admin has made'],
    roles: BOTH,
  },
  {
    // The cards' answers are stubbed, with a Budget, so that both have their tables when the cards' notes are looked for: the Budget card's note was shown only with a row to show.
    path: '/',
    heading: { admin: 'Dashboard', member: 'Summary' },
    says: ['Balance as of the last Transaction we hold', 'Each month stands alone'],
    roles: BOTH,
    setup: async (page) => {
      await stubBalances(page)
      await page.route('**/api/budgets/vs-actual', (route) =>
        route.fulfill({ json: { month: '2026-10', rows: [{ categoryId: 1, categoryName: 'Example Category', budgetCents: 10_000, spentCents: 5_000 }], otherCents: 0, uncategorisedCents: 0 } }),
      )
    },
    ready: async (page) => {
      await expect(card(page, 'Balances')).toContainText('Example everyday')
      await expect(card(page, 'Budget vs actual')).toContainText('Example Category')
    },
  },
  {
    path: NET_WORTH_PATH,
    heading: 'Net worth',
    says: ['Only the money in these Accounts', 'After its last Transaction an Account keeps its last balance'],
    roles: BOTH,
    setup: async (page) => void (await stubNetWorth(page)),
    ready: async (page) => void (await showNetWorth(page)), // drawn: what the sheet says used to be above the line
  },
  { path: '/reports/spending', heading: 'Spending by Category', says: ['What each Category spent in the dates you choose', PRINTING], adminSays: ['A Report has one row for each Category with spending'], roles: BOTH, ready: form('Spending by Category') },
  { path: '/reports/income-vs-spending', heading: 'Income vs spending by month', says: ['What came in and what was spent in each month', PRINTING], adminSays: ['A Report has one row for each month in your dates'], roles: BOTH, ready: form('Income vs spending by month') },
  { path: '/reports/loans', heading: 'Loans', says: ['How much each person owes, or is owed', PRINTING], adminSays: ['A Report has a section for each Loans Category you choose'], roles: BOTH, ready: form('Loans') },
  { path: '/reports/transactions', heading: 'Transaction listing', says: ['Every Transaction in the dates you choose', PRINTING], adminSays: ['A Report lists up to'], roles: BOTH, ready: form('Transaction listing') },
  { path: '/reports/balances', heading: 'Balances over time', says: ["Each Account's balance at the end of every month", PRINTING], adminSays: ['A Report has one balance for the end of each month'], roles: BOTH, ready: form('Balances over time') },
  { path: '/reports/budget-vs-actual', heading: 'Budget vs actual', says: ["Each Category's Budget against what it spent", PRINTING], adminSays: ['A Budget is for a whole month, so a Report shows every month'], roles: BOTH, ready: form('Budget vs actual') },
]

test.describe('every page with text to read once has the "?"', () => {
  for (const { path, heading, says, adminSays = [], memberSays = [], roles = ['admin'] as Role[], setup, ready } of PAGES) {
    for (const role of roles) {
      const phrases = [...says, ...(role === 'admin' ? adminSays : memberSays)]
      test(`${path} as the ${role}: the sheet says ${phrases.length} thing${phrases.length === 1 ? '' : 's'} and the page does not`, async ({ page, context }) => {
        await signInAs(context, role)
        await setup?.(page)
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: typeof heading === 'string' ? heading : heading[role], exact: true })).toBeVisible()
        await expect(trigger(page)).toBeVisible()
        await expectBesideHeading(page)
        await ready?.(page, role) // drawn as it was when the page said these things
        // The sheet first: what is only for the Admin, or for a Member, is there once the page knows who is signed in (which `ready` does not always wait for), and by then the page would have
        // said it if it were going to. Only then is "the page does not say it" a thing that could have been false.
        await trigger(page).click()
        for (const phrase of phrases) await expect(sheet(page).getByText(phrase), phrase).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(trigger(page)).toBeFocused()
        for (const phrase of phrases) await expect(page.getByText(phrase), phrase).toBeHidden()
      })
    }
  }
})

for (const [path, heading] of [
  ['/accounts', 'Accounts'],
  ['/how-to-sign-in', 'How to sign in'],
] as const) {
  test(`${heading} has no text to read once, so no "?"`, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(trigger(page)).toHaveCount(0)
  })
}

// The Export page's explanation of what Download CSV saves and what a saved file leaves unprotected is needed each time a file is saved, so it is on the page, and the page has no sheet.
test('Export keeps its explanation on the page, so has no "?"', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/export')
  await expect(page.getByRole('heading', { level: 1, name: 'Export' })).toBeVisible()
  await expect(page.getByText('Download CSV saves the Transactions that match the filters you last searched with')).toBeVisible()
  await expect(trigger(page)).toHaveCount(0)
})
