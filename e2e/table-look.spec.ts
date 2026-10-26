import type { BrowserContext, Locator, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { importRows } from './report-helpers'
import { actionsButton, chooseAction, menuAction, openActions, rowButton } from './row-actions-helpers'
import { expectTableLook } from './table-look-helpers'

// The one look every table has (ResponsiveTable, src/components/responsive-table.tsx): tested once here, on the Transactions table (in its own box) and the Recent transactions table of the Dashboard (in a card, which is the
// box), and on the cards a phone gets in place of the first. Each page's own spec then checks that its table has the look (`expectTableLook`), and the Report specs that its printout does not (`expectPaperTable`).
// The row's "⋯" menu is tested here for the keyboard and for where focus goes, on the Categories table, and a panel that opens under a row (an expanded row) on the Accounts table; what each page's actions do is in that page's spec.

// The light and dark projects share one local database, so each has an Account of its own.
const accountFor = (project: string) => ({ number: project === 'dark' ? '99-9999-9999999-37' : '99-9999-9999999-36', name: `Table look ${project}` })
const payee = (project: string, word: string) => `EXAMPLE LOOK ${project} ${word}`

async function seed(context: BrowserContext, baseURL: string, project: string) {
  await signInAs(context, 'admin')
  const account = accountFor(project)
  await importRows(context, baseURL, {
    account,
    year: 2026,
    rows: [
      { date: '2026-10-01', payee: payee(project, 'ONE'), amountCents: -1234, uniqueId: `LOOK${project}1` },
      { date: '2026-10-02', payee: payee(project, 'TWO'), amountCents: 5000, uniqueId: `LOOK${project}2` },
    ],
  })
  return account
}

test('a table is a rounded box with a shaded heading row, a divider under each row and the page\'s text size, and in a card it has no second border', { tag: '@theme' }, async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  await page.goto(`/transactions?q=${encodeURIComponent(`EXAMPLE LOOK ${testInfo.project.name}`)}`)
  const table = page.getByRole('table', { name: 'Transactions matching the search' })
  await expect(table.getByRole('row')).toHaveCount(3) // the heading and the two Transactions
  await expectTableLook(table)

  await page.goto('/')
  await expectTableLook(page.getByRole('region', { name: 'Recent transactions' }).getByRole('table'), { inCard: true })
})

/** What a box and what is written in it look like: its border, its corners and its text, which the table's box and a card must share. */
const boxOf = (box: Locator, text: string) =>
  box.evaluate(
    (element, selector) => {
      const style = getComputedStyle(element)
      return { border: style.borderTopWidth, colour: style.borderTopColor, radius: style.borderTopLeftRadius, text: getComputedStyle(element.querySelector(selector)!).fontSize }
    },
    text,
  )

test('on a phone the rows are cards with the border, corners and text size the table\'s box has', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/accounts')
  await expect(page.getByRole('table', { name: 'Accounts' }).getByRole('cell', { name, exact: true })).toBeVisible()
  const box = await boxOf(page.locator('[data-slot="table-frame"]'), 'td')

  await page.setViewportSize({ width: 390, height: 844 })
  const card = page.getByRole('list', { name: 'Accounts' }).getByRole('listitem').filter({ hasText: name })
  await expect(card).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  expect(parseFloat(box.border)).toBeGreaterThan(0)
  expect(await boxOf(card, 'dd')).toEqual(box)
  await expect(actionsButton(page, name)).toBeVisible() // the same button, on the card
})

test('a panel that opens under a row is a full-width row of the table, in its look, and on a phone a card after the row\'s card', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/accounts')
  const table = page.getByRole('table', { name: 'Accounts' })
  await expect(table.getByRole('cell', { name, exact: true })).toBeVisible()
  const columns = await table.getByRole('columnheader').count()

  await chooseAction(actionsButton(page, name), 'Rename')
  // This page has a second name field of its own, for adding a credit card Account, so the panel's own one is read through it.
  const panel = page.getByRole('region', { name: `Rename ${name}` })
  await expect(panel).toBeVisible()
  await expect(panel.locator('xpath=ancestor::td[1]')).toHaveAttribute('colspan', String(columns)) // across every column
  await expectTableLook(table) // the open panel is a row of the table: the same box, text size and dividers
  await panel.getByLabel('Account name').fill(`${name} typed`)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(panel.locator('xpath=ancestor::li[1]/preceding-sibling::li[1]').getByRole('button', { name: `Actions for ${name}`, exact: true })).toBeVisible()
  await expect(panel.getByLabel('Account name')).toHaveValue(`${name} typed`) // the cards start the form again, with what was typed in it
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(panel.getByLabel('Account name')).toHaveValue(`${name} typed`)
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await chooseAction(actionsButton(page, name), 'Rename')
  await expect(panel.getByLabel('Account name')).toHaveValue(name) // Cancel throws it away
})

