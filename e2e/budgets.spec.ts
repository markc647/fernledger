import type { BrowserContext, Page } from '@playwright/test'
import { thisMonth } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { openHelp } from './help-helpers'
import { transactionId } from './report-helpers'
import { rowButton } from './row-actions-helpers'
import { navigateTo } from './shell-helpers'
import { expectTableLook } from './table-look-helpers'

// The Budgets page and the Summary's Budget vs actual, against the real Worker. A Budget is for this NZ month (`thisMonth`, date-helpers.ts), so the test imports a Transaction dated its
// first day. The light and dark projects share one local database, so each makes a Category and an Account of its own.
const words = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthWords = words(thisMonth)
const nextMonth = (() => {
  const index = Number(thisMonth.slice(0, 4)) * 12 + Number(thisMonth.slice(5, 7))
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
})()

/** A Category with one Transaction of $43.21 this month in it (by Override), and the Category's name. */
async function seed(context: BrowserContext, baseURL: string, projectName: string) {
  await signInAs(context, 'admin')
  const headers = { Origin: baseURL }
  const stamp = `${projectName}${Date.now()}`
  const name = `Budget ${projectName} ${Date.now() % 1_000_000}`
  const category = await context.request.post('/api/categories', { headers, data: { name } })
  expect(category.ok()).toBe(true)
  const { id: categoryId } = (await category.json()) as { id: number }
  const description = `EXAMPLE BUDGETSHOP ${stamp}`
  const imported = await context.request.post('/api/imports/chunks', {
    headers,
    data: {
      account: { number: projectName === 'dark' ? '99-9999-9999999-58' : '99-9999-9999999-57' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: `${thisMonth}-01`, to: `${thisMonth}-01`, ledgerBalance: { cents: 0, date: `${thisMonth}-01` } },
      rows: [{ date: `${thisMonth}-01`, uniqueId: `BG${stamp}`, tranType: 'EFTPOS', chequeNumber: null, payee: description, bankMemo: 'EFTPOS', amountCents: -4321 }],
    },
  })
  expect(imported.ok()).toBe(true)
  const override = await context.request.put(`/api/transactions/${await transactionId(context, description)}/override`, { headers, data: { categoryId } })
  expect(override.ok()).toBe(true)
  return { name }
}

/** A Category's row of the table: not the panel under it or the line that says what saving did, which are rows of one cell and name the Category too. */
const rowFor = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text }).filter({ has: page.locator('td:nth-child(2)') })
/** A Category's one action: its Edit button, named for it. */
const editBudget = (page: Page, category: string) => rowButton(page, 'Edit Budget for', category)
const widgetRow = (page: Page, name: string) => page.getByRole('region', { name: 'Budget vs actual' }).getByRole('row').filter({ hasText: name })

test.describe.configure({ mode: 'serial' })

