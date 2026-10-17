import type { BrowserContext } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { importRows } from './report-helpers'
import { actionsButton, menuAction, openActions } from './row-actions-helpers'
import { expectTableLook } from './table-look-helpers'

// The one look every table has (ResponsiveTable, src/components/responsive-table.tsx): tested once here, on the Accounts table (in its own box) and the Balances table of the Dashboard (in a card, which is the
// box), and the cards a phone gets in place of either. Each page's own spec then checks that its table has the look (`expectTableLook`), and the Report specs that its printout does not (`expectPaperTable`).
// The row's "⋯" menu is tested here for the keyboard and for where focus goes; what each page's actions do is in that page's spec.

// The light and dark projects share one local database, so each has an Account of its own.
const accountFor = (project: string) => ({ number: project === 'dark' ? '99-9999-9999999-37' : '99-9999-9999999-36', name: `Table look ${project}` })

async function seed(context: BrowserContext, baseURL: string, project: string) {
  await signInAs(context, 'admin')
  const account = accountFor(project)
  await importRows(context, baseURL, {
    account,
    year: 2026,
    rows: [
      { date: '2026-10-01', payee: `EXAMPLE LOOK ${project} ONE`, amountCents: -1234, uniqueId: `LOOK${project}1` },
      { date: '2026-10-02', payee: `EXAMPLE LOOK ${project} TWO`, amountCents: 5000, uniqueId: `LOOK${project}2` },
    ],
  })
  return account
}

test('a table is a rounded box with a shaded heading row, a divider under each row and the page\'s text size, and in a card it has no second border', { tag: '@theme' }, async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.goto('/accounts')
  await expectTableLook(page.getByRole('table', { name: 'Accounts' }))
  await expect(page.getByRole('table', { name: 'Accounts' }).getByRole('cell', { name, exact: true })).toBeVisible()

  await page.goto('/')
  await expectTableLook(page.getByRole('region', { name: 'Balances' }).getByRole('table'), { inCard: true })
  await expectTableLook(page.getByRole('region', { name: 'Recent transactions' }).getByRole('table'), { inCard: true })
})

test('on a phone the rows are cards with the same border, corners and text size', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/accounts')
  const card = page.getByRole('list', { name: 'Accounts' }).getByRole('listitem').filter({ hasText: name })
  await expect(card).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  const look = await card.evaluate((element) => {
    const style = getComputedStyle(element)
    return { border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderTopLeftRadius), size: style.fontSize, pageSize: getComputedStyle(document.body).fontSize }
  })
  expect(look.border).toBeGreaterThan(0)
  expect(look.radius).toBeGreaterThan(0)
  expect(look.size).toBe(look.pageSize)
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

test('a Member has no Actions: there is nothing they can change', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/accounts')
  await expect(page.getByRole('table', { name: 'Accounts' }).getByRole('cell', { name, exact: true })).toBeVisible() // the data is there before its absences are looked for
  await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0)
})
