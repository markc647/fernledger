import type { BrowserContext, Page } from '@playwright/test'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { openHelp } from './help-helpers'
import { findTransactions, transactionId } from './report-helpers'
import { addRule, applyAnswer, applyButton, applyDialog, applyTheRules, categoryId, frameHeading, openApplyDialog, pageOrder, progressFrame, removeRule, ruleActions, ruleIds, runningJob, spinner, stubPaidPlan, stubUsageReadings, usageFigures, usageOn, withRules } from './rule-helpers'
import { arrowTo, chooseAction, menuAction, openActions, ruleActionButtons } from './row-actions-helpers'
import { chooseTextSize, mainNav, navGroup, navigateTo } from './shell-helpers'
import { expectTableLook } from './table-look-helpers'

// The light and dark projects share one local database, so each test uses text and an Account of its own, no earlier run used
// and no other spec uses: the Summary spec has 86 and 87, Categories 88 and 89, the Change Log 90 and 91, Cutover 92 and 93
// (a Cutover Date drops rows dated after it), Import 94 to 97.
const accountFor = (projectName: string) => (projectName === 'dark' ? '99-9999-9999999-84' : '99-9999-9999999-85')

async function importTransaction(context: BrowserContext, baseURL: string, projectName: string, description: string, uniqueId: string) {
  const res = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL },
    data: {
      account: { number: accountFor(projectName) },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-09', to: '2026-10-09', ledgerBalance: { cents: 0, date: '2026-10-09' } },
      rows: [{ date: '2026-10-09', uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee: description, bankMemo: 'EFTPOS', amountCents: -4321 }],
    },
  })
  expect(res.ok()).toBe(true)
}

/** Waits until the page has asked for everything it is going to, so that a count of its requests is not read before a late one. */
const quiet = (page: Page) => page.waitForLoadState('networkidle')

const rowFor = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(text) })

test.describe.configure({ mode: 'serial' })

test('the Admin checks how many Transactions a Rule matches, saves it, and new Transactions are put in its Category', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const shop = `EXAMPLE RULESHOP ${stamp}`
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} OLD`, `RA${stamp}`)

  await page.goto('/rules')
  await expect(page.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible()
  await expect(page.getByText('changes the Transactions you already have only when you choose Apply the Rules to all Transactions')).toBeHidden() // it is in the page's help sheet
  await expect(await openHelp(page)).toContainText('changes the Transactions you already have only when you choose Apply the Rules to all Transactions.')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Add a Rule' }).click()
  await expect(page.getByLabel('Text contains', { exact: true })).toBeFocused()

  // The Rule can't be saved before the Admin has seen what it matches.
  await page.getByLabel('Text contains', { exact: true }).fill(shop.toLowerCase())
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
  await page.getByRole('button', { name: 'Check how many match' }).click()
  const result = page.getByRole('status').filter({ hasText: 'you already have' })
  await expect(result).toContainText('1 Transaction you already have matches.')
  await expect(result).toContainText("Saving the Rule won't change it")
  await expect(result).toContainText(`${shop} OLD`)
  await expect(result).toContainText('type EFTPOS') // the bank's type, which a Rule can match on and the Transactions list does not show

  // Changing what it looks for takes the result away, and the Rule has to be checked again.
  await page.getByLabel('Text contains', { exact: true }).fill(`${shop} OLD`)
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
  await expect(page.getByText('You have changed what the Rule looks for')).toBeVisible()
  await page.getByLabel('Text contains', { exact: true }).fill(shop.toLowerCase())
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(result).toContainText('1 Transaction you already have matches.')

  await page.getByLabel('What the Rule does').selectOption({ label: 'Put in the Category Groceries' })
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save Rule' }).click()

  const saved = page.getByRole('status').filter({ hasText: 'Added the Rule.' })
  await expect(saved).toContainText('used for new Transactions as they are imported')
  await expect(saved).toContainText('To use the change on the Transactions you already have, choose Apply the Rules to all Transactions')
  await expect(page.getByRole('button', { name: 'Add a Rule' })).toBeFocused()
  const row = rowFor(page, shop.toLowerCase())
  await expect(row).toContainText(`Text contains “${shop.toLowerCase()}”`)
  await expect(row).toContainText('Category: Groceries')
  await noAxeViolations(page)

  // A Transaction imported now is put in Groceries by the Rule; the one on file from before is not.
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} NEW`, `RB${stamp}`)
  await navigateTo(page, 'All Transactions', 'Transactions')
  const added = rowFor(page, `${shop} NEW`)
  await expect(added).toContainText('Groceries')
  await expect(added).toContainText('Rule')
  await expect(rowFor(page, `${shop} OLD`)).toContainText('Uncategorised')

  await page.goto('/change-log')
  await expect(page.getByRole('listitem').filter({ hasText: 'Added a Rule: text contains' }).filter({ hasText: shop.toLowerCase() }).first()).toContainText('Rule change by admin@example.com')

  // Remove it again so that no other test is affected. The Transaction keeps the Category the Rule gave it.
  await page.goto('/rules')
  await chooseAction(ruleActionButtons(page).last(), 'Remove')
  await expect(page.getByRole('group', { name: /^Remove Rule/ })).toContainText('Transactions it already put in a Category keep that Category')
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused()
  await page.getByRole('button', { name: /^Yes, remove Rule/ }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Removed Rule/ })).toBeFocused()
  await expect(page.getByText(shop.toLowerCase())).toHaveCount(0)
})

test('the Admin changes a Rule and moves it in the order with the keyboard', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const fuel = await categoryId(context, 'Fuel')
  const first = await addRule(context, baseURL!, { textContains: `EXAMPLE ONE ${stamp}`, categoryId: fuel })
  const second = await addRule(context, baseURL!, { textContains: `EXAMPLE TWO ${stamp}`, bankType: 'EFTPOS', direction: 'out', minCents: 1000, maxCents: 25000, categoryId: fuel })

  try {
    await page.goto('/rules')
    await expect(rowFor(page, `EXAMPLE TWO ${stamp}`)).toContainText(`Text contains “EXAMPLE TWO ${stamp}” and type is EFTPOS and money out and amount from $10.00 to $250.00`)

    // WCAG 2.5.3: a menu item's accessible name is the text it shows, so voice control can say what it sees. The button that opens the menu says whose actions they are.
    const secondActions = ruleActions(page, second)
    expect(await secondActions.getAttribute('aria-label')).toMatch(/^Actions for Rule \d+$/)
    await openActions(secondActions)
    await expect(page.getByRole('menuitem')).toHaveText(['Edit', 'Move up', 'Move down', 'Remove'])
    for (const action of ['Edit', 'Move up', 'Move down', 'Remove']) expect(await menuAction(page, action).getAttribute('aria-label')).toBeNull()
    await page.keyboard.press('Escape')
    await expect(secondActions).toBeFocused()

    // Move the first Rule down with the keyboard: the button opens the menu (Enter), the arrow keys choose, and Enter moves it. It lands after the second, so Move down is no longer
    // possible for it, and focus is back on its Actions button.
    const firstActions = ruleActions(page, first)
    await firstActions.focus()
    await page.keyboard.press('Enter')
    await expect(menuAction(page, 'Edit')).toBeFocused()
    await arrowTo(page, 'Move down')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: /^Moved Rule \d+ down/ })).toBeVisible()
    await expect(firstActions).toBeFocused()
    expect((await ruleIds(context)).filter((id) => id === first || id === second)).toEqual([second, first])
    await openActions(firstActions)
    await expect(menuAction(page, 'Move down')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    // Edit the second: the amount range changes, and it needs no new check while the text, type and amounts are as they were.
    await chooseAction(secondActions, 'Edit')
    await expect(page.getByLabel('Text contains', { exact: true })).toHaveValue(`EXAMPLE TWO ${stamp}`)
    await expect(page.getByLabel('Amount from ($)')).toHaveValue('10.00')
    await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
    await expect(page.getByText('is a Transfer even if no matching Transaction is found in another Account')).toBeVisible()
    await expect(page.getByText("An Override outranks this Rule too: a Transaction with an Override counts under the Override's Category and is not a Transfer.")).toBeVisible() // as Not a Transfer does
    await expect(page.getByRole('button', { name: 'Save Rule' })).toBeEnabled()
    await noAxeViolations(page)
    await page.getByRole('button', { name: 'Save Rule' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved the changes to the Rule.' })).toBeVisible()
    await expect(secondActions).toBeFocused()
    await expect(rowFor(page, `EXAMPLE TWO ${stamp}`)).toContainText('Mark as a Transfer')
    await noAxeViolations(page)
  } finally {
    await removeRule(context, baseURL!, first)
    await removeRule(context, baseURL!, second)
  }
})