test('the Admin sets, changes and ends a Budget, the Summary compares it with spending, and the Change Log records each', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.goto('/')
  await navigateTo(page, 'Budgets', 'Set up')
  await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible()
  await expect(page.getByText(`This month is ${monthWords}, in New Zealand time.`)).toBeVisible()
  await expect(page.getByText('Each month stands alone')).toBeHidden() // it is in the page's help sheet, not under the heading
  await expect(await openHelp(page)).toContainText('Each month stands alone')
  await page.keyboard.press('Escape')
  await expect(rowFor(page, name)).toContainText('No Budget')

  await expectTableLook(page.getByRole('table', { name: 'Budgets' }))
  await expect(page.getByRole('columnheader', { name: 'Action', exact: true })).toBeVisible() // one action: a button named for it, under a singular heading
  await expect(page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0)

  // An amount that is not a Budget is explained, not sent.
  await editBudget(page, name).click()
  await expect(page.getByRole('heading', { level: 2, name: `Budget for ${name}` })).toBeVisible()
  // The panel is a row of the table under the Category's own, and the Edit button says it is open.
  await expect(page.getByRole('region', { name: `Budget for ${name}` }).locator('xpath=ancestor::tr[1]/preceding-sibling::tr[1]').getByRole('button', { name: `Edit Budget for ${name}`, exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByLabel('Monthly Budget in dollars')).toBeFocused()
  await expect(page.getByLabel('Applies from')).toHaveValue(thisMonth)
  await expect(page.getByRole('button', { name: 'End Budget' })).toHaveCount(0) // there is no Budget to end yet
  await page.getByLabel('Monthly Budget in dollars').fill('0')
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('alert')).toContainText('more than $0')
  await page.getByLabel('Monthly Budget in dollars').fill('$100')
  // The table becoming cards starts the panel again, and what was typed in it stays.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByLabel('Monthly Budget in dollars')).toHaveValue('$100')
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(page.getByLabel('Monthly Budget in dollars')).toHaveValue('$100')
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save Budget' }).click()

  // Focus returns to the row's Edit button, which opened the form, and the message says what happened.
  const message = page.getByRole('status').filter({ hasText: 'now has a Budget' })
  await expect(message).toHaveText(`${name} now has a Budget of $100.00 a month from ${monthWords}.`)
  await expect(editBudget(page, name)).toBeFocused()
  // It is written under the Category's row too, where the Admin is looking, and the line at the top, which a screen reader announces, is not drawn: it is said once and seen once.
  const under = page.getByRole('table').getByText(`${name} now has a Budget of $100.00 a month from ${monthWords}.`)
  await expect(under).toBeVisible()
  await expect(under.locator('xpath=ancestor::tr[1]/preceding-sibling::tr[1]').getByRole('button', { name: `Edit Budget for ${name}`, exact: true })).toBeVisible()
  await expect(under).not.toBeFocused()
  expect((await message.boundingBox())!.width).toBeLessThanOrEqual(1)
  await expect(rowFor(page, name)).toContainText('$100.00 a month')
  await expect(rowFor(page, name)).toContainText(`From ${monthWords}: $100.00 a month`)
  await noAxeViolations(page)

  // The Dashboard (the Admin's Summary): $43.21 spent of $100.00, with the status as an icon and words.
  await navigateTo(page, 'Dashboard')
  await expect(page.getByRole('heading', { level: 2, name: 'Budget vs actual' })).toBeVisible()
  await expect(widgetRow(page, name)).toContainText('$100.00')
  await expect(widgetRow(page, name)).toContainText('$43.21')
  await expect(widgetRow(page, name)).toContainText('Under Budget')
  await expect(widgetRow(page, name)).toContainText('$56.79 left')
  await expect(widgetRow(page, name).locator('svg[aria-hidden="true"]')).toHaveCount(1)
  await expectTableLook(page.getByRole('region', { name: 'Budget vs actual' }).getByRole('table'), { inCard: true })
  await expect(widgetRow(page, 'Spending outside Budgets')).toContainText('Not in a Budget')
  await expect(widgetRow(page, 'Uncategorised (includes money in not yet given a Category)')).toContainText('Not in a Budget')
  await noAxeViolations(page)

  // A lower Budget from this month puts the Category over it.
  await page.getByRole('link', { name: 'Set or change Budgets' }).click()
  await editBudget(page, name).click()
  await expect(page.getByLabel('Monthly Budget in dollars')).toHaveValue('100.00')
  await page.getByLabel('Monthly Budget in dollars').fill('40.50')
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'now has a Budget' })).toHaveText(`${name} now has a Budget of $40.50 a month from ${monthWords}.`)
  await page.goto('/')
  await expect(widgetRow(page, name)).toContainText('Over Budget')
  await expect(widgetRow(page, name)).toContainText('$2.71 over')

  // Setting what the month already has changes nothing, and says so.
  await page.goto('/budgets')
  await editBudget(page, name).click()
  await page.getByLabel('Monthly Budget in dollars').fill('40.50')
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'so nothing changed' })).toHaveText(`${name} already has a Budget of $40.50 a month in ${monthWords}, so nothing changed.`)

  // A later change stays when a Budget is set from an earlier month, and the panel says so.
  await editBudget(page, name).click()
  await page.getByLabel('Monthly Budget in dollars').fill('30')
  await page.getByLabel('Applies from').selectOption(nextMonth)
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'now has a Budget' })).toHaveText(`${name} now has a Budget of $30.00 a month from ${words(nextMonth)}.`)
  await editBudget(page, name).click()
  const panel = page.getByRole('region', { name: `Budget for ${name}` })
  await expect(panel.getByText('This Category already has later changes')).toBeVisible()
  await expect(panel.getByText(`From ${words(nextMonth)}: $30.00 a month`)).toBeVisible()
  await expect(panel.getByText('To have no Budget, use End Budget.')).toBeVisible()
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(editBudget(page, name)).toBeFocused()

  // Ending it leaves this month with no Budget until its next change; the Summary stops listing the Category.
  await editBudget(page, name).click()
  await page.getByRole('button', { name: 'End Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Ended the Budget' })).toHaveText(`Ended the Budget for ${name} from ${monthWords}.`)
  await expect(rowFor(page, name)).toContainText('No Budget')
  await expect(rowFor(page, name)).toContainText(`since ${monthWords}`)
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Budget vs actual' })).toBeVisible()
  await expect(widgetRow(page, name)).toHaveCount(0)

  // Every change is in the Change Log, in words and dollars, and Members can filter the Log by the new type.
  await page.goto('/change-log')
  await expect(page.getByRole('heading', { name: `Set the Budget for ${name} to $100.00 a month from ${monthWords}` })).toBeVisible()
  const changed = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `Changed the Budget for ${name} from $100.00 to $40.50 a month from ${monthWords}` }) })
  await expect(changed).toContainText('Monthly budget')
  await expect(changed).toContainText('$40.50')
  await expect(page.getByRole('heading', { name: `Ended the Budget for ${name} from ${monthWords}` })).toBeVisible()
  await expect(page.getByLabel('Type').locator('option', { hasText: 'Budget' })).toHaveCount(1)
})

