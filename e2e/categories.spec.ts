import type { BrowserContext, Locator, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { dateText } from './report-helpers'
import { actionsButton, chooseAction, menuAction, noAxeViolationsFromTop, openActions } from './row-actions-helpers'
import { chooseTextSize, mainNav, navigateTo } from './shell-helpers'

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
  await noAxeViolationsFromTop(page)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByRole('status').filter({ hasText: `Saved ${description}.` })).toBeVisible()
  await expect(rowFor(page, description)).toHaveCount(0)

  await navigateTo(page, 'All Transactions', 'Transactions')
  const row = rowFor(page, description)
  await expect(row).toContainText('Groceries')
  await expect(row).toContainText('Override')
  // The Note is behind a button, not written in the row.
  await expect(row).not.toContainText(note)
  await row.getByRole('button', { name: /^Read the Note on / }).click()
  await expect(page.getByRole('dialog', { name: /^Note on / })).toContainText(note)
  await page.keyboard.press('Escape')
  await noAxeViolationsFromTop(page)

  await page.goto('/change-log')
  await expect(page.getByRole('listitem').filter({ hasText: `Set Override on Transaction` }).filter({ hasText: description }).first()).toContainText('Groceries')
  await expect(page.getByRole('listitem').filter({ hasText: 'Added a Note to Transaction' }).filter({ hasText: description }).first()).toContainText(note)
})