test("a Rule's Actions menu opens its form and its question where the old buttons did, and focus comes back to the row's button", async ({ page, context, baseURL }, testInfo) => {
  await withRules(context, baseURL!, testInfo, ['MENU'], async ([id]) => {
    await page.goto('/rules')
    const actions = ruleActions(page, id)
    const number = (await ruleIds(context)).indexOf(id) + 1
    await expect(actions).toHaveAccessibleName(`Actions for Rule ${number}`)
    await expect(page.getByRole('columnheader', { name: 'Action', exact: true })).toBeVisible() // one heading for the row's menu, in the singular like every table's

    // The menu is named for the button that opened it (which Radix does not do when the button has an id of its own).
    await openActions(actions)
    await expect(page.getByRole('menu', { name: `Actions for Rule ${number}` })).toBeVisible()

    // Edit: focus goes into the form, as it did from the Edit button. Cancel brings it back to this row's button.
    await menuAction(page, 'Edit').click()
    await expect(page.getByLabel('Text contains', { exact: true })).toBeFocused()
    await expect(page.getByLabel('Text contains', { exact: true })).toHaveValue(/^EXAMPLE MENU /)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(actions).toBeFocused()
    await expect(page.getByLabel('Text contains', { exact: true })).toHaveCount(0)

    // Remove: the question opens on its safe answer, and Keep it brings focus back to this row's button, which was taken out of the row while the question was in it.
    await chooseAction(actions, 'Remove')
    await expect(page.getByRole('group', { name: `Remove Rule ${number}` })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused()
    await expect(actions).toHaveCount(0)
    await page.getByRole('button', { name: 'Keep it' }).click()
    await expect(actions).toBeFocused()
    expect(await ruleIds(context)).toContain(id) // nothing was removed
  })
})

test('with one Rule there is nothing to put in order: no handle, no Reorder heading and no words about the order, and the Rule has its menu', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.route('**/api/rules', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [{ id: 1, textContains: 'EXAMPLE ONLY', bankType: null, direction: null, minCents: null, maxCents: null, categoryId: 7, categoryName: 'Fuel', categoryRemoved: false, transfer: false }] })
      : route.fallback(),
  )
  await page.goto('/rules')
  await expect(page.getByRole('table', { name: 'Rules, in the order they are checked' })).toBeVisible()
  await expect(page.getByRole('row', { name: /EXAMPLE ONLY/ })).toBeVisible()
  await expect(ruleActions(page, 1)).toHaveAccessibleName('Actions for Rule 1')
  await expect(page.locator('[id$="-grip"]')).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Reorder' })).toHaveCount(0)
  await expect(page.getByText(/To change the order/)).toHaveCount(0)
  await noAxeViolations(page)
})

test('the first Rule cannot move up and the last cannot move down, and each of the others can do both', async ({ page, context, baseURL }, testInfo) => {
  await withRules(context, baseURL!, testInfo, ['A', 'B'], async () => {
    await page.goto('/rules')
    const buttons = ruleActionButtons(page)
    await expect(buttons.nth(1)).toBeVisible() // at least these two
    await expectTableLook(page.getByRole('table', { name: 'Rules, in the order they are checked' }))
    await openActions(buttons.first())
    await expect(menuAction(page, 'Move up')).toHaveAttribute('aria-disabled', 'true')
    await expect(menuAction(page, 'Move down')).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await openActions(buttons.last())
    await expect(menuAction(page, 'Move down')).toHaveAttribute('aria-disabled', 'true')
    await expect(menuAction(page, 'Move up')).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    // A disabled item does nothing when it is chosen.
    const before = await ruleIds(context)
    await openActions(buttons.first())
    await menuAction(page, 'Move up').click({ force: true })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await ruleIds(context)).toEqual(before)
  })
})

test('the Admin moves a Rule up and down from its Actions menu with the mouse, and the Worker has the new order', async ({ page, context, baseURL }, testInfo) => {
  await withRules(context, baseURL!, testInfo, ['FIRST', 'SECOND', 'THIRD'], async ([a, b, c]) => {
    const mine = (ids: number[]) => ids.filter((id) => id === a || id === b || id === c)
    await page.goto('/rules')
    const all = await ruleIds(context)
    const total = all.length
    const cNumber = all.indexOf(c) + 1

    await chooseAction(ruleActions(page, c), 'Move up')
    const moved = page.getByRole('status').filter({ hasText: /^Moved Rule \d+ up/ })
    await expect(moved).toContainText(`Moved Rule ${cNumber} up. It is now Rule ${cNumber - 1} of ${total}.`)
    await expect(moved).toContainText('To use the change on the Transactions you already have, choose Apply the Rules to all Transactions')
    await expect(ruleActions(page, c)).toBeFocused() // the Rule is somewhere else in the list, and so is its button
    expect(mine(await ruleIds(context))).toEqual([a, c, b])
    expect(await pageOrder(page, a, b, c)).toEqual([a, c, b])
    await expect(ruleActions(page, c)).toHaveAccessibleName(`Actions for Rule ${cNumber - 1}`) // renumbered

    await chooseAction(ruleActions(page, a), 'Move down')
    await expect(page.getByRole('status').filter({ hasText: /^Moved Rule \d+ down/ })).toBeVisible()
    await expect(ruleActions(page, a)).toBeFocused()
    expect(mine(await ruleIds(context))).toEqual([c, a, b])
    expect(await pageOrder(page, a, b, c)).toEqual([c, a, b])
    await noAxeViolations(page)

    // The Change Log has the new order.
    await page.goto('/change-log')
    await expect(page.getByRole('listitem').filter({ hasText: 'Changed the order of Rules' }).first()).toContainText('Rule change by admin@example.com')
  })
})