// A panel that opens from a row of the Accounts or the Budgets (stubbed, with enough rows for the page to scroll) leaves the page where it was, and puts focus in its first field.
for (const { path, table, button, open, field, stub } of [
  {
    path: '/accounts',
    table: 'Accounts',
    button: (page: Page, n: number) => actionsButton(page, `Stub account ${n}`),
    open: (button: Locator) => chooseAction(button, 'Rename'), // Rename is in the row's Actions menu, with Move up and Move down (#45)
    field: 'Account name',
    stub: (page: Page) =>
      page.route('**/api/accounts', (route) => route.fulfill({ json: Array.from({ length: 16 }, (_, i) => ({ id: i + 1, name: `Stub account ${i + 1}`, accountNumber: '99-9999-9999999-97', cutoverDate: null })) })),
  },
  {
    path: '/budgets',
    table: 'Budgets',
    button: (page: Page, n: number) => rowButton(page, 'Edit Budget for', `Stub category ${n}`),
    open: (button: Locator) => button.click(),
    field: 'Monthly Budget in dollars',
    stub: (page: Page) =>
      page.route(/\/api\/budgets(\?.*)?$/, (route) =>
        route.fulfill({
          json: {
            month: '2026-10',
            changeCount: 1,
            changeLimit: 600,
            budgets: Array.from({ length: 16 }, (_, i) => ({ categoryId: i + 1, categoryName: `Stub category ${i + 1}`, amountCents: null, effectiveFrom: null, changes: [] })),
          },
        }),
      ),
  },
]) {
  test(`${path}: a row's panel opens without moving the page`, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stub(page)
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.goto(path)
    await expect(page.getByRole('table', { name: table })).toBeVisible()
    await button(page, 6).evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 130)) // the sixth row is some way down the page
    const scrolled = await page.evaluate(() => window.scrollY)
    expect(scrolled).toBeGreaterThan(100)

    await open(button(page, 6))
    await expect(page.getByLabel(field, { exact: true })).toBeFocused()
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)
    await expect(page.getByRole('region').filter({ has: page.getByLabel(field, { exact: true }) })).toBeInViewport()

    // What is typed in it is still there when the reader has been to another row and comes back; Cancel throws it away.
    await page.getByLabel(field, { exact: true }).fill('75')
    await open(button(page, 7))
    // One panel is open at a time. A row's panel is a RowPanel (a Card with role="region"), which is what is counted: a page may
    // have sections of its own that are regions too, as /accounts has for adding a credit card Account.
    await expect(page.locator('[data-slot="card"][role="region"]')).toHaveCount(1)
    await expect(page.getByLabel(field, { exact: true })).not.toHaveValue('75')
    await open(button(page, 6))
    await expect(page.getByLabel(field, { exact: true })).toHaveValue('75')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await open(button(page, 6))
    await expect(page.getByLabel(field, { exact: true })).not.toHaveValue('75')
  })
}

test('a row\'s Actions menu opens from the keyboard, and focus goes back to its button when a question is closed or the menu is', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/categories')
  const button = actionsButton(page, 'Groceries')
  await expect(button).toBeVisible()

  await button.focus()
  await page.keyboard.press('Enter')
  await expect(menuAction(page, 'Rename')).toBeFocused() // opened with the keyboard, the first item has focus
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Category name')).toBeFocused() // the form the item opens takes focus once the menu has closed
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByLabel('Category name')).toHaveCount(0)
  await expect(button).toBeFocused() // and gives it back to the row's button

  await openActions(button)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(button).toBeFocused()
})
