import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

/** The light and dark projects share one local database, so each test imports a Transaction of its own, dated to sort first. */
async function seedTransaction(context: BrowserContext, baseURL: string, projectName: string) {
  await signInAs(context, 'admin')
  const stamp = `${projectName}${Date.now()}`
  const description = `EXAMPLE CATSHOP ${stamp}`
  const res = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL },
    data: {
      account: { number: projectName === 'dark' ? '99-9999-9999999-88' : '99-9999-9999999-89' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-09', to: '2026-10-09', ledgerBalance: { cents: 0, date: '2026-10-09' } },
      rows: [{ date: '2026-10-09', uniqueId: `CT${stamp}`, tranType: 'EFTPOS', chequeNumber: null, payee: description, bankMemo: 'EFTPOS', amountCents: -2345 }],
    },
  })
  expect(res.ok()).toBe(true)
  return description
}

const rowFor = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(text) })

test.describe.configure({ mode: 'serial' })

test('the Admin sets an Override and a Note, the Transaction leaves the Uncategorised list, and the Change Log records it', async ({ page, context, baseURL }, testInfo) => {
  const description = await seedTransaction(context, baseURL!, testInfo.project.name)
  const note = `Receipt in the folder ${testInfo.project.name}`

  await page.goto('/uncategorised')
  await expect(page.getByRole('heading', { level: 1, name: 'Uncategorised' })).toBeVisible()
  await expect(rowFor(page, description)).toContainText('Uncategorised')

  await page.getByRole('button', { name: new RegExp(`^Edit Category and Note for ${description}`) }).click()
  await expect(page.getByLabel('Category', { exact: true })).toBeFocused()
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
  await page.getByLabel('Note', { exact: true }).fill(note)
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByRole('status').filter({ hasText: `Saved ${description}.` })).toBeVisible()
  await expect(rowFor(page, description)).toHaveCount(0)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transactions' }).click()
  const row = rowFor(page, description)
  await expect(row).toContainText('Groceries')
  await expect(row).toContainText('Override')
  await expect(row).toContainText(note)
  await noAxeViolations(page)

  await page.goto('/change-log')
  await expect(page.getByRole('listitem').filter({ hasText: `Set Override on Transaction` }).filter({ hasText: description }).first()).toContainText('Groceries')
  await expect(page.getByRole('listitem').filter({ hasText: 'Added a Note to Transaction' }).filter({ hasText: description }).first()).toContainText(note)
})