// The Worker's answers are stubbed (worker/rules.test.ts holds the real ones). Each refusal is a 409, which Chrome logs.
test.describe('a refused Rule', () => {
  test.use({ expectedStatuses: [409] })

  test('says the Rule changed under it, and still says there are 200 Rules already', async ({ page, context, baseURL }, testInfo) => {
    await signInAs(context, 'admin')
    const stamp = `${testInfo.project.name}${Date.now()}`
    const id = await addRule(context, baseURL!, { textContains: `EXAMPLE THREE ${stamp}`, categoryId: await categoryId(context, 'Fuel') })
    let refusal: object = { error: 'This changed while your request was being handled. Try again.', reason: 'changed' }
    await page.route(/\/api\/rules\/\d+$/, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: refusal }) : route.fallback()))

    try {
      await page.goto('/rules')
      await chooseAction(ruleActions(page, id), 'Edit')
      await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
      await page.getByRole('button', { name: 'Save Rule' }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'changed just now' })).toHaveText('This Rule was changed just now. Try again.')

      refusal = { error: 'There are already 200 Rules; remove one first' }
      await page.getByRole('button', { name: 'Save Rule' }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'already 200 Rules' })).toHaveText('There are already 200 Rules. Remove one before adding another.')
      await noAxeViolations(page)
    } finally {
      await removeRule(context, baseURL!, id)
    }
  })

  test('tells the reader the Rules changed when putting them in order is refused as changed meanwhile', async ({ page, context, baseURL }, testInfo) => {
    await signInAs(context, 'admin')
    const stamp = `${testInfo.project.name}${Date.now()}`
    const fuel = await categoryId(context, 'Fuel')
    const first = await addRule(context, baseURL!, { textContains: `EXAMPLE FOUR ${stamp}`, categoryId: fuel })
    const second = await addRule(context, baseURL!, { textContains: `EXAMPLE FIVE ${stamp}`, categoryId: fuel })
    await page.route(/\/api\/rules\/order$/, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: { error: 'This changed while your request was being handled. Try again.', reason: 'changed' } }) : route.fallback()))

    try {
      await page.goto('/rules')
      await chooseAction(ruleActions(page, first), 'Move down')
      await expect(page.getByRole('alert').filter({ hasText: 'The Rules have changed' })).toHaveText('The Rules have changed since this page loaded. The list is up to date now; try again.')
      expect((await ruleIds(context)).filter((id) => id === first || id === second)).toEqual([first, second]) // nothing moved
      expect(await pageOrder(page, first, second)).toEqual([first, second]) // and the page is back to the order the Worker has
    } finally {
      await removeRule(context, baseURL!, first)
      await removeRule(context, baseURL!, second)
    }
  })
})

// A Rule another page (or a second click) removed first: the answer is the 404 a Rule that is not there has, which the page takes as the Rule being gone.
test.describe('a Rule removed meanwhile', () => {
  test.use({ expectedStatuses: [404] })

  test('is said to be gone already, and the list is brought up to date', async ({ page, context, baseURL }, testInfo) => {
    await signInAs(context, 'admin')
    const stamp = `${testInfo.project.name}${Date.now()}`
    const id = await addRule(context, baseURL!, { textContains: `EXAMPLE SIX ${stamp}`, categoryId: await categoryId(context, 'Fuel') })

    await page.goto('/rules')
    await expect(rowFor(page, `EXAMPLE SIX ${stamp}`)).toBeVisible()
    await chooseAction(ruleActions(page, id), 'Remove')
    await removeRule(context, baseURL!, id) // another page removes it while this one asks
    await page.getByRole('button', { name: /^Yes, remove Rule \d+$/ }).click()

    await expect(page.getByRole('status').filter({ hasText: 'That Rule had already been removed' })).toHaveText('That Rule had already been removed, so nothing was changed. The list is up to date now.')
    await expect(rowFor(page, `EXAMPLE SIX ${stamp}`)).toHaveCount(0)
    await noAxeViolations(page)
  })
})

test('boxes changed while a check is out do not take its result, so Save stays off until they are checked', async ({ page, context }) => {
  await signInAs(context, 'admin')
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/rules/preview', async (route) => {
    await held
    await route.fulfill({ json: { matches: 3, samples: [] } })
  })
  await page.goto('/rules')
  await page.getByRole('button', { name: 'Add a Rule' }).click()
  await page.getByLabel('Text contains', { exact: true }).fill('first')
  await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
  const check = page.getByRole('button', { name: 'Check how many match' })
  await check.click()
  await expect(check).toBeDisabled() // the check is out

  await page.getByLabel('Text contains', { exact: true }).fill('second')
  release()

  // The answer was about "first". It is not an answer about "second", so nothing is shown and Save is still off.
  await expect(check).toBeEnabled()
  await expect(page.getByText('You have changed what the Rule looks for')).toBeVisible()
  await expect(page.getByText('3 Transactions you already have match.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
})

test('the Admin is told what is wrong with a box, and taken to it', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/rules')
  await page.getByRole('button', { name: 'Add a Rule' }).click()

  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Fill in at least one of the boxes above' })).toBeVisible()
  await expect(page.getByLabel('Text contains', { exact: true })).toBeFocused()
  await expect(page.getByLabel('Text contains', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await noAxeViolations(page)

  await page.getByLabel('Text contains', { exact: true }).fill('example')
  await page.getByLabel('Amount from ($)').fill('12.345')
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Enter an amount in dollars' })).toBeVisible()
  await expect(page.getByLabel('Amount from ($)')).toBeFocused()

  await page.getByLabel('Amount from ($)').fill('50')
  await page.getByLabel('Amount up to ($)').fill('20')
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'must not be less than the amount it starts from' })).toBeVisible()
  await expect(page.getByLabel('Amount up to ($)')).toBeFocused()
  await noAxeViolations(page)
})

// The hints under three of the form's boxes are behind a "?" beside the box's label, and are still what describes the box to a screen reader.
test.describe("the form's hints", () => {
  const HINTS = [
    { field: ['Text contains'], about: 'About Text contains', text: "Looked for in the description and the bank's memo, ignoring capital letters A to Z." },
    { field: ['Transaction type'], about: 'About Transaction type', text: "The bank's own type, as the bank's export shows it (Tran Type), such as EFTPOS." },
    { field: ['Amount from ($)', 'Amount up to ($)'], about: 'About Amount from and up to', text: 'Both ends count. The amount is its size, whichever way the money went' },
  ]
  const start = (text: string) => new RegExp(text.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  test('a "?" beside the label opens the hint, Esc closes it and gives focus back, and the box is described by it throughout', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/rules')
    await page.getByRole('button', { name: 'Add a Rule' }).click()
    await expect(page.getByText('A Transaction matches when it meets every box you fill in. Leave a box blank to ignore it.')).toBeVisible() // the form's own line stays on the page

    const { field, about, text } = HINTS[0]!
    const input = page.getByLabel(field[0]!, { exact: true })
    const help = page.getByRole('button', { name: about })
    const hint = page.getByRole('dialog', { name: about })
    await expect(input).toHaveAccessibleDescription(start(text)) // read with the box, though the words are not drawn on the page
    await expect(page.locator('#rule-text-hint')).toHaveClass(/sr-only/)
    await expect(hint).toHaveCount(0)
    const [label, button] = [(await page.locator('label[for="rule-text"]').boundingBox())!, (await help.boundingBox())!]
    expect(button.x, 'to the right of its label').toBeGreaterThanOrEqual(label.x + label.width)
    expect(button.y + button.height, 'above the box').toBeLessThanOrEqual((await input.boundingBox())!.y)
    expect(button.width, 'a touch target').toBeGreaterThanOrEqual(44)
    expect(button.height).toBeGreaterThanOrEqual(44)

    await help.click()
    await expect(hint).toContainText(text)
    await expect(input).toHaveAccessibleDescription(start(text)) // still, with the hint open
    await noAxeViolations(page)
    await page.keyboard.press('Escape')
    await expect(hint).toHaveCount(0)
    await expect(help).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Add a Rule' })).toBeVisible() // Esc closed the hint and not the form
  })

  test('on a phone the "?" stays beside its label at every text size, and the two Amount boxes are level when they are side by side', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/rules')
    await page.getByRole('button', { name: 'Add a Rule' }).click()
    for (const size of ['Small', 'Medium', 'Xtra Large'] as const) {
      await chooseTextSize(page, size)
      await settle(page) // the buttons grow and shrink with the text size, over a transition
      const from = page.getByLabel('Amount from ($)', { exact: true })
      const to = page.getByLabel('Amount up to ($)', { exact: true })
      const [fromBox, toBox] = [(await from.boundingBox())!, (await to.boundingBox())!]
      if (size === 'Small') expect(Math.abs(fromBox.y - toBox.y), 'side by side at the smallest text, and level').toBeLessThan(1)
      else expect(toBox.y, 'one under the other at larger text').toBeGreaterThanOrEqual(fromBox.y + fromBox.height)
      for (const [name, id] of [['About Text contains', 'rule-text'], ['About Transaction type', 'rule-type'], ['About Amount from and up to', 'rule-from']] as const) {
        const [button, label] = [(await page.getByRole('button', { name }).boundingBox())!, (await page.locator(`label[for="${id}"]`).boundingBox())!]
        expect(button.x, `${name} is to the right of its label`).toBeGreaterThanOrEqual(label.x + label.width - 1)
        expect(button.y, `and on its row (${size})`).toBeLessThan(label.y + label.height)
        expect(button.x + button.width, 'and on the screen').toBeLessThanOrEqual(390)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    }
  })

  test('the other two hints open the same way, and the Amount hint describes both of its boxes', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/rules')
    await page.getByRole('button', { name: 'Add a Rule' }).click()
    for (const { field, about, text } of HINTS.slice(1)) {
      await page.getByRole('button', { name: about }).click()
      await expect(page.getByRole('dialog', { name: about })).toContainText(text)
      for (const name of field) await expect(page.getByLabel(name, { exact: true })).toHaveAccessibleDescription(start(text))
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: about })).toHaveCount(0)
    }
  })
})

