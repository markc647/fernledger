import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// The Budgets page and the Summary's Budget vs actual, against the real Worker. A Budget is for this NZ month, so the test finds
// out which month that is the way the Worker does (Pacific/Auckland) and imports a Transaction dated its first day. The light and
// dark projects share one local database, so each makes a Category and an Account of its own.
const thisMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)
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
      account: { number: projectName === 'dark' ? '99-9999-9999999-51' : '99-9999-9999999-50' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: `${thisMonth}-01`, to: `${thisMonth}-01`, ledgerBalance: { cents: 0, date: `${thisMonth}-01` } },
      rows: [{ date: `${thisMonth}-01`, uniqueId: `BG${stamp}`, tranType: 'EFTPOS', chequeNumber: null, payee: description, bankMemo: 'EFTPOS', amountCents: -4321 }],
    },
  })
  expect(imported.ok()).toBe(true)
  const found = await context.request.get(`/api/transactions?text=${encodeURIComponent(description)}&count=false`)
  const { transactions } = (await found.json()) as { transactions: { id: number }[] }
  const override = await context.request.put(`/api/transactions/${transactions[0]!.id}/override`, { headers, data: { categoryId } })
  expect(override.ok()).toBe(true)
  return { name }
}

const rowFor = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const widgetRow = (page: Page, name: string) => page.getByRole('region', { name: 'Budget vs actual' }).getByRole('row').filter({ hasText: name })

test.describe.configure({ mode: 'serial' })

test('the Admin sets, changes and ends a Budget, the Summary compares it with spending, and the Change Log records each', async ({ page, context, baseURL }, testInfo) => {
  const { name } = await seed(context, baseURL!, testInfo.project.name)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Budgets' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible()
  await expect(page.getByText(`This month is ${monthWords}, in New Zealand time.`)).toBeVisible()
  await expect(page.getByText('Each month stands alone')).toBeVisible()
  await expect(rowFor(page, name)).toContainText('No Budget')

  // WCAG 2.5.3: the button's accessible name contains the text it shows, so voice control can say what it sees.
  const edit = page.getByRole('button', { name: `Edit Budget for ${name}` })
  expect(await edit.getAttribute('aria-label')).toContain((await edit.innerText()).trim())

  // An amount that is not a Budget is explained, not sent.
  await edit.click()
  await expect(page.getByRole('heading', { level: 2, name: `Budget for ${name}` })).toBeVisible()
  await expect(page.getByLabel('Monthly Budget in dollars')).toBeFocused()
  await expect(page.getByLabel('Applies from')).toHaveValue(thisMonth)
  await expect(page.getByRole('button', { name: 'End Budget' })).toHaveCount(0) // there is no Budget to end yet
  await page.getByLabel('Monthly Budget in dollars').fill('0')
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('alert')).toContainText('more than $0')
  await page.getByLabel('Monthly Budget in dollars').fill('$100')
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save Budget' }).click()

  // Focus returns to the button that opened the form, and the message says what happened.
  const message = page.getByRole('status').filter({ hasText: 'now has a Budget' })
  await expect(message).toHaveText(`${name} now has a Budget of $100.00 a month from ${monthWords}.`)
  await expect(page.getByRole('button', { name: `Edit Budget for ${name}` })).toBeFocused()
  await expect(rowFor(page, name)).toContainText('$100.00 a month')
  await expect(rowFor(page, name)).toContainText(`From ${monthWords}: $100.00 a month`)
  await noAxeViolations(page)

  // The Summary: $43.21 spent of $100.00, with the status as an icon and words.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Summary' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Budget vs actual' })).toBeVisible()
  await expect(widgetRow(page, name)).toContainText('$100.00')
  await expect(widgetRow(page, name)).toContainText('$43.21')
  await expect(widgetRow(page, name)).toContainText('Under Budget')
  await expect(widgetRow(page, name)).toContainText('$56.79 left')
  await expect(widgetRow(page, name).locator('svg[aria-hidden="true"]')).toHaveCount(1)
  await expect(widgetRow(page, 'Spending outside Budgets')).toContainText('Not in a Budget')
  await expect(widgetRow(page, 'Uncategorised (includes money in not yet given a Category)')).toContainText('Not in a Budget')
  await noAxeViolations(page)

  // A lower Budget from this month puts the Category over it.
  await page.getByRole('link', { name: 'Set or change Budgets' }).click()
  await page.getByRole('button', { name: `Edit Budget for ${name}` }).click()
  await expect(page.getByLabel('Monthly Budget in dollars')).toHaveValue('100.00')
  await page.getByLabel('Monthly Budget in dollars').fill('40.50')
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'now has a Budget' })).toHaveText(`${name} now has a Budget of $40.50 a month from ${monthWords}.`)
  await page.goto('/')
  await expect(widgetRow(page, name)).toContainText('Over Budget')
  await expect(widgetRow(page, name)).toContainText('$2.71 over')

  // Setting what the month already has changes nothing, and says so.
  await page.goto('/budgets')
  await page.getByRole('button', { name: `Edit Budget for ${name}` }).click()
  await page.getByLabel('Monthly Budget in dollars').fill('40.50')
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'so nothing changed' })).toHaveText(`${name} already has a Budget of $40.50 a month in ${monthWords}, so nothing changed.`)

  // A later change stays when a Budget is set from an earlier month, and the panel says so.
  await page.getByRole('button', { name: `Edit Budget for ${name}` }).click()
  await page.getByLabel('Monthly Budget in dollars').fill('30')
  await page.getByLabel('Applies from').selectOption(nextMonth)
  await page.getByRole('button', { name: 'Save Budget' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'now has a Budget' })).toHaveText(`${name} now has a Budget of $30.00 a month from ${words(nextMonth)}.`)
  await page.getByRole('button', { name: `Edit Budget for ${name}` }).click()
  const panel = page.getByRole('region', { name: `Budget for ${name}` })
  await expect(panel.getByText('This Category already has later changes')).toBeVisible()
  await expect(panel.getByText(`From ${words(nextMonth)}: $30.00 a month`)).toBeVisible()
  await expect(panel.getByText('To have no Budget, use End Budget.')).toBeVisible()
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('button', { name: `Edit Budget for ${name}` })).toBeFocused()

  // Ending it leaves this month with no Budget until its next change; the Summary stops listing the Category.
  await page.getByRole('button', { name: `Edit Budget for ${name}` }).click()
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
  await expect(page.getByText('Only the Admin can change them.')).toBeVisible()
  await expect(rowFor(page, name)).toContainText('$50.00 a month')
  await expect(page.getByRole('button', { name: /Edit Budget/ })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0)
  await noAxeViolations(page)

  // The API says no too, whatever the page shows.
  const refused = await context.request.put(`/api/budgets/${categories.find((c) => c.name === name)!.id}`, { headers, data: { effectiveFrom: thisMonth, amountCents: 1 } })
  expect(refused.status()).toBe(403)
})