test('a Member sees Categories and Notes but cannot change them', async ({ page, context, baseURL }, testInfo) => {
  const description = await seedTransaction(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  const nav = mainNav(page)

  await page.goto('/transactions')
  await expect(page.getByRole('columnheader', { name: 'Category' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Note' })).toBeVisible()
  await expect(rowFor(page, description)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Uncategorised' })).toHaveCount(0)
  await noAxeViolationsFromTop(page)

  // The sidebar has no Set up group for a Member, but the page is still theirs to read, by its address.
  await expect(nav.getByRole('button', { name: 'Set up' })).toHaveCount(0)
  await page.goto('/categories')
  await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Groceries', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Rename|Select kind|Remove|Actions for)/ })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0)
  await expect(page.getByRole('row', { name: /Wages and salary/ })).toContainText('Income')
  await expect(page.getByRole('row', { name: /^Loans/ })).toContainText('Loans')
  await expect(page.getByRole('row', { name: /^Groceries/ })).toContainText('Spending')
  await expect(page.getByLabel('New Category')).toHaveCount(0)
  await noAxeViolationsFromTop(page)

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
  await noAxeViolationsFromTop(page)
  await page.getByLabel('New Category').fill('')

  await chooseAction(actionsButton(page, name), 'Rename')
  await expect(page.getByLabel('Category name')).toBeFocused()
  await page.getByLabel('Category name').fill(renamed)
  await noAxeViolationsFromTop(page)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
  await expect(actionsButton(page, renamed)).toBeFocused()

  await chooseAction(actionsButton(page, renamed), 'Remove')
  await expect(page.getByText(`Remove ${renamed}? Transactions with it as their Override lose that Override and fall back to their Rule or Akahu category, or Uncategorised if neither applies.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused()
  await noAxeViolationsFromTop(page)
  await page.getByRole('button', { name: 'Keep it' }).click()
  await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
  await expect(actionsButton(page, renamed)).toBeFocused()

  await chooseAction(actionsButton(page, renamed), 'Remove')
  await page.getByRole('button', { name: `Yes, remove ${renamed}` }).click()
  await expect(page.getByRole('status').filter({ hasText: `Removed ${renamed}.` })).toBeVisible()
  await expect(page.getByRole('cell', { name: renamed, exact: true })).toHaveCount(0)
})

// The Worker's answers are stubbed (worker/categories.test.ts holds the real ones), so nothing about Groceries changes. Each refusal is a 409, which Chrome logs.
test.describe('a refused rename or kind', () => {
  test.use({ expectedStatuses: [409] })

  test('says the Category changed under it, and still says a name in use is taken', async ({ page, context }) => {
    await signInAs(context, 'admin')
    const changed = { error: 'This changed while your request was being handled. Try again.', reason: 'changed' }
    let renameRefusal: object = changed
    await page.route(/\/api\/categories\/\d+$/, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 409, json: renameRefusal }) : route.fallback()))
    await page.route(/\/api\/categories\/\d+\/kind$/, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: changed }) : route.fallback()))
    await page.goto('/categories')
    await expect(page.getByRole('cell', { name: 'Groceries', exact: true })).toBeVisible()

    await chooseAction(actionsButton(page, 'Groceries'), 'Rename')
    await page.getByLabel('Category name').fill('Food shopping')
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByRole('alert')).toHaveText('This Category was changed just now. Try again.')
    renameRefusal = { error: 'A Category with that name already exists' }
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByRole('alert')).toHaveText('A Category with that name already exists.')
    await noAxeViolationsFromTop(page)
    await page.getByRole('button', { name: 'Cancel' }).click()

    await chooseAction(actionsButton(page, 'Groceries'), 'Select kind')
    await page.locator('select[id^="kind-"]').selectOption('income')
    await page.getByRole('button', { name: 'Save kind' }).click()
    await expect(page.getByRole('alert')).toHaveText('This Category was changed just now. Try again.')
    await expect(page.getByRole('row', { name: 'Groceries' })).toContainText('Spending')
  })
})

// A Category another page (or a second click) removed first: the answer is the 404 a Category that is not there has, which the page takes as it being gone.
test.describe('a Category removed meanwhile', () => {
  test.use({ expectedStatuses: [404] })

  test('is said to be gone already, and the list is brought up to date', async ({ page, context, baseURL }, testInfo) => {
    await signInAs(context, 'admin')
    const name = `Gone ${testInfo.project.name} ${Date.now() % 1000000}`
    const added = await context.request.post('/api/categories', { headers: { Origin: baseURL! }, data: { name } })
    expect(added.ok()).toBe(true)
    const { id } = (await added.json()) as { id: number }

    await page.goto('/categories')
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
    await chooseAction(actionsButton(page, name), 'Remove')
    expect((await context.request.delete(`/api/categories/${id}`, { headers: { Origin: baseURL! }, data: {} })).ok()).toBe(true) // another page removes it while this one asks
    await page.getByRole('button', { name: `Yes, remove ${name}` }).click()

    await expect(page.getByRole('status').filter({ hasText: 'had already been removed' })).toHaveText(`${name} had already been removed, so nothing was changed. The list is up to date now.`)
    await expect(page.getByRole('cell', { name, exact: true })).toHaveCount(0)
    await noAxeViolationsFromTop(page)
  })
})

test('the Admin sets the kind of a Category, Members see it, and only a Spending Category has a Budget', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const name = `Kind ${testInfo.project.name} ${Date.now() % 1000000}`
  await page.goto('/categories')

  // A new Category is Spending unless the Admin chooses another kind.
  await expect(page.getByLabel('Kind', { exact: true })).toHaveValue('spending')
  await page.getByLabel('New Category').fill(name)
  await page.getByLabel('Kind', { exact: true }).selectOption('loans')
  await expect(page.getByText('Money lent or borrowed. Make one Category for each person, named like Loan – Alice, and give it their Transactions with a Rule or an Override. The Loans Report shows what each owes. Not spending or income, and has no Budget.')).toBeVisible()
  await page.getByRole('button', { name: 'Add Category' }).click()
  await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()
  await expect(page.getByRole('row', { name })).toContainText('Loans')

  const actions = actionsButton(page, name)

  // A Loans Category has no Budget. Making it Spending gives it one to set.
  await page.goto('/budgets')
  await expect(page.getByRole('row', { name })).toHaveCount(0)
  await page.goto('/categories')
  await chooseAction(actions, 'Select kind')
  const kind = page.locator('select[id^="kind-"]')
  await expect(kind).toBeFocused()
  await kind.selectOption('spending')
  await expect(page.locator('p[id^="kind-"]')).toContainText('Counts as spending, and can have a Budget.')
  await noAxeViolationsFromTop(page)
  await page.getByRole('button', { name: 'Save kind' }).click()
  await expect(page.getByRole('status').filter({ hasText: `${name} is now Spending.` })).toBeVisible()
  await expect(actions).toBeFocused()
  await expect(page.getByRole('row', { name })).toContainText('Spending')
  await page.goto('/budgets')
  await expect(page.getByRole('button', { name: `Edit Budget for ${name}` })).toBeVisible()

  // Making it Income takes it away again. With no Budgets there is nothing to say about them; with some, they are kept but not used.
  await page.goto('/categories')
  await chooseAction(actions, 'Select kind')
  await page.locator('select[id^="kind-"]').selectOption('income')
  await expect(page.getByText('A change counts for every month, past ones too.')).toBeVisible()
  await expect(page.getByText('Its Budgets are kept but not used.')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  const categories = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  const budget = await context.request.put(`/api/budgets/${categories.find((c) => c.name === name)!.id}`, { headers: { Origin: baseURL! }, data: { effectiveFrom: '2026-10', amountCents: 1000 } })
  expect(budget.ok()).toBe(true)
  await page.goto('/categories')
  await chooseAction(actions, 'Select kind')
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
  await expect(page.getByRole('button', { name: /^(Select kind|Actions for)/ })).toHaveCount(0)
})

test("a Category's Actions menu opens its form and its question where the old buttons did, and focus comes back to the row's button", async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/categories')
  const actions = actionsButton(page, 'Groceries')
  await expect(actions).toBeVisible()
  await expect(actions).toHaveAttribute('id', /^category-\d+-actions$/)

  // The menu is named for its button, has the three actions with Remove set apart, and Escape closes it and puts focus back on the button.
  await openActions(actions)
  await expect(page.getByRole('menu', { name: 'Actions for Groceries' })).toBeVisible()
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Select kind', 'Remove'])
  await expect(page.getByRole('separator')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(actions).toBeFocused()

  // Each action puts focus where the button it replaces did, and Cancel (or Keep it) brings it back to the row's button.
  await chooseAction(actions, 'Rename')
  await expect(page.getByLabel('Category name')).toBeFocused()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(actions).toBeFocused()

  await chooseAction(actions, 'Select kind')
  await expect(page.locator('select[id^="kind-"]')).toBeFocused()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(actions).toBeFocused()

  await chooseAction(actions, 'Remove')
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused()
  await page.getByRole('button', { name: 'Keep it' }).click()
  await expect(actions).toBeFocused()
  await expect(page.getByRole('cell', { name: 'Groceries', exact: true })).toBeVisible() // nothing was changed

  // With the keyboard alone: Enter opens the menu on its first item, an arrow key and Enter choose.
  await actions.focus()
  await page.keyboard.press('Enter')
  await expect(menuAction(page, 'Rename')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menuAction(page, 'Select kind')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('select[id^="kind-"]')).toBeFocused()
})

// The Categories are stubbed in the order the Worker lists them (by name), so what each sort gives is the same whatever else is in the database. Sorting is in the browser (src/lib/category-sort.ts).
const listed = [
  { id: 4, name: 'Care Fees', kind: 'spending' },
  { id: 1, name: 'Groceries', kind: 'spending' },
  { id: 5, name: 'Interest', kind: 'income' },
  { id: 3, name: 'Loan – Alice', kind: 'loans' },
  { id: 2, name: 'Wages', kind: 'income' },
]
const stubCategories = (page: Page) => page.route(/\/api\/categories$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: listed }) : route.fallback()))
const inTable = (page: Page) => page.getByRole('table', { name: 'Categories' }).locator('tbody tr td:first-child').allInnerTexts()
const inCards = (page: Page) => page.getByRole('list', { name: 'Categories' }).getByRole('listitem').evaluateAll((cards) => cards.map((card) => card.querySelector('dd')!.textContent))

test('the Categories sort by Category and by Kind, in plain words, and the first visit has the order the Worker gives', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await stubCategories(page)
  await page.goto('/categories')
  const byCategory = page.getByRole('columnheader', { name: 'Category' })
  const byKind = page.getByRole('columnheader', { name: 'Kind' })
  const said = (text: string) => expect(page.getByRole('status').filter({ hasText: text })).toHaveText(text)

  // Nothing is sorted at first: the order is the Worker's, and each heading is a button that has not been pressed.
  await expect.poll(() => inTable(page)).toEqual(['Care Fees', 'Groceries', 'Interest', 'Loan – Alice', 'Wages'])
  await expect(byCategory).toHaveAttribute('aria-sort', 'none')
  await expect(byKind).toHaveAttribute('aria-sort', 'none')
  await expect(byCategory.getByRole('button', { name: 'Category' })).toBeVisible()
  await noAxeViolationsFromTop(page)

  await byCategory.getByRole('button').click()
  await expect(byCategory).toHaveAttribute('aria-sort', 'ascending')
  await said('Sorted by Category, A to Z.')
  expect(await inTable(page)).toEqual(['Care Fees', 'Groceries', 'Interest', 'Loan – Alice', 'Wages'])
  await expect(byCategory.getByRole('button')).toBeFocused() // the heading is still where focus is

  await byCategory.getByRole('button').click()
  await expect(byCategory).toHaveAttribute('aria-sort', 'descending')
  await said('Sorted by Category, Z to A.')
  expect(await inTable(page)).toEqual(['Wages', 'Loan – Alice', 'Interest', 'Groceries', 'Care Fees'])

  // By Kind, the words the reader sees (Income, Loans, Spending), and by name within a Kind. The other heading is no longer the sort.
  await byKind.getByRole('button').click()
  await expect(byKind).toHaveAttribute('aria-sort', 'ascending')
  await expect(byCategory).toHaveAttribute('aria-sort', 'none')
  await said('Sorted by Kind, A to Z.')
  expect(await inTable(page)).toEqual(['Interest', 'Wages', 'Loan – Alice', 'Care Fees', 'Groceries'])
  await noAxeViolationsFromTop(page)

  await byKind.getByRole('button').click()
  await expect(byKind).toHaveAttribute('aria-sort', 'descending')
  await said('Sorted by Kind, Z to A.')
  expect(await inTable(page)).toEqual(['Care Fees', 'Groceries', 'Loan – Alice', 'Interest', 'Wages'])

  // It is for this visit only, so the page is as the Worker gives it when it is opened again.
  await page.reload()
  await expect.poll(() => inTable(page)).toEqual(['Care Fees', 'Groceries', 'Interest', 'Loan – Alice', 'Wages'])
  await expect(byKind).toHaveAttribute('aria-sort', 'none')

  // A Member can sort too, and has no Actions column.
  await signInAs(context, 'member')
  await page.goto('/categories')
  await byKind.getByRole('button').click()
  await expect.poll(() => inTable(page)).toEqual(['Interest', 'Wages', 'Loan – Alice', 'Care Fees', 'Groceries'])
  await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the Categories are cards with a Sort by menu, and each card has the same Actions menu, 44px', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubCategories(page)
    await page.goto('/categories')
    await expect(page.getByRole('table')).toHaveCount(0)
    const sortBy = page.getByLabel('Sort by')
    await expect(sortBy).toHaveValue('') // "Not sorted"
    await expect.poll(() => inCards(page)).toEqual(['Care Fees', 'Groceries', 'Interest', 'Loan – Alice', 'Wages'])
    expect(await sortBy.locator('option').allInnerTexts()).toEqual(['Not sorted', 'Category, A to Z', 'Category, Z to A', 'Kind, A to Z', 'Kind, Z to A'])
    await noAxeViolationsFromTop(page)

    await sortBy.selectOption({ label: 'Kind, Z to A' })
    await expect(page.getByRole('status').filter({ hasText: 'Sorted by Kind, Z to A.' })).toBeVisible()
    expect(await inCards(page)).toEqual(['Care Fees', 'Groceries', 'Loan – Alice', 'Interest', 'Wages'])
    await sortBy.selectOption({ label: 'Category, Z to A' })
    expect(await inCards(page)).toEqual(['Wages', 'Loan – Alice', 'Interest', 'Groceries', 'Care Fees'])
    await expect(sortBy.locator('option', { hasText: 'Not sorted' })).toHaveCount(0) // once there is a sort, "Not sorted" is not one of them

    for (const { name } of listed) {
      const box = (await actionsButton(page, name).boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    // The menu of a card does what the table's does, and a form that it opens fits the card.
    await chooseAction(actionsButton(page, 'Groceries'), 'Rename')
    await expect(page.getByLabel('Category name')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await noAxeViolationsFromTop(page)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(actionsButton(page, 'Groceries')).toBeFocused()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The Note column of All Transactions and Uncategorised (src/components/transaction-list.tsx): a button that opens the Note, not the Note's words

/** Two Uncategorised Transactions in the project's Account, dated to sort first, the first with the Note `noteFor(stamp)`. The stamp finds them, and is in the Note so a search can. */
async function seedWithNote(context: BrowserContext, baseURL: string, projectName: string, noteFor: (stamp: string) => string) {
  await signInAs(context, 'admin')
  const stamp = `${projectName}${Date.now()}`
  const noted = `EXAMPLE NOTESHOP ${stamp} A`
  const plain = `EXAMPLE NOTESHOP ${stamp} B`
  const row = (uniqueId: string, payee: string, amountCents: number) => ({ date: '2026-10-09', uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee, bankMemo: 'EFTPOS', amountCents })
  const imported = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL },
    data: {
      account: { number: projectName === 'dark' ? '99-9999-9999999-88' : '99-9999-9999999-89' },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 2, skipped: 0, from: '2026-10-09', to: '2026-10-09', ledgerBalance: { cents: 0, date: '2026-10-09' } },
      rows: [row(`NA${stamp}`, noted, -2345), row(`NB${stamp}`, plain, -1100)],
    },
  })
  expect(imported.ok()).toBe(true)
  const found = (await (await context.request.get(`/api/transactions?q=${encodeURIComponent(stamp)}`)).json()) as { transactions: { id: number; description: string }[] }
  const note = noteFor(stamp)
  const saved = await context.request.put(`/api/transactions/${found.transactions.find((t) => t.description === noted)!.id}/note`, { headers: { Origin: baseURL }, data: { note } })
  expect(saved.ok()).toBe(true)
  return { stamp, noted, plain, note }
}

const noteButton = (scope: Page | Locator) => scope.getByRole('button', { name: /^Read the Note on / })
const notePopup = (page: Page, description: string) => page.getByRole('dialog', { name: `Note on ${description}` })
const dataRows = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('cell') })

test('a Note is a button that opens it, in All Transactions and in Uncategorised, and a row without a Note shows nothing', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, noted, plain, note } = await seedWithNote(context, baseURL!, testInfo.project.name, (stamp) => `Receipt in the top drawer ${stamp}`)

  for (const [path, heading] of [[`/transactions?q=${stamp}`, 'Transactions'], ['/uncategorised', 'Uncategorised']] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    const row = rowFor(page, noted)
    await expect(row).toBeVisible()
    await expect(rowFor(page, plain)).toBeVisible()

    // The Note's words are not in the page; its row has a button named for the row, and the row without a Note has none.
    await expect(page.getByText(note)).toHaveCount(0)
    await expect(noteButton(rowFor(page, plain))).toHaveCount(0)
    const button = noteButton(row)
    await expect(button).toHaveAccessibleName(`Read the Note on ${noted}, ${dateText('2026-10-09')}`)
    const box = (await button.boundingBox())!
    expect(box.width, `${heading}: the button is 44px wide`).toBeGreaterThanOrEqual(44)
    expect(box.height, `${heading}: the button is 44px tall`).toBeGreaterThanOrEqual(44)

    // It opens beside the button, ending where the button does, with the Note in it and focus in it.
    await button.click()
    const popup = notePopup(page, noted)
    await expect(popup).toHaveText(note)
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(popup).toBeFocused()
    const opened = (await popup.boundingBox())!
    expect(Math.abs(opened.x + opened.width - (box.x + box.width)), `${heading}: the pop-up ends where its button does`).toBeLessThanOrEqual(1)
    await noAxeViolationsFromTop(page)

    // Escape, a press outside it, and the keyboard each close it and leave focus on the button.
    await page.keyboard.press('Escape')
    await expect(popup).toBeHidden()
    await expect(button).toBeFocused()
    await button.click()
    await expect(popup).toBeVisible()
    await page.getByRole('heading', { level: 1, name: heading }).click()
    await expect(popup).toBeHidden()
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(popup).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popup).toBeHidden()
    await expect(button).toBeFocused()
  }

  // Searching still finds the Note's words, though the list no longer writes them.
  await page.goto('/transactions')
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill(note)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(1)
  await expect(noteButton(rowFor(page, noted))).toBeVisible()

  // The column is no wider than its heading and the button (about 4.25rem), at any text size, so it is never wider than 5.5rem.
  for (const size of ['Small', 'Medium', 'Large'] as const) {
    await chooseTextSize(page, size)
    const root = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
    const column = (await page.getByRole('columnheader', { name: 'Note' }).boundingBox())!
    expect(column.width, `the Note column at ${size}`).toBeLessThanOrEqual(5.5 * root)
  }
})

test('in Windows high contrast the Note button and its pop-up are drawn with borders', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, noted } = await seedWithNote(context, baseURL!, testInfo.project.name, (stamp) => `Receipt in the top drawer ${stamp}`)
  await page.emulateMedia({ forcedColors: 'active' }) // the reader's palette replaces the app's colours: a fill or shadow is dropped, a border and a stroke are not
  await page.goto(`/transactions?q=${stamp}`)
  const button = noteButton(rowFor(page, noted))
  await button.click()
  const popup = notePopup(page, noted)
  await expect(popup).toBeVisible()
  const drawn = (element: Locator) =>
    element.evaluate((el) => {
      const style = getComputedStyle(el)
      return { width: parseFloat(style.borderTopWidth), style: style.borderTopStyle, colour: style.borderTopColor }
    })
  for (const [name, element] of [['button', button], ['pop-up', popup]] as const) {
    const border = await drawn(element)
    expect(border.width, `the ${name} has a border`).toBeGreaterThanOrEqual(1)
    expect(border.style, `the ${name}'s border is a line`).toBe('solid')
    expect(border.colour, `the ${name}'s border has a colour`).not.toBe('rgba(0, 0, 0, 0)')
  }
  expect(await button.locator('svg').evaluate((icon) => getComputedStyle(icon).stroke), 'the icon is drawn with a stroke').not.toBe('none')
})

test.describe('on a phone, a Note', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('is a 44px button on its card, opens inside the screen even when it is one long word, and a card without one has no Note line', async ({ page, context, baseURL }, testInfo) => {
    const { stamp, noted, plain, note } = await seedWithNote(context, baseURL!, testInfo.project.name, (stamp) => `${'Receipt'.repeat(14)} ${stamp}`)
    await page.goto(`/transactions?q=${stamp}`)
    await expect(page.getByRole('table')).toHaveCount(0) // cards
    const card = page.getByRole('listitem').filter({ hasText: noted })
    const plainCard = page.getByRole('listitem').filter({ hasText: plain })
    await expect(plainCard).toBeVisible()
    await expect(plainCard.getByText('Note', { exact: true })).toHaveCount(0)
    await expect(noteButton(plainCard)).toHaveCount(0)
    await expect(card.getByText('Note', { exact: true })).toBeVisible()
    await expect(page.getByText(note)).toHaveCount(0)

    for (const size of ['Medium', 'Large'] as const) {
      await chooseTextSize(page, size)
      const button = noteButton(card)
      const box = (await button.boundingBox())!
      expect(box.width, `${size}: the button is 44px wide`).toBeGreaterThanOrEqual(44)
      expect(box.height, `${size}: the button is 44px tall`).toBeGreaterThanOrEqual(44)
      await button.tap()
      const popup = notePopup(page, noted)
      await expect(popup).toHaveText(note)
      const opened = (await popup.boundingBox())!
      expect(opened.x, `${size}: its left edge is on the screen`).toBeGreaterThanOrEqual(0)
      expect(opened.x + opened.width, `${size}: its right edge is on the screen`).toBeLessThanOrEqual(390)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${size}: no sideways scrolling`).toBe(true)
      await page.keyboard.press('Escape')
      await expect(popup).toBeHidden()
      await expect(button).toBeFocused()
    }
  })
})