test.describe('Apply the Rules to all Transactions, beside Add a Rule', () => {
  test('is on the row of Add a Rule, to its right, and the row wraps on a phone', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/rules')
    const add = page.getByRole('button', { name: 'Add a Rule' })
    await expect(add).toBeVisible()
    await expect(applyButton(page)).toBeEnabled()
    const [addBox, applyBox] = [(await add.boundingBox())!, (await applyButton(page).boundingBox())!]
    expect(applyBox.x, 'to the right of Add a Rule').toBeGreaterThanOrEqual(addBox.x + addBox.width)
    expect(Math.abs(applyBox.y + applyBox.height / 2 - (addBox.y + addBox.height / 2)), 'on the same row').toBeLessThan(4)
    expect(applyBox.height, 'a touch target').toBeGreaterThanOrEqual(44)

    // With the form open Add a Rule is off and not gone, so Apply the Rules to all Transactions stays under the pointer.
    await add.click()
    await expect(add).toBeDisabled()
    expect(await applyButton(page).boundingBox()).toEqual(applyBox)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(add).toBeFocused()
    await expect(add).toBeEnabled()

    await page.setViewportSize({ width: 360, height: 800 })
    await expect.poll(async () => (await applyButton(page).boundingBox())!.y - (await add.boundingBox())!.y).toBeGreaterThanOrEqual(44) // wrapped under it
    const box = (await applyButton(page).boundingBox())!
    expect(box.x + box.width, 'and inside the screen').toBeLessThanOrEqual(360)
  })

  test('asks first: Apply the Rules has focus and Enter starts the run; Cancel and Esc close it and give focus back; a press outside does not close it', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ reducedMotion: 'reduce' }) // the fades take no time, so a dialog that closes is gone at once
    let started = 0
    await page.route('**/api/rules/rerun/step', () => new Promise(() => {})) // never answered: the run stays as it started
    await page.route('**/api/rules/rerun', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { job: null } })
      started++
      return route.fulfill({ json: { job: runningJob({ doneRows: 0, percent: 0 }) } })
    })
    await page.goto('/rules')
    await expect(applyButton(page)).toBeEnabled()

    const dialog = await openApplyDialog(page)
    // What applying does, and the Free database allowance (here, its setup words) that the Admin reads before answering.
    await expect(dialog).toHaveAccessibleDescription('Goes through every Transaction, a few at a time. A Category you set by hand is never changed.')
    await expect(dialog.getByRole('region', { name: 'Free database allowance' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(applyAnswer(page)).toBeFocused() // so Enter is the answer to the question
    await noAxeViolations(page)

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(applyDialog(page)).toHaveCount(0)
    await expect(applyButton(page)).toBeFocused()
    // The page now knows whether the bar is set up (reading it was what showed the bar in the question), so a bar on the page would be drawn: it is only in the question.
    await expect(page.getByRole('region', { name: 'Free database allowance' })).toHaveCount(0)

    await openApplyDialog(page)
    await page.keyboard.press('Escape')
    await expect(applyDialog(page)).toHaveCount(0)
    await expect(applyButton(page)).toBeFocused()

    await openApplyDialog(page)
    await page.mouse.click(5, 5) // on the page behind it: an alert dialog is answered, not dismissed
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) // (a dialog that was dismissed would be gone by now: its fade lasts no time)
    await expect(applyDialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(applyDialog(page)).toHaveCount(0)
    await expect(applyButton(page)).toBeFocused()
    await quiet(page)
    expect(started).toBe(0) // nothing above started the run

    await openApplyDialog(page)
    await expect(applyAnswer(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(applyDialog(page)).toHaveCount(0)
    await expect.poll(() => started).toBe(1)
    await expect(spinner(page)).toBeVisible() // ...and the progress is under the buttons
    await expect(frameHeading(page)).toHaveText('Applying the Rules to all Transactions')
    await expect(frameHeading(page)).toBeFocused() // the question is gone and the button is off: focus is on what the Admin caused
    await expect(page.getByRole('status').filter({ hasText: 'Started. Going through up to 20,000 Transactions.' })).toHaveCount(1) // (said to a screen reader, not drawn)
  })

  test.describe('when the run cannot be started', () => {
    test.use({ expectedStatuses: [500] })

    test('says so, and focus is on Apply the Rules to all Transactions again', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: null } }) : route.fulfill({ status: 500, json: { error: 'Nope' } })))
      await page.goto('/rules')
      await applyTheRules(page)
      await expect(page.getByRole('alert').filter({ hasText: 'The Rules could not be applied. Try again.' })).toBeVisible()
      await expect(progressFrame(page)).toHaveCount(0)
      await expect(applyButton(page)).toBeFocused() // Radix gave it back to a button that was off, which cannot take it
    })
  })
})

