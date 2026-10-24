import type { Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { actionsButton, chooseAction } from './row-actions-helpers'

// The Admin's order of Accounts (#45), changed on the Accounts screen as the Rules page changes the order of Rules. The Accounts are
// stubbed: the light and dark projects and the other specs share one local database, and a real reorder would move their Accounts too.
// The Worker's side (the order used by every list, the Change Log, refusals) is in worker/account-order.test.ts.

const account = (id: number, name: string) => ({ id, name, accountNumber: `99-9999-999999${id}-00`, cutoverDate: null, akahuAccountId: null, akahuAttributes: null })
const STUB = [account(1, 'Example everyday'), account(2, 'Example savings'), account(3, 'Example card')]

/** Stubs the Accounts and records each order the page sends. */
async function stub(page: Page) {
  const sent: number[][] = []
  let held = STUB
  await page.route('**/api/accounts', (route) => route.fulfill({ json: held }))
  await page.route('**/api/accounts/order', async (route) => {
    const { ids } = route.request().postDataJSON() as { ids: number[] }
    sent.push(ids)
    held = ids.map((id) => STUB.find((each) => each.id === id)!)
    await route.fulfill({ json: { ids } })
  })
  return sent
}

/** The Accounts in the order the table shows them: each row that names one (the row of Akahu's details under it names it too, so each name is taken once). */
const names = async (page: Page) => [...new Set((await page.getByRole('table', { name: 'Accounts' }).getByRole('row').allTextContents()).map((text) => STUB.find((each) => text.includes(each.name))?.name).filter(Boolean))]

test('the Admin moves an Account with Move up and Move down, and the message says where it went', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const sent = await stub(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/accounts')
  await expect(page.getByText('This order is used wherever Accounts are listed.')).toBeVisible()

  await chooseAction(actionsButton(page, 'Example card'), 'Move up')
  await expect(page.getByRole('status').filter({ hasText: 'Moved Example card up. It is now Account 2 of 3.' })).toBeVisible()
  expect(sent).toEqual([[1, 3, 2]])
  expect(await names(page)).toEqual(['Example everyday', 'Example card', 'Example savings'])
  await expect(actionsButton(page, 'Example card')).toBeFocused()
  await noAxeViolations(page)
})

test('the Admin drags an Account by its handle from the keyboard, and is told each step', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const sent = await stub(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/accounts')
  const handle = page.getByRole('button', { name: 'Drag to reorder Example everyday' })
  await expect(handle).toHaveAttribute('aria-roledescription', 'movable Account')

  await handle.focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('status').filter({ hasText: 'Picked up Account 1 of 3.' })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('status').filter({ hasText: 'Account 1 is over position 2 of 3.' })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.getByRole('status').filter({ hasText: 'Moved Example everyday to position 2 of 3.' })).toBeVisible()
  expect(sent).toEqual([[2, 1, 3]])
  await expect(handle).toBeFocused()
})

test('a Member sees the Accounts in order, and nothing to change it with', async ({ page, context }) => {
  await signInAs(context, 'member')
  await stub(page)
  await page.goto('/accounts')
  await expect(page.getByRole('cell', { name: 'Example card', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Drag to reorder|Actions for) / })).toHaveCount(0)
  await expect(page.getByText('This order is used wherever Accounts are listed.')).toHaveCount(0)
})