test('a Member sees Categories and Notes but cannot change them', async ({ page, context, baseURL }, testInfo) => {
  const description = await seedTransaction(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  const nav = page.getByRole('navigation', { name: 'Main' })

  await page.goto('/transactions')
  await expect(page.getByRole('columnheader', { name: 'Category' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Note' })).toBeVisible()
  await expect(rowFor(page, description)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Uncategorised' })).toHaveCount(0)
  await noAxeViolations(page)

  await nav.getByRole('link', { name: 'Categories' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Groceries', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Rename|Set kind|Remove)/ })).toHaveCount(0)
  await expect(page.getByRole('row', { name: /Wages and salary/ })).toContainText('Income')
  await expect(page.getByRole('row', { name: /^Loans/ })).toContainText('Loans')
  await expect(page.getByRole('row', { name: /^Groceries/ })).toContainText('Spending')
  await expect(page.getByLabel('New Category')).toHaveCount(0)
  await noAxeViolations(page)

  await page.goto('/uncategorised')
  await expect(page.getByText('Only the Admin can use this list.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)
})

test('the Admin adds, renames and removes a Category', async ({ page, context }, testInfo) => {
  await signInAs(context, 'admin')
  const name = `Care ${testInfo.project.name} ${Date.now() % 1000000}`
  const renamed = `${name} costs`
  await page.goto('/categories')
  await expect(page.getByRole('cell', { name: 'Groceries', exact: true })).toBeVisible()

  await page.getByLabel('New Category').fill(name)
  await page.getByRole('button', { name: 'Add Category' }).click()
  await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()

  // The same name again is explained, not silently dropped.
  await page.getByLabel('New Category').fill(name.toUpperCase())
  await page.getByRole('button', { name: 'Add Category' }).click()
  await expect(page.getByRole('alert')).toContainText('already exists')
  await noAxeViolations(page)
  await page.getByLabel('New Category').fill('')

  await page.getByRole('button', { name: `Rename ${name}` }).click()
  await expect(page.getByLabel('Category name')).toBeFocused()
  await page.getByLabel('Category name').fill(renamed)
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Rename ${renamed}` })).toBeFocused()

  await page.getByRole('button', { name: `Remove ${renamed}` }).click()
  await expect(page.getByText(`Remove ${renamed}? Transactions with it as their Override lose that Override and fall back to their Rule or Akahu category, or Uncategorised if neither applies.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused()
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Keep it' }).click()
  await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Remove ${renamed}` })).toBeFocused()

  await page.getByRole('button', { name: `Remove ${renamed}` }).click()
  await page.getByRole('button', { name: `Yes, remove ${renamed}` }).click()
  await expect(page.getByRole('status').filter({ hasText: `Removed ${renamed}.` })).toBeVisible()
  await expect(page.getByRole('cell', { name: renamed, exact: true })).toHaveCount(0)
})

test('the Admin sets the kind of a Category, Members see it, and only a Spending Category has a Budget', async ({ page, context }, testInfo) => {
  await signInAs(context, 'admin')
  const name = `Kind ${testInfo.project.name} ${Date.now() % 1000000}`
  await page.goto('/categories')

  // A new Category is Spending unless the Admin chooses another kind.
  await expect(page.getByLabel('Kind', { exact: true })).toHaveValue('spending')
  await page.getByLabel('New Category').fill(name)
  await page.getByLabel('Kind', { exact: true }).selectOption('loans')
  await expect(page.getByText('Money lent or borrowed. Not spending or income, and has no Budget.')).toBeVisible()
  await page.getByRole('button', { name: 'Add Category' }).click()
  await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()
  await expect(page.getByRole('row', { name })).toContainText('Loans')

  // WCAG 2.5.3: each button's accessible name contains the text it shows.
  const setKind = page.getByRole('button', { name: `Set kind of ${name}` })
  expect(await setKind.getAttribute('aria-label')).toContain((await setKind.innerText()).trim())

  // A Loans Category has no Budget. Making it Spending gives it one to set.
  await page.goto('/budgets')
  await expect(page.getByRole('row', { name })).toHaveCount(0)
  await page.goto('/categories')
  await setKind.click()
  const kind = page.locator('select[id^="kind-"]')
  await expect(kind).toBeFocused()
  await kind.selectOption('spending')
  await expect(page.locator('p[id^="kind-"]')).toContainText('Counts as spending, and can have a Budget.')
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save kind' }).click()
  await expect(page.getByRole('status').filter({ hasText: `${name} is now Spending.` })).toBeVisible()
  await expect(page.getByRole('button', { name: `Set kind of ${name}` })).toBeFocused()
  await expect(page.getByRole('row', { name })).toContainText('Spending')
  await page.goto('/budgets')
  await expect(page.getByRole('button', { name: `Edit Budget for ${name}` })).toBeVisible()

  // And making it Income takes it away again, with its Budgets kept but not used.
  await page.goto('/categories')
  await page.getByRole('button', { name: `Set kind of ${name}` }).click()
  await page.locator('select[id^="kind-"]').selectOption('income')
  await expect(page.getByText('Its Budgets are kept but not used.')).toBeVisible()
  await page.getByRole('button', { name: 'Save kind' }).click()
  await expect(page.getByRole('status').filter({ hasText: `${name} is now Income.` })).toBeVisible()
  await page.goto('/budgets')
  await expect(page.getByRole('row', { name })).toHaveCount(0)

  // The Change Log has each change, with the kind before and after in words.
  await page.goto('/change-log')
  await expect(page.getByRole('heading', { name: `Changed the kind of Category ${name} from Loans to Spending` })).toBeVisible()
  await expect(page.getByRole('heading', { name: `Changed the kind of Category ${name} from Spending to Income` })).toBeVisible()

  // Members see the kind and cannot change it.
  await signInAs(context, 'member')
  await page.goto('/categories')
  await expect(page.getByRole('row', { name })).toContainText('Income')
  await expect(page.getByRole('button', { name: /^Set kind/ })).toHaveCount(0)
})