test('the Admin applies a Rule to the Transactions already on file, and one set by hand is left alone', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const shop = `EXAMPLE APPLYSHOP ${stamp}`
  // Two Transactions on file before there is a Rule. The Admin sets the Category of one by hand.
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} PLAIN`, `AP${stamp}`)
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} HAND`, `AH${stamp}`)
  const found = () => findTransactions(context, shop)
  const handId = await transactionId(context, `${shop} HAND`)
  expect((await context.request.put(`/api/transactions/${handId}/override`, { headers: { Origin: baseURL! }, data: { categoryId: await categoryId(context, 'Travel') } })).ok()).toBe(true)
  const rule = await addRule(context, baseURL!, { textContains: shop.toLowerCase(), categoryId: await categoryId(context, 'Groceries') })

  try {
    await page.goto('/rules')
    await expect(page.getByRole('heading', { level: 2, name: 'Apply the Rules to all Transactions' })).toHaveCount(0) // (the box with a heading of its own is gone: the button asks first)
    await expect(applyButton(page)).toBeEnabled()
    await noAxeViolations(page)
    // Nothing has changed yet: a Rule is for new Transactions until it is applied.
    expect((await found()).map((t) => t.categoryName).sort()).toEqual(['Travel', null])

    // (The light and dark runs share a database, so the page may already show the other's finished run; the Transactions are what tell.)
    await applyTheRules(page)
    await expect.poll(async () => (await found()).find((t) => t.description.endsWith('PLAIN'))?.categoryName).toBe('Groceries')
    await expect(page.getByRole('status').filter({ hasText: /Finished\. Looked at/ })).toContainText('and updated')
    await expect(page.getByText(/^Finished (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/)).toBeVisible()
    await expect(frameHeading(page)).toHaveText('Applied the Rules to all Transactions')
    await expect(applyButton(page)).toBeEnabled()
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await noAxeViolations(page)

    // The Transaction on file from before has the Rule's Category now. The one the Admin set by hand has the Category it was given.
    const applied = await found()
    expect(applied.find((t) => t.description.endsWith('PLAIN'))).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
    expect(applied.find((t) => t.description.endsWith('HAND'))).toMatchObject({ categoryName: 'Travel', categorySource: 'override' })

    await page.goto('/change-log')
    await expect(page.getByRole('listitem').filter({ hasText: 'Started applying the Rules to up to' }).first()).toContainText('Rule change by admin@example.com')
    await expect(page.getByRole('listitem').filter({ hasText: 'Finished applying the Rules to all Transactions' }).first()).toContainText('Rule change by admin@example.com')
  } finally {
    await removeRule(context, baseURL!, rule)
  }

  // With the Rule gone, applying the Rules again takes the Category it gave away. The Override stays.
  await page.goto('/rules')
  await applyTheRules(page)
  await expect.poll(async () => (await found()).find((t) => t.description.endsWith('PLAIN'))?.categoryName).toBeNull()
  await expect(page.getByRole('status').filter({ hasText: /Finished\. Looked at/ })).toBeVisible()
  const cleared = await found()
  expect(cleared.find((t) => t.description.endsWith('PLAIN'))).toMatchObject({ categoryName: null, categorySource: null })
  expect(cleared.find((t) => t.description.endsWith('HAND'))).toMatchObject({ categoryName: 'Travel', categorySource: 'override' })
})

// On the Paid Plan there is no daily allowance (ADR 0018): the question shows today's figures alone, with no bars against the Free Plan's day and none of its words.
test("the question before applying shows today's database figures without the Free Plan's limits on the Paid Plan", async ({ page, context }) => {
  await signInAs(context, 'admin')
  await stubPaidPlan(page)
  await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
  await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures() }))
  await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: null } }) : route.fallback()))
  await page.goto('/rules')
  await expect(applyButton(page)).toBeEnabled()

  const usage = (await openApplyDialog(page)).getByRole('region', { name: 'Database usage today' })
  await expect(usage).toContainText('1,234,567 rows read and 4,321 rows written today. On the Paid Plan there is no daily limit to run out of.')
  await expect(usage.getByRole('progressbar')).toHaveCount(0)
  await expect(usage).not.toContainText(/Plenty left|Running low|Almost used|Used up|5,000,000|starts again/)
  await noAxeViolations(page)
})

