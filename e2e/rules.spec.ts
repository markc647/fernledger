import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// The light and dark projects share one local database, so each test uses text and an Account of its own, no earlier run used
// and no other spec uses (the Summary spec has 86 and 87, Categories 88 and 89, the Change Log 90 and 91).
const accountFor = (projectName: string) => (projectName === 'dark' ? '99-9999-9999999-92' : '99-9999-9999999-93')

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

async function categoryId(context: BrowserContext, name: string) {
  const categories = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  return categories.find((c) => c.name === name)!.id
}

async function addRule(context: BrowserContext, baseURL: string, body: Record<string, unknown>) {
  const res = await context.request.post('/api/rules', { headers: { Origin: baseURL }, data: body })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { id: number }).id
}

const removeRule = async (context: BrowserContext, baseURL: string, id: number) =>
  expect((await context.request.delete(`/api/rules/${id}`, { headers: { Origin: baseURL }, data: {} })).ok()).toBe(true)

const ruleIds = async (context: BrowserContext) => ((await (await context.request.get('/api/rules')).json()) as { id: number }[]).map((r) => r.id)

const rowFor = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(text) })

test.describe.configure({ mode: 'serial' })

test('the Admin checks how many Transactions a Rule matches, saves it, and new Transactions are put in its Category', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const shop = `EXAMPLE RULESHOP ${stamp}`
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} OLD`, `RA${stamp}`)

  await page.goto('/rules')
  await expect(page.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible()
  await expect(page.getByText('does not change the Transactions you already have')).toBeVisible()
  await page.getByRole('button', { name: 'Add a Rule' }).click()
  await expect(page.getByLabel('Text contains')).toBeFocused()

  // The Rule can't be saved before the Admin has seen what it matches.
  await page.getByLabel('Text contains').fill(shop.toLowerCase())
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
  await page.getByRole('button', { name: 'Check how many match' }).click()
  const result = page.getByRole('status').filter({ hasText: 'you already have' })
  await expect(result).toContainText('1 Transaction you already have matches.')
  await expect(result).toContainText("Saving the Rule won't change it")
  await expect(result).toContainText(`${shop} OLD`)
  await expect(result).toContainText('type EFTPOS') // the bank's type, which a Rule can match on and the Transactions list does not show

  // Changing what it looks for takes the result away, and the Rule has to be checked again.
  await page.getByLabel('Text contains').fill(`${shop} OLD`)
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
  await expect(page.getByText('You have changed what the Rule looks for')).toBeVisible()
  await page.getByLabel('Text contains').fill(shop.toLowerCase())
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(result).toContainText('1 Transaction you already have matches.')

  await page.getByLabel('What the Rule does').selectOption({ label: 'Put in the Category Groceries' })
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save Rule' }).click()

  const saved = page.getByRole('status').filter({ hasText: 'Added the Rule.' })
  await expect(saved).toContainText('used for new Transactions as they are imported')
  await expect(saved).toContainText('applying Rules to those will come in a later update')
  await expect(page.getByRole('button', { name: 'Add a Rule' })).toBeFocused()
  const row = rowFor(page, shop.toLowerCase())
  await expect(row).toContainText(`Text contains “${shop.toLowerCase()}”`)
  await expect(row).toContainText('Category: Groceries')
  await noAxeViolations(page)

  // A Transaction imported now is put in Groceries by the Rule; the one on file from before is not.
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} NEW`, `RB${stamp}`)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transactions' }).click()
  const added = rowFor(page, `${shop} NEW`)
  await expect(added).toContainText('Groceries')
  await expect(added).toContainText('Rule')
  await expect(rowFor(page, `${shop} OLD`)).toContainText('Uncategorised')

  await page.goto('/change-log')
  await expect(page.getByRole('listitem').filter({ hasText: 'Added a Rule: text contains' }).filter({ hasText: shop.toLowerCase() }).first()).toContainText('Rule change by admin@example.com')

  // Remove it again so that no other test is affected. The Transaction keeps the Category the Rule gave it.
  await page.goto('/rules')
  await page.getByRole('button', { name: /^Remove Rule \d+$/ }).last().click()
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

    // WCAG 2.5.3: each button's accessible name contains the text it shows, so voice control can say what it sees.
    for (const action of ['up', 'down', 'edit', 'remove']) {
      const button = page.locator(`#rule-${second}-${action}`)
      expect(await button.getAttribute('aria-label')).toContain((await button.innerText()).trim())
    }

    // Move the first Rule down: it lands after the second, so Move down is no longer possible and focus stays on its other button.
    const moveDown = page.locator(`#rule-${first}-down`)
    await moveDown.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: /^Moved Rule \d+ down/ })).toBeVisible()
    await expect(page.locator(`#rule-${first}-up`)).toBeFocused()
    expect((await ruleIds(context)).filter((id) => id === first || id === second)).toEqual([second, first])

    // Edit the second: the amount range changes, and it needs no new check while the text, type and amounts are as they were.
    await page.locator(`#rule-${second}-edit`).click()
    await expect(page.getByLabel('Text contains')).toHaveValue(`EXAMPLE TWO ${stamp}`)
    await expect(page.getByLabel('Amount from ($)')).toHaveValue('10.00')
    await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
    await expect(page.getByText('It takes effect when Transfer pairing ships')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save Rule' })).toBeEnabled()
    await noAxeViolations(page)
    await page.getByRole('button', { name: 'Save Rule' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved the changes to the Rule.' })).toBeVisible()
    await expect(page.locator(`#rule-${second}-edit`)).toBeFocused()
    await expect(rowFor(page, `EXAMPLE TWO ${stamp}`)).toContainText('Mark as a Transfer')
    await noAxeViolations(page)
  } finally {
    await removeRule(context, baseURL!, first)
    await removeRule(context, baseURL!, second)
  }
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
  await page.getByLabel('Text contains').fill('first')
  await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
  const check = page.getByRole('button', { name: 'Check how many match' })
  await check.click()
  await expect(check).toBeDisabled() // the check is out

  await page.getByLabel('Text contains').fill('second')
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
  await expect(page.getByLabel('Text contains')).toBeFocused()
  await expect(page.getByLabel('Text contains')).toHaveAttribute('aria-invalid', 'true')
  await noAxeViolations(page)

  await page.getByLabel('Text contains').fill('example')
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

test('a Member does not see the Rules page, and the API refuses their changes', async ({ page, context, baseURL }) => {
  await signInAs(context, 'member')
  await page.goto('/rules')
  await expect(page.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible()
  await expect(page.getByText('Only the Admin can use this page.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add a Rule' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transactions' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Rules' })).toHaveCount(0)
  await noAxeViolations(page)

  const refused = await context.request.post('/api/rules', { headers: { Origin: baseURL! }, data: { textContains: 'example', transfer: true } })
  expect(refused.status()).toBe(403)
})
