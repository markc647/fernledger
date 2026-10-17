import type { BrowserContext, Locator } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { importRows } from './report-helpers'
import { actionsButton, menuAction, openActions } from './row-actions-helpers'
import { expectTableLook } from './table-look-helpers'

// The one look every table has (ResponsiveTable, src/components/responsive-table.tsx): tested once here, on the Transactions table (in its own box) and the Recent transactions table of the Dashboard (in a card, which is the
// box), and on the cards a phone gets in place of the first. Each page's own spec then checks that its table has the look (`expectTableLook`), and the Report specs that its printout does not (`expectPaperTable`).
// The row's "⋯" menu is tested here for the keyboard and for where focus goes, on the Accounts table; what each page's actions do is in that page's spec.

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
  await expect(actionsButton(page, name)).toBeVisible() // the same "⋯" button, on the card
})

test('a row\'s Actions menu opens from the keyboard, and focus goes back to its button when a question is closed or the menu is', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.goto('/accounts')
  const button = actionsButton(page, name)
  await expect(button).toBeVisible()

  await button.focus()
  await page.keyboard.press('Enter')
  await expect(menuAction(page, 'Rename')).toBeFocused() // opened with the keyboard, the first item has focus
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Account name')).toBeFocused() // the form the item opens takes focus once the menu has closed
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByLabel('Account name')).toHaveCount(0)
  await expect(button).toBeFocused() // and gives it back to the row's button

  await openActions(button)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(button).toBeFocused()
})