test.describe('while the Rules are being applied', () => {
  // The 429 below is the free plan's daily allowance being used up, which the page has to explain; Chrome logs it as an error.
  test.use({ expectedStatuses: [429] })

  test('the page shows how far it has got, announces a few times, says a used-up day ends at midday NZ time, carries on by itself then, and keeps a finished run finished when a late reading arrives', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
    await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures() }))
    // The page asks again when the day changes (00:00 UTC), so the clock is the test's to move.
    await page.clock.install({ time: new Date('2026-10-11T02:00:00Z') })
    let current = runningJob()
    const answers: (() => { status: number; json: unknown })[] = [
      () => ({ status: 200, json: { job: (current = runningJob({ doneRows: 10_000, changedRows: 400, percent: 50, updatedAt: '2026-10-11T02:01:00.000Z' })) } }),
      () => ({ status: 429, json: { error: 'Daily limit reached' } }),
      () => ({ status: 200, json: { job: (current = runningJob({ status: 'done', doneRows: 20_000, changedRows: 1_234, percent: 100, updatedAt: '2026-10-12T00:05:00.000Z', finishedAt: '2026-10-12T00:05:00.000Z' })) } }),
    ]
    // Each step waits to be let go, so the page can be looked at between them.
    const gates = answers.map(() => {
      let open = () => {}
      const opened = new Promise<void>((resolve) => (open = resolve))
      return { opened, open }
    })
    let steps = 0
    await page.route('**/api/rules/rerun/step', async (route) => {
      const n = steps++
      await gates[n]!.opened
      await route.fulfill(answers[n]!())
    })
    // When `holdBack` is set, the next reading of the job waits for it, and then says what the job was when it was set.
    let holdBack: { job: typeof current; until: Promise<void> } | null = null
    await page.route('**/api/rules/rerun', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const held = holdBack
      holdBack = null
      if (held) await held.until
      await route.fulfill({ json: { job: held ? held.job : current } })
    })

    await page.goto('/rules')
    // A run that was going when the page was opened is carried on, and shown.
    await expect(page.getByText('Looked at 4,000 of up to 20,000 Transactions (20%).')).toBeVisible()
    const bar = page.getByRole('progressbar', { name: 'Applying the Rules to all Transactions' })
    await expect(bar).toHaveAttribute('value', '20')
    await expect(page.getByRole('status').filter({ hasText: 'Started. Going through up to 20,000 Transactions.' })).toBeVisible()
    await expect(page.getByText('Last updated Sun 11 Oct 2026, 3:00 pm.')).toBeVisible()
    await expect(page.getByText('About 16 more steps if you keep this page open, or about 3 days if you close it.')).toBeVisible()
    await expect(applyButton(page)).toBeDisabled()
    // A run that is going is a spinner, what it says and its Stop button, in a frame of their own under the buttons.
    const frame = progressFrame(page)
    await expect(frameHeading(page)).toHaveText('Applying the Rules to all Transactions')
    await expect(frame.getByRole('status', { name: 'Loading' })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Stop applying the Rules' })).toBeEnabled()
    await noAxeViolations(page)

    gates[0]!.open()
    await expect(page.getByText('Looked at 10,000 of up to 20,000 Transactions (50%).')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: '50% done.' })).toBeVisible()
    await expect(bar).toHaveAttribute('value', '50')

    gates[1]!.open()
    const alert = page.getByRole('alert').filter({ hasText: 'used up the database allowance' })
    await expect(alert).toContainText('It carries on by itself after the daily allowance resets, around midday NZ time. Open this page then to finish sooner.')
    await expect(alert.getByRole('button')).toHaveCount(0) // trying again now would only be refused again
    await expect(page.getByText('Looked at 10,000 of up to 20,000 Transactions (50%).')).toBeVisible() // where it got to is still shown
    await expect(frame.getByRole('alert')).toBeVisible() // in the same frame, which is not spinning while it waits for the day
    await expect(spinner(page)).toHaveCount(0)
    await expect(frameHeading(page)).toHaveText('Paused until the allowance resets') // and is titled for it, with just its message and not when it was last updated
    await expect(page.getByText(/^Last updated/)).toHaveCount(0)
    await expect(frame.getByRole('region', { name: 'Free database allowance' })).toContainText('1,234,567 of 5,000,000 rows read · 24%') // the allowance, which the Apply button cannot show while a run is going
    await expect(frame.getByRole('button', { name: 'Stop applying the Rules' })).toBeEnabled()
    await noAxeViolations(page)

    // The day changes: the page asks again, with nobody pressing anything. It reads the job as well as asking for a step, and the two
    // answers can come back in either order. Here the reading comes back last, saying where the run was before the step finished it:
    // the page keeps the step's answer, which is newer.
    let answerTheReading = () => {}
    holdBack = { job: current, until: new Promise<void>((resolve) => (answerTheReading = resolve)) }
    const reading = page.waitForResponse((res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/rules/rerun')
    gates[2]!.open()
    await page.clock.fastForward('23:00:00')
    await expect(page.getByRole('status').filter({ hasText: 'Finished. Looked at all 20,000 Transactions and updated 1,234 of them.' })).toBeVisible()
    answerTheReading()
    await reading
    await expect(page.getByText('Finished Mon 12 Oct 2026, 1:05 pm.')).toBeVisible()
    await expect(alert).toHaveCount(0)
    await expect(bar).toHaveCount(0)
    await expect(frameHeading(page)).toHaveText('Applied the Rules to all Transactions')
    await expect(frame.getByRole('region', { name: 'Free database allowance' })).toHaveCount(0) // a run that is not waiting for the day has no need of it
    await expect(spinner(page)).toHaveCount(0)
    await expect(frame.getByRole('button', { name: 'Stop applying the Rules' })).toHaveCount(0)
    await expect(applyButton(page)).toBeEnabled()
    await noAxeViolations(page)
    expect(steps).toBe(3) // the late reading did not set the run going again
  })

  test('a run that has used its share of the day is shown as paused, and the page does not ask for steps', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
    await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures({ rowsRead: 4_900_000 }) }))
    let steps = 0
    await page.route('**/api/rules/rerun/step', (route) => {
      steps++
      return route.fulfill({ json: { job: runningJob({ paused: true }) } })
    })
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ paused: true }) } }) : route.fallback()))
    await page.goto('/rules')

    await expect(page.getByText(/^Paused: it has used the share of today's free database allowance that it keeps for itself\./)).toContainText('Open this page then to finish sooner.')
    await expect(page.getByRole('status').filter({ hasText: 'Paused until the daily allowance resets, around midday NZ time.' })).toBeVisible()
    await expect(applyButton(page)).toBeDisabled()
    // The frame has a solid border (Empty's own is dashed), and the padding of a card and not of a page.
    expect(await progressFrame(page).evaluate((frame) => getComputedStyle(frame).borderTopStyle)).toBe('solid')
    expect(await progressFrame(page).evaluate((frame) => parseFloat(getComputedStyle(frame).paddingTop))).toBeLessThanOrEqual(24)
    // Waiting for the day is not working: no spinner, the message in the frame, and Stop is still there.
    await expect(progressFrame(page).getByText(/^Paused: it has used the share/)).toBeVisible()
    await expect(frameHeading(page)).toHaveText('Paused until the allowance resets')
    await expect(progressFrame(page).getByText(/^Last updated/)).toHaveCount(0) // just the message
    await expect(spinner(page)).toHaveCount(0)
    await expect(progressFrame(page).getByRole('button', { name: 'Stop applying the Rules' })).toBeEnabled()
    // The button that opens the allowance is off while the run is going, so the allowance is in the frame, as it is now (read as the frame showed it).
    await expect(progressFrame(page).getByRole('region', { name: 'Free database allowance' })).toContainText('4,900,000 of 5,000,000 rows read · 98%')
    await noAxeViolations(page)
    expect(steps).toBe(0)
  })

  test('a page whose clock is ahead of the Worker\'s asks again in a few minutes and not a day later', async ({ page, context }) => {
    await signInAs(context, 'admin')
    // By this page's clock it is ten minutes to midnight UTC. The Worker's day has not changed when the page first asks, and changes later.
    await page.clock.install({ time: new Date('2026-10-11T23:50:00Z') })
    let workersDayHasChanged = false
    let asked = 0
    let steps = 0
    let finished = false
    const current = () =>
      finished
        ? runningJob({ status: 'done', doneRows: 20_000, percent: 100, finishedAt: '2026-10-12T00:20:00.000Z', updatedAt: '2026-10-12T00:20:00.000Z' })
        : runningJob({ paused: !workersDayHasChanged })
    await page.route('**/api/rules/rerun/step', (route) => {
      steps++
      finished = true
      return route.fulfill({ json: { job: current() } })
    })
    await page.route('**/api/rules/rerun', (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      asked++
      return route.fulfill({ json: { job: current() } })
    })
    await page.goto('/rules')
    await expect(page.getByText(/^Paused: it has used the share/)).toBeVisible()
    expect(asked).toBe(1)

    await page.clock.fastForward('00:10:10') // the page's midnight: it asks, and is told to wait
    await expect.poll(() => asked).toBe(2)
    await expect(page.getByText(/^Paused: it has used the share/)).toBeVisible()
    expect(steps).toBe(0)

    workersDayHasChanged = true // the Worker's midnight comes a little later
    await page.clock.fastForward('00:05:10') // the page asks again five minutes after, and not a day after
    await expect(page.getByRole('status').filter({ hasText: 'Finished. Looked at all 20,000 Transactions' })).toBeVisible()
    expect(asked).toBe(3)
    expect(steps).toBe(1)
  })

  test('says the Rules changed while it ran, and that it started again', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun/step', () => new Promise(() => {})) // never answered: the page stays as the job was when it opened
    await page.route('**/api/rules/rerun', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ totalRows: 3_000, doneRows: 0, percent: 0, restarts: 2 }) } }) : route.fallback(),
    )
    await page.goto('/rules')

    await expect(page.getByText('The Rules changed 2 times while this was running, so it started again from the first Transaction each time.')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'The Rules changed again, so it started again (2 times). Going through up to 3,000 Transactions.' })).toBeVisible()
  })

  // A run that ends by itself takes away the Stop button, and focus on it with it.
  for (const { where, name } of [
    { where: 'Stop applying the Rules', name: 'a run that finishes by itself while Stop has focus puts focus on the title of its frame' },
    { where: 'Add a Rule', name: 'a run that finishes by itself while focus is on Add a Rule leaves it there' },
  ] as const) {
    test(name, async ({ page, context }) => {
      await signInAs(context, 'admin')
      let finish = () => {}
      const finishing = new Promise<void>((resolve) => (finish = resolve))
      await page.route('**/api/rules/rerun/step', async (route) => {
        await finishing
        await route.fulfill({ json: { job: runningJob({ status: 'done', doneRows: 20_000, changedRows: 1_234, percent: 100, finishedAt: '2026-10-11T02:09:00.000Z' }) } })
      })
      await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
      await page.goto('/rules')
      await expect(frameHeading(page)).toHaveText('Applying the Rules to all Transactions')
      const control = page.getByRole('button', { name: where })
      await control.focus()
      await expect(control).toBeFocused()

      finish()
      await expect(frameHeading(page)).toHaveText('Applied the Rules to all Transactions')
      if (where === 'Add a Rule') await expect(control).toBeFocused()
      else await expect(frameHeading(page)).toBeFocused() // and not the page, which is where focus goes when the button it was on is taken away
    })
  }

  test('the spinner turns, and does not turn when the device asks for less motion', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun/step', () => new Promise(() => {}))
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/rules')
    const turning = () => spinner(page).evaluate((element) => element.getAnimations().length) // the animations that are running or about to
    await expect(spinner(page)).toBeVisible()
    await expect.poll(turning).toBeGreaterThan(0)

    await page.emulateMedia({ reducedMotion: 'reduce' }) // src/index.css gives an animation no time and one turn: it is over as it begins
    await expect.poll(turning).toBe(0)
  })

  test('does not show or announce a run that finished before the page was opened', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ status: 'done', doneRows: 20_000, percent: 100, finishedAt: '2026-10-11T02:05:00.000Z' }) } }) : route.fallback(),
    )
    await page.goto('/rules')

    await expect(applyButton(page)).toBeEnabled()
    await expect(page.getByText('Looked at all 20,000 Transactions')).toHaveCount(0) // the frame is for a run going or one that has just ended in this visit
    await expect(progressFrame(page)).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Finished.' })).toHaveCount(0) // and nothing is said to a screen reader
  })

  test('the Admin stops a run, and is told what that leaves', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun/step', () => new Promise(() => {}))
    await page.route('**/api/rules/rerun/stop', (route) =>
      route.fulfill({ json: { job: runningJob({ status: 'stopped', doneRows: 7_000, changedRows: 300, percent: 35, finishedAt: '2026-10-11T02:07:00.000Z' }) } }),
    )
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
    await page.goto('/rules')

    await page.getByRole('button', { name: 'Stop applying the Rules' }).click()

    await expect(frameHeading(page)).toHaveText('Stopped applying the Rules')
    await expect(frameHeading(page)).toBeFocused() // the Stop button has gone, and focus is on what it did
    await expect(page.getByRole('status').filter({ hasText: 'Stopped. Looked at 7,000 Transactions and updated 300 of them. Those keep the result they were given and the rest are as they were.' })).toHaveCount(1)
    await expect(page.getByText('Stopped Sun 11 Oct 2026, 3:07 pm.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop applying the Rules' })).toHaveCount(0)
    await expect(spinner(page)).toHaveCount(0) // stopped, and still said in the frame
    await expect(progressFrame(page)).toContainText('Stopped. Looked at 7,000 Transactions')
    await expect(applyButton(page)).toBeEnabled()
    await noAxeViolations(page)
  })

  test('while a Rule is being changed the run waits, and the form, the Save message and the removal say that saving starts it again', async ({ page, context, baseURL }, testInfo) => {
    await signInAs(context, 'admin')
    const stamp = `${testInfo.project.name}${Date.now()}`
    const rule = await addRule(context, baseURL!, { textContains: `EXAMPLE RUNGOING ${stamp}`, categoryId: await categoryId(context, 'Fuel') })
    let steps = 0
    try {
      await page.route('**/api/rules/rerun/step', (route) => {
        steps++
        return route.fulfill({ json: { job: runningJob() } })
      })
      await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
      await page.goto('/rules')
      await expect.poll(() => steps).toBeGreaterThan(2) // asking for step after step...

      await page.getByRole('button', { name: 'Add a Rule' }).click()
      await expect(page.getByText('A run is going. Saving starts it again from the first Transaction.')).toBeVisible()
      await expect(page.getByText('Waiting while you change a Rule.')).toBeVisible()
      // Nothing is being done, and the frame says so: no spinner, and a title of its own.
      await expect(frameHeading(page)).toHaveText('Applying the Rules waits while you change a Rule')
      await expect(spinner(page)).toHaveCount(0)
      await noAxeViolations(page)
      const whenOpened = steps
      // oxlint-disable-next-line no-restricted-properties -- nothing to await: this checks that no step is asked for while the form is open
      await page.waitForTimeout(600)
      expect(steps - whenOpened).toBeLessThanOrEqual(1) // ...until the form is open: at most the one already out
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect.poll(() => steps).toBeGreaterThan(whenOpened + 2) // and then on again
      await expect(frameHeading(page)).toHaveText('Applying the Rules to all Transactions')
      await expect(spinner(page)).toBeVisible()

      await chooseAction(ruleActionButtons(page).last(), 'Remove')
      await expect(page.getByRole('group', { name: /^Remove Rule/ })).toContainText('A run is going. Removing the Rule starts it again from the first Transaction.')
    } finally {
      await removeRule(context, baseURL!, rule)
    }
  })
})