// The Worker's answers are stubbed (worker/budgets.test.ts holds the real ones). Each refusal is a 409, which Chrome logs.
test.describe('a refused Budget', () => {
  test.use({ expectedStatuses: [409] })

  test('says the Budget changed under it, and still says there is no room for another change', async ({ page, context, baseURL }, testInfo) => {
    const { name } = await seed(context, baseURL!, testInfo.project.name)
    let refusal: object = { error: 'This changed while your request was being handled. Try again.', reason: 'changed' }
    await page.route(/\/api\/budgets\/\d+$/, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: refusal }) : route.fallback()))
    await page.goto('/budgets')

    await editBudget(page, name).click()
    await page.getByLabel('Monthly Budget in dollars').fill('$100')
    await page.getByRole('button', { name: 'Save Budget' }).click()
    await expect(page.getByRole('alert')).toHaveText('This Budget was changed just now. Try again.')

    refusal = { error: 'Fernledger keeps at most 600 Budget changes and cannot remove one, so there is no room to add another' }
    await page.getByRole('button', { name: 'Save Budget' }).click()
    await expect(page.getByRole('alert')).toContainText('there is no room to add another')
    await noAxeViolations(page)
    await expect(rowFor(page, name)).toContainText('No Budget')
  })
})

test('a Member sees the Budgets and how spending compares, and cannot change them', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  const headers = { Origin: baseURL! }
  const categories = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  const set = await context.request.put(`/api/budgets/${categories.find((c) => c.name === name)!.id}`, { headers, data: { effectiveFrom: thisMonth, amountCents: 5000 } })
  expect(set.ok()).toBe(true)

  await signInAs(context, 'member')
  await page.goto('/')
  await expect(widgetRow(page, name)).toContainText('$50.00')
  await expect(widgetRow(page, name)).toContainText('Under Budget')
  await expect(widgetRow(page, name)).toContainText('$6.79 left')
  await expect(page.getByRole('link', { name: 'See all Budgets' })).toBeVisible()
  await noAxeViolations(page)

  await page.getByRole('link', { name: 'See all Budgets' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible()
  await expect(await openHelp(page)).toContainText('Only the Admin can change them.') // in the page's help sheet
  await page.keyboard.press('Escape')
  await expect(rowFor(page, name)).toContainText('$50.00 a month')
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: /^Action/ })).toHaveCount(0)
  await noAxeViolations(page)

  // The API says no too, whatever the page shows.
  const refused = await context.request.put(`/api/budgets/${categories.find((c) => c.name === name)!.id}`, { headers, data: { effectiveFrom: thisMonth, amountCents: 1 } })
  expect(refused.status()).toBe(403)
})