test('a Member does not see the Rules page, and the API refuses their changes', async ({ page, context, baseURL }) => {
  await signInAs(context, 'member')
  await page.goto('/rules')
  await expect(page.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible()
  await expect(page.getByText('Only the Admin can use this page.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add a Rule' })).toHaveCount(0)
  await expect(navGroup(page, 'Transactions')).toBeVisible()
  await expect(navGroup(page, 'Set up')).toHaveCount(0) // a Member's sidebar has no Set up group, so no Rules link in it
  await expect(mainNav(page).getByRole('link', { name: 'Rules' })).toHaveCount(0)
  await noAxeViolations(page)

  // The D1 usage figures are the Admin's alone, whether or not they are set up (here they are not). (Asked before the refused write below:
  // that one is sent without a body, and Vite's local server then drops the next request on its connection, as settings.spec.ts says.)
  const usage = await context.request.get('/api/d1-usage')
  expect(usage.status()).toBe(403)
  expect(await usage.json()).toEqual({ error: 'Admin only' })

  const refused = await context.request.post('/api/rules', { headers: { Origin: baseURL! }, data: { textContains: 'example', transfer: true } })
  expect(refused.status()).toBe(403)
})

// The D1 usage bar (worker/d1-usage.ts, src/components/d1-usage-bar.tsx). Local development has no CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID, so the
// real Worker answers Not set up; the "on" tests stub what the Worker would send, so nothing here reaches Cloudflare.
const usagePanel = (page: Page) => page.getByRole('region', { name: 'Free database allowance' })
const meterFor = (page: Page, label: 'Database rows read today' | 'Database rows written today') => usagePanel(page).getByRole('group', { name: label })

/** The colours of the theme's own tokens as the browser computes them for a background, so the check is right in the dark theme as well. */
const tokenColours = (page: Page, names: string[]) =>
  page.evaluate((tokens) => {
    const resolve = (name: string) => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = `var(--${name})`
      document.body.append(probe)
      const colour = getComputedStyle(probe).backgroundColor
      probe.remove()
      return colour
    }
    return Object.fromEntries(tokens.map((name) => [name, resolve(name)]))
  }, names)

test.describe('the D1 usage bar', () => {
  test('is off until the Deployer sets it up: the Admin is told how, no usage is asked for, and nothing is shown as an error', async ({ page, context }) => {
    await signInAs(context, 'admin')
    const asked: string[] = []
    page.on('request', (request) => request.url().includes('/api/d1-usage') && asked.push(request.url()))
    await page.goto('/rules')
    await openApplyDialog(page) // the bar is in the question before the Rules are applied, and not on the page

    const panel = usagePanel(page)
    await expect(panel).toContainText('Optional: you only need this to use the D1 usage bar.')
    await expect(panel).toContainText('Setup needed: the Cloudflare analytics token. Add it as the Worker secret CF_ANALYTICS_TOKEN.')
    await expect(panel).toContainText('Setup needed: the Cloudflare account ID. Add it as the Worker secret CF_ACCOUNT_ID.')
    await expect(panel).toContainText('The steps are in docs/setup.md, under "D1 usage bar (optional)".')
    await expect(panel.getByRole('progressbar')).toHaveCount(0)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('button')).toHaveCount(0)
    await noAxeViolations(page)
    expect(asked).toEqual([])
  })

  // Three runs show every level on both bars (the same words and colours as the header's bar says of the same figures, e2e/allowance-bar.spec.ts): Running low on the rows read and Used up on
  // the rows written (past the end of its allowance), then Plenty left on both, then Almost used on the rows read and Running low on the rows written.
  for (const { runs, figures, reads, writes } of [
    {
      runs: 'Running low on the rows read and Used up on the rows written',
      figures: { rowsRead: 3_750_000, rowsWritten: 105_000 },
      reads: { level: 'Running low', percent: 75, drawn: 75, token: 'warning', text: '3,750,000 of 5,000,000 rows read' },
      writes: { level: 'Used up', percent: 105, drawn: 100, token: 'danger', text: '105,000 of 100,000 rows written' }, // the bar stops at its end
    },
    {
      runs: 'Plenty left on both',
      figures: { rowsRead: 1_234_567, rowsWritten: 4_321 },
      reads: { level: 'Plenty left', percent: 24, drawn: 24, token: 'success', text: '1,234,567 of 5,000,000 rows read' },
      writes: { level: 'Plenty left', percent: 4, drawn: 4, token: 'success', text: '4,321 of 100,000 rows written' },
    },
    {
      runs: 'Almost used on the rows read and Running low on the rows written',
      figures: { rowsRead: 4_500_000, rowsWritten: 70_000 },
      reads: { level: 'Almost used', percent: 90, drawn: 90, token: 'danger', text: '4,500,000 of 5,000,000 rows read' },
      writes: { level: 'Running low', percent: 70, drawn: 70, token: 'warning', text: '70,000 of 100,000 rows written' },
    },
  ]) {
    test(`shows ${runs}: each badge sits with its own bar, and the bar's fill is the level's colour while its track keeps its own`, { tag: '@theme' }, async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
      await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures(figures) }))
      await page.goto('/rules')
      await openApplyDialog(page)

      const colours = await tokenColours(page, ['success', 'warning', 'danger', 'muted'])
      for (const [label, meter] of [
        ['Database rows read today', reads],
        ['Database rows written today', writes],
      ] as const) {
        const group = meterFor(page, label)
        // The badge is in the same group as its bar and its figures.
        await expect(group.getByText(meter.level, { exact: true })).toBeVisible()
        await expect(group.getByText(`${meter.text} · ${meter.percent}%`)).toBeVisible()
        const bar = group.getByRole('progressbar', { name: label })
        await expect(bar).toHaveAttribute('aria-valuenow', String(meter.drawn))
        await expect(bar).toHaveAttribute('aria-valuetext', `${meter.text}, ${meter.percent}%`)
        // The fill is the level's colour (the theme's own token) and the track keeps its own.
        expect(await bar.locator('[data-slot="progress-indicator"]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(colours[meter.token])
        expect(await bar.locator('[data-slot="progress-track"]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(colours.muted)
      }
      // Said once, for both bars.
      await expect(usagePanel(page).getByText('The allowance starts again on Thu 15 Oct 2026, 1:00 pm, New Zealand time.')).toBeVisible()
      await expect(usagePanel(page).getByText('These figures are for the whole Cloudflare account, not only Fernledger, and run a few minutes behind.')).toBeVisible()
      await noAxeViolations(page)
    })
  }

  test('is read when the question opens, each time it does, and not for the steps of a run or while the question is shut', async ({ page, context }) => {
    await signInAs(context, 'admin')
    // Each answer is a little further on, as the account's day is while a run uses it.
    const answers = [usageFigures(), usageFigures({ rowsRead: 2_750_000 }), usageFigures({ rowsRead: 4_200_000 })]
    await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
    const usage = await stubUsageReadings(page, (reading) => ({ json: answers[Math.min(reading, answers.length - 1)] })) // (the header's reading as the page loads is not one of these)
    // The run: the first step is a step like any other, the next ends it.
    let job: ReturnType<typeof runningJob> | null = null
    let steps = 0
    await page.route('**/api/rules/rerun/step', (route) => route.fulfill({ json: { job: (job = steps++ === 0 ? runningJob({ doneRows: 8_000, percent: 40 }) : runningJob({ status: 'done', doneRows: 20_000, percent: 100, finishedAt: '2026-10-11T02:09:00.000Z' })) } }))
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job } }) : route.fulfill({ json: { job: (job = runningJob()) } })))
    await page.goto('/rules')
    await expect(applyButton(page)).toBeEnabled()

    const dialog = await openApplyDialog(page)
    await expect(dialog.getByText('1,234,567 of 5,000,000 rows read · 24%')).toBeVisible()
    await quiet(page)
    expect(usage.readings()).toBe(1) // (the question asks when it opens and not as the page loads: the one reading made then is the header's, which is not counted here)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openApplyDialog(page)
    await expect(dialog.getByText('2,750,000 of 5,000,000 rows read · 55%')).toBeVisible()
    await quiet(page)
    expect(usage.readings()).toBe(2)

    await applyAnswer(page).click()
    await expect(progressFrame(page)).toContainText('Finished. Looked at all 20,000 Transactions')
    expect(steps).toBe(2)
    await quiet(page)
    expect(usage.readings()).toBe(2) // two steps and an end, and the question was shut: it asked for nothing

    await openApplyDialog(page)
    await expect(dialog.getByText('4,200,000 of 5,000,000 rows read · 84%')).toBeVisible() // the figures after the run, not the ones from before it
    await quiet(page)
    expect(usage.readings()).toBe(3)
  })

  test.describe('when Cloudflare cannot give the figures', () => {
    test.use({ expectedStatuses: [502] })

    test('says why and what to check, still lets the Rules be applied, and shows the figures when asked again', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
      const usage = await stubUsageReadings(page, (reading) => (reading === 0 ? { status: 502, json: { error: 'Usage unavailable', reason: 'no-account' } } : { json: usageFigures() }))
      await page.goto('/rules')
      await openApplyDialog(page)

      const panel = usagePanel(page)
      const note = panel.getByRole('status').filter({ hasText: 'Usage unavailable.' })
      await expect(note).toContainText('Cloudflare found no such account for this token.')
      await expect(note).toContainText('CF_ACCOUNT_ID must be the account the token belongs to, and the token needs Account Analytics: Read.')
      await expect(note).toContainText('The steps are in docs/setup.md, under "D1 usage bar (optional)".')
      await expect(panel.getByRole('progressbar')).toHaveCount(0)
      await expect(applyAnswer(page)).toBeEnabled() // the Rules can still be applied
      await noAxeViolations(page)

      await panel.getByRole('button', { name: 'Check again' }).click()
      await expect(panel.getByText('1,234,567 of 5,000,000 rows read · 24%')).toBeVisible()
      await expect(panel.getByText('Usage unavailable.')).toHaveCount(0)
      expect(usage.readings()).toBe(2)
      await noAxeViolations(page)
    })

    test('after figures, a reading that fails takes them down rather than leaving them as today, and asking again brings them back', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
      const usage = await stubUsageReadings(page, (reading) =>
        reading === 1 ? { status: 502, json: { error: 'Usage unavailable', reason: 'unreachable' } } : { json: usageFigures(reading === 0 ? {} : { rowsRead: 3_000_000 }) },
      )
      await page.goto('/rules')
      await openApplyDialog(page)
      const panel = usagePanel(page)
      await expect(panel.getByText('1,234,567 of 5,000,000 rows read · 24%')).toBeVisible()

      // The question is opened again, the figures are read again, and Cloudflare cannot give them.
      await page.keyboard.press('Escape')
      await expect(applyDialog(page)).toHaveCount(0)
      await openApplyDialog(page)
      await expect(panel.getByRole('status').filter({ hasText: 'Usage unavailable.' })).toContainText('Cloudflare could not be reached just now')
      await expect(panel.getByRole('progressbar')).toHaveCount(0)
      await expect(panel.getByText('1,234,567 of 5,000,000 rows read')).toHaveCount(0)

      await panel.getByRole('button', { name: 'Check again' }).click()
      await expect(panel.getByText('3,000,000 of 5,000,000 rows read · 60%')).toBeVisible()
      await expect(panel.getByText('Usage unavailable.')).toHaveCount(0)
      expect(usage.readings()).toBe(3)
    })
  })
})
