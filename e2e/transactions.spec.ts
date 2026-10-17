import type { BrowserContext, Locator, Page } from '@playwright/test'
import { clearDate, dateField, expectDate, pickDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { dateText } from './report-helpers'
import { noAxeViolationsFromTop, rowButton } from './row-actions-helpers'
import { focusIndicator, siteHeader } from './shell-helpers'
import { expectTableLook } from './table-look-helpers'

// The light and dark projects share one local database, so each project has Accounts of its own, and each test finds its
// own Transactions by a stamp in their descriptions. Dated in 2012, older than any other spec's, so they never push those off the first page of the list.
const accountsFor = (project: string) => ({
  savings: { number: project === 'dark' ? '99-9999-9999999-70' : '99-9999-9999999-72', name: `Search savings ${project}` },
  cheque: { number: project === 'dark' ? '99-9999-9999999-71' : '99-9999-9999999-73', name: `Search cheque ${project}` },
})

type Seed = { account: { number: string; name: string }; rows: { date: string; description: string; amountCents: number; chequeNumber?: string }[] }

async function seed(context: BrowserContext, baseURL: string, batches: Seed[]) {
  await signInAs(context, 'admin')
  for (const { account, rows } of batches) {
    const res = await context.request.post('/api/imports/chunks', {
      headers: { Origin: baseURL },
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2012-01-01', to: '2012-12-31', ledgerBalance: { cents: 0, date: '2012-12-31' } },
        rows: rows.map((r, i) => ({ date: r.date, uniqueId: `${r.description.replaceAll(' ', '')}${i}`, tranType: 'EFTPOS', chequeNumber: r.chequeNumber ?? null, payee: r.description, bankMemo: 'EFTPOS', amountCents: r.amountCents })),
      },
    })
    expect(res.ok()).toBe(true)
  }
}

/** Four Transactions in two Accounts, with a stamp no other test uses. */
async function seedFour(context: BrowserContext, baseURL: string, project: string) {
  const { savings, cheque } = accountsFor(project)
  const stamp = `${project}${Date.now()}`
  const names = {
    cafeOne: `EXAMPLE CAFE ${stamp} ONE`,
    cafeTwo: `EXAMPLE CAFE ${stamp} TWO`,
    hardware: `EXAMPLE HARDWARE ${stamp}`,
    wages: `EXAMPLE WAGES ${stamp}`,
  }
  await seed(context, baseURL, [
    { account: savings, rows: [{ date: '2012-10-08', description: names.cafeOne, amountCents: -1500 }, { date: '2012-10-01', description: names.hardware, amountCents: -9000 }] },
    { account: cheque, rows: [{ date: '2012-09-20', description: names.cafeTwo, amountCents: -2500 }, { date: '2012-10-02', description: names.wages, amountCents: 50000 }] },
  ])
  return { stamp, names, savings, cheque }
}

const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search', exact: true })
const searchFor = async (page: Page, text: string) => {
  await searchBox(page).fill(text)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
}
const dataRows = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('cell') })

/**
 * Waits until a Transaction's details have replaced the list, and returns the part of the page that is the details.
 * A heading name matches as a substring, so "Transaction" alone is also found in the list's "Transactions" heading, and a
 * test that clicks straight away then races the navigation (slower on CI). Every row of the Admin's list has an "Edit …" button too, so the buttons are looked for inside the details only.
 */
const detailsOpened = async (page: Page) => {
  await expect(page).toHaveURL(/\/transactions\/\d+/)
  await expect(page.getByRole('heading', { level: 1, name: 'Transaction', exact: true })).toBeVisible()
  const details = page.getByRole('main').filter({ has: page.getByRole('region', { name: 'Summary' }) })
  await expect(details).toBeVisible()
  return details
}

test.describe.configure({ mode: 'serial' })

test('a Member finds Transactions by text, Account, Category and dates, and the search is in the address', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, names, savings } = await seedFour(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/transactions')
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()

  // Text: matches the description, whatever the capitals.
  await searchFor(page, stamp.toUpperCase())
  await expect(dataRows(page)).toHaveCount(4)
  await expect(page).toHaveURL(new RegExp(`q=${stamp}`, 'i'))
  await expect(page.getByRole('status').filter({ hasText: 'of 4 matching' })).toBeVisible()
  await expectTableLook(page.getByRole('table', { name: 'Transactions matching the search' }))
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0) // a Member has nothing to change
  await expect(page.getByRole('columnheader', { name: /^Action/ })).toHaveCount(0)
  await noAxeViolations(page)

  // Account.
  await page.getByLabel('Account', { exact: true }).selectOption({ label: savings.name })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(2)
  await expect(page.getByRole('link', { name: names.cafeTwo })).toHaveCount(0)

  // Dates, both ends included: the first of October is out of this range, the eighth is in.
  await pickDate(page, 'From', '2012-10-02')
  await pickDate(page, 'To', '2012-10-08')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(1)
  await expect(page.getByRole('link', { name: names.cafeOne })).toBeVisible()

  // Category: nothing has one, so "Uncategorised" keeps it and a Category drops it.
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Uncategorised' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(1)
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText('No Transactions match these filters.')).toBeVisible()
  await noAxeViolations(page)

  // The search is in the address: it survives a reload, and Back steps out of it one search at a time.
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Uncategorised' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(1)
  await page.reload()
  await expect(dataRows(page)).toHaveCount(1)
  await expect(searchBox(page)).toHaveValue(stamp.toUpperCase())
  await expect(page.getByLabel('Account', { exact: true })).toHaveValue(/\d+/)
  await expectDate(page, 'From', '2012-10-02')
  await page.goBack()
  await expect(page.getByText('No Transactions match these filters.')).toBeVisible()

  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(searchBox(page)).toHaveValue('')
  await expect(page).not.toHaveURL(/q=/)
  await expect(page.getByLabel('Account', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Category', { exact: true })).toHaveValue('')
  await expectDate(page, 'From', '')
  // Everything is listed again, not only what matched.
  await expect(page.getByRole('status').filter({ hasText: 'Showing' })).not.toContainText('matching')
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0)
})

test('a search with % or _ in it finds those characters, not everything', async ({ page, context, baseURL }, testInfo) => {
  const { stamp } = await seedFour(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/transactions')
  await searchFor(page, `${stamp} %`)
  await expect(page.getByText('No Transactions match these filters.')).toBeVisible()
  await searchFor(page, `${stamp}`)
  await expect(dataRows(page)).toHaveCount(4)
})

test('a range that ends before it starts is explained and not searched', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/transactions')
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
  await pickDate(page, 'From', '2012-10-09')
  await pickDate(page, 'To', '2012-10-08')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('before the “From” date')
  await expect(dateField(page, 'To')).toHaveAttribute('aria-invalid', 'true')
  await expect(page).not.toHaveURL(/from=/)
  await noAxeViolations(page)

  // An address typed by hand with the same mistake gets the same explanation, not a list.
  await page.goto('/transactions?from=2012-10-09&to=2012-10-08')
  await expect(page.getByRole('alert')).toContainText('before the “From” date')
})

test('an address naming no such Account or Category says so, and one with blank or unknown parts still shows the list', async ({ page, context }) => {
  await signInAs(context, 'member')
  for (const [address, name] of [
    ['/transactions?account=abc', 'Account'],
    ['/transactions?account=0', 'Account'],
    ['/transactions?account=999999999', 'Account'],
    ['/transactions?category=abc', 'Category'],
    ['/transactions?category=999999999', 'Category'],
  ] as const) {
    await page.goto(address)
    await expect(page.getByRole('alert'), address).toHaveText(`There is no such ${name}. Choose one in the form above.`)
  }
  await noAxeViolations(page)

  // The form shows every Account (or Category) for one that isn't an ID, and Search goes there rather than back to the alert.
  for (const [address, key] of [
    ['/transactions?account=abc', 'account'],
    ['/transactions?category=abc', 'category'],
  ] as const) {
    await page.goto(address)
    await expect(page.getByRole('alert'), address).toBeVisible()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page, address).not.toHaveURL(new RegExp(`${key}=`))
    await expect(page.getByRole('status').filter({ hasText: /^(Showing|There are no Transactions yet)/ }), address).toBeVisible()
    await expect(page.getByRole('alert'), address).toHaveCount(0)
  }

  // Back to no such Account from a search that matched shows the explanation again, not that search's list.
  await page.goto('/transactions?account=999999999')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByLabel('Account', { exact: true }).selectOption({ label: 'All Accounts' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: /^(Showing|There are no Transactions yet)/ })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('alert')).toHaveText('There is no such Account. Choose one in the form above.')
  await expect(page.getByRole('status').filter({ hasText: /^Showing/ })).toHaveCount(0)

  // Blank and unknown parts are left out, so the API is never asked with them (it would refuse the unknown ones).
  await page.goto('/transactions?account=&category=&transfers=both&from=&to=2012-13-01&q=&sort=x&dir=up&page=0')
  await expect(page.getByRole('status').filter({ hasText: /^(Showing|There are no Transactions yet)/ })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Transactions sort by a column heading on a wide screen and from a menu on a narrow one', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, names } = await seedFour(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(`/transactions?q=${stamp}`)
  await expect(dataRows(page)).toHaveCount(4)
  const amountHeading = page.getByRole('columnheader', { name: 'Amount' })
  const first = () => dataRows(page).first()

  // Newest first to begin with.
  await expect(page.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'descending')
  await expect(first()).toContainText(names.cafeOne)

  await amountHeading.getByRole('button').click()
  await expect(amountHeading).toHaveAttribute('aria-sort', 'ascending')
  await expect(first()).toContainText(names.hardware) // the largest money out
  await expect(page).toHaveURL(/sort=amount/)
  await expect(page.getByRole('status').filter({ hasText: 'sorted by Amount, largest money out first' })).toBeVisible()
  await amountHeading.getByRole('button').click()
  await expect(amountHeading).toHaveAttribute('aria-sort', 'descending')
  await expect(first()).toContainText(names.wages)
  await noAxeViolations(page)

  // A narrow screen has cards and no headings, so the same choice is a menu.
  await page.setViewportSize({ width: 390, height: 844 })
  const menu = page.getByLabel('Sort by')
  await expect(menu).toHaveValue('amount:descending')
  await menu.selectOption({ label: 'Date, oldest first' })
  await expect(page).toHaveURL(/dir=asc/)
  await expect(page.getByRole('list', { name: 'Transactions matching the search' }).getByRole('listitem').first()).toContainText(names.cafeTwo)
  await noAxeViolations(page)
})

test('Transactions are paged, a page at a time, and the page is in the address', async ({ page, context, baseURL }, testInfo) => {
  const { savings } = accountsFor(testInfo.project.name)
  const stamp = `pager${testInfo.project.name}${Date.now()}`
  await seed(context, baseURL!, [
    {
      account: savings,
      rows: Array.from({ length: 60 }, (_, i) => ({ date: `2012-03-${String((i % 28) + 1).padStart(2, '0')}`, description: `EXAMPLE PAGER ${stamp} ${String(i).padStart(2, '0')}`, amountCents: -100 - i })),
    },
  ])
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}`)

  const summary = page.getByRole('status').filter({ hasText: 'Showing' })
  await expect(summary).toContainText('Showing 1 to 50 of 60')
  await expect(dataRows(page)).toHaveCount(50)
  await expect(page.getByText('Page 1 of 2')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled()

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(summary).toContainText('Showing 51 to 60 of 60')
  await expect(dataRows(page)).toHaveCount(10)
  await expect(page).toHaveURL(/page=2/)
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled()
  // The press that left Next disabled moved focus to the line announcing the new page.
  await expect(summary).toBeFocused()
  await noAxeViolations(page)

  await page.reload()
  await expect(summary).toContainText('Showing 51 to 60 of 60')
  await page.goBack()
  await expect(summary).toContainText('Showing 1 to 50 of 60')

  // A page past the end goes to the last one that has Transactions.
  await page.goto(`/transactions?q=${stamp}&page=99`)
  await expect(summary).toContainText('Showing 51 to 60 of 60')

  // Changing the order starts again at the first page.
  await page.getByRole('columnheader', { name: 'Amount' }).getByRole('button').click()
  await expect(summary).toContainText('Showing 1 to 50 of 60')
  await expect(page).not.toHaveURL(/page=/)
})

test('a Transaction opens to show its details, and Back returns to the same search', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, names, savings } = await seedFour(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}`)
  await page.getByRole('link', { name: names.cafeOne }).click()

  await detailsOpened(page)
  const summary = page.getByRole('region', { name: 'Summary' })
  await expect(summary).toContainText('Mon 8 Oct 2012')
  await expect(summary).toContainText(names.cafeOne)
  await expect(summary).toContainText(savings.name)
  await expect(summary).toContainText('−$15.00')
  await expect(summary).not.toContainText('Money out') // the sign says it
  await expect(summary).toContainText('Uncategorised')
  await expect(summary).toContainText('No Note')
  const bank = page.getByRole('region', { name: 'From the bank' })
  await expect(bank).toContainText('Imported from a bank file')
  await expect(bank).toContainText('EFTPOS')
  await expect(bank.getByText('Bank memo')).toBeVisible()
  // A bank file has no time of day and none of the Sync fields, and the page makes none up.
  await expect(bank.getByText('Bank Time')).toHaveCount(0)
  await expect(bank).toContainText("Akahu hasn't reported this Transaction, so there is no first-seen time")
  await expect(bank).toContainText('A bank file doesn\'t include the counterparty account')
  // A Member can read it and not change it.
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)
  await noAxeViolations(page)

  await page.getByRole('link', { name: 'Back to Transactions' }).click()
  await expect(page).toHaveURL(new RegExp(`/transactions\\?q=${stamp}`))
  await expect(searchBox(page)).toHaveValue(stamp)
  await expect(dataRows(page)).toHaveCount(4)
})

test("an Import's cheque number is labelled as one and does not hide the explanation of what a bank file lacks", async ({ page, context, baseURL }, testInfo) => {
  const { savings } = accountsFor(testInfo.project.name)
  const stamp = `cheque${testInfo.project.name}${Date.now()}`
  const description = `EXAMPLE CHEQUE ${stamp}`
  await seed(context, baseURL!, [{ account: savings, rows: [{ date: '2012-08-01', description, amountCents: -4500, chequeNumber: '000123' }] }])
  await signInAs(context, 'member')
  await page.goto('/transactions')

  await searchFor(page, stamp)
  await expect(dataRows(page)).toHaveCount(1)
  await page.getByRole('link', { name: description }).click()
  const bank = page.getByRole('region', { name: 'From the bank' })
  await expect(bank).toContainText('Cheque number')
  await expect(bank).toContainText('000123')
  await expect(bank.getByText('Reference', { exact: true })).toHaveCount(0)
  await expect(bank).toContainText("A bank file doesn't include the counterparty account")
  await expect(bank).toContainText("Akahu hasn't reported this Transaction, so there is no first-seen time")
  await noAxeViolations(page)

  // The cheque number can be searched for.
  await page.getByRole('link', { name: 'Back to Transactions' }).click()
  await searchFor(page, '000123')
  await expect(page.getByRole('link', { name: description })).toBeVisible()
})

test('typed filters say they are not applied until Search is pressed', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/transactions')
  const hint = 'Press Search to apply these filters.'
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
  await expect(page.getByText(hint)).toHaveCount(0)

  await searchBox(page).fill('cafe')
  await expect(page.getByText(hint)).toBeVisible()
  await noAxeViolations(page)

  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText(hint)).toHaveCount(0)
  await pickDate(page, 'From', '2012-10-02')
  await expect(page.getByText(hint)).toBeVisible()
  await clearDate(page, 'From')
  await expect(page.getByText(hint)).toHaveCount(0)
})

test('the filters have Search and Clear filters but no Download CSV or count of matches, which are on the Export page', async ({ page, context, baseURL }, testInfo) => {
  const { stamp } = await seedFour(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}`)
  await expect(dataRows(page)).toHaveCount(4) // the page has its data, so what is not on it could have been
  const filters = page.getByRole('search', { name: 'Search Transactions' })
  await expect(searchBox(page)).toBeVisible()
  for (const label of ['Account', 'Category', 'Transfers']) await expect(filters.getByLabel(label, { exact: true })).toBeVisible()
  for (const label of ['From', 'To']) await expect(dateField(filters, label)).toBeVisible()
  await expect(filters.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
  await expect(filters.getByRole('button', { name: 'Clear filters' })).toBeVisible()
  await expect(page.getByText('Download CSV')).toHaveCount(0) // not the button, not its explanation
  await expect(page.locator('#filter-download-count')).toHaveCount(0)
  await expect(filters.getByRole('link')).toHaveCount(0)
})

test('Back from a Transaction opened on the Uncategorised page returns to the Uncategorised page, in the same order', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const row = { id: 4242, accountId: 1, accountName: 'Example savings', date: '2026-10-08', description: 'EXAMPLE CAFE TOWN', bankType: 'EFTPOS', amountCents: -2345, categoryId: null, categoryName: null, categorySource: null, note: null }
  const detail = { ...row, bankMemo: '', bankReference: null, bankCounterpartyAccount: null, bankCardSuffix: null, bankParticulars: null, bankPaymentCode: null, source: 'import', bankTime: null, firstSeenAt: null }
  await page.route(/\/api\/transactions\?/, (route) => {
    const countOnly = new URL(route.request().url()).searchParams.get('count') === 'only'
    return route.fulfill({ json: countOnly ? { total: 1, transactions: [] } : { total: null, transactions: [row] } })
  })
  await page.route('**/api/transactions/4242', (route) => route.fulfill({ json: detail }))

  await page.goto('/uncategorised?sort=amount')
  await page.getByRole('link', { name: 'EXAMPLE CAFE TOWN' }).click()
  await detailsOpened(page)
  await page.getByRole('link', { name: 'Back to Uncategorised' }).click()

  await expect(page).toHaveURL(/\/uncategorised\?sort=amount$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Uncategorised' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Amount' })).toHaveAttribute('aria-sort', 'ascending')
})

// The Uncategorised list is stubbed, so which Transactions are in it, and what leaves it when one is saved, is known. The Worker's own answers are held by its tests.
test.describe('a saved Transaction that leaves the Uncategorised list', () => {
  const stubRow = (n: number) => ({
    id: 4240 + n,
    accountId: 1,
    accountName: 'Example savings',
    date: '2026-10-08',
    description: `EXAMPLE STUB ${n}`,
    bankType: 'EFTPOS',
    amountCents: -100 * n,
    categoryId: null,
    categoryName: null,
    categorySource: null,
    note: null,
    transfer: null,
    transferAccountName: null,
    canMarkNotTransfer: false,
    notTransfer: false,
  })

  /** The list is these rows until Save is pressed on `leaving`, and then it is without that one. */
  async function stubList(page: Page, rows: ReturnType<typeof stubRow>[], leaving: number) {
    let saved = false
    await page.route(/\/api\/transactions\?/, (route) => {
      const shown = saved ? rows.filter((row) => row.id !== 4240 + leaving) : rows
      const countOnly = new URL(route.request().url()).searchParams.get('count') === 'only'
      return route.fulfill({ json: countOnly ? { total: shown.length, transactions: [] } : { total: null, transactions: shown } })
    })
    await page.route(`**/api/transactions/${4240 + leaving}/override`, (route) => {
      saved = true
      return route.fulfill({ json: { ok: true } })
    })
  }
  const stubEdit = (page: Page, n: number) => rowButton(page, 'Edit', `EXAMPLE STUB ${n}, ${dateText('2026-10-08')}`)

  test('is replaced by the Saved message where its row was, which has focus that shows, so focus does not jump to the next Transaction', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubList(page, [1, 2, 3].map(stubRow), 2)
    await page.goto('/uncategorised')
    await stubEdit(page, 2).click()
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    const message = page.getByRole('status').filter({ hasText: 'Saved EXAMPLE STUB 2.' })
    await expect(message).toBeFocused()
    await expect(stubEdit(page, 2)).toHaveCount(0)
    // It is between the Transactions that were either side of it.
    await expect(message.locator('xpath=ancestor::tr[1]/preceding-sibling::tr[1]').getByRole('button', { name: /^Edit EXAMPLE STUB 1,/ })).toBeVisible()
    await expect(message.locator('xpath=ancestor::tr[1]/following-sibling::tr[1]').getByRole('button', { name: /^Edit EXAMPLE STUB 3,/ })).toBeVisible()
    await noAxeViolations(page)

    // Focus is drawn on it, as an outline (a mouse press set it going, so the keyboard is what makes it show): it has no `outline-none` to cancel the outline its focus style draws.
    await message.evaluate((element) => element.blur())
    const focus = await focusIndicator(page, message)
    expect(focus.style).toBe('solid')
    expect(focus.width).toBeGreaterThanOrEqual(2)
    expect(focus.contrast).toBeGreaterThanOrEqual(3)
    await message.evaluate((element) => element.blur())

    // The message goes when the Admin starts on another Transaction.
    await stubEdit(page, 3).click()
    await expect(page.getByRole('region', { name: 'Edit Category and Note' })).toBeVisible()
    await expect(message).toHaveCount(0)
  })

  test('when it was the last one, the Saved message is at the top and has focus', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubList(page, [stubRow(1)], 1)
    await page.goto('/uncategorised')
    await stubEdit(page, 1).click()
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.getByText('There are no Uncategorised Transactions.')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Saved EXAMPLE STUB 1.' })).toBeFocused()
  })

  test('on a phone the message is a card of its own between the cards that were either side of the Transaction', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 390, height: 844 })
    await stubList(page, [1, 2, 3].map(stubRow), 2)
    await page.goto('/uncategorised')
    await stubEdit(page, 2).click()
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    const message = page.getByRole('status').filter({ hasText: 'Saved EXAMPLE STUB 2.' })
    await expect(message).toBeFocused()
    await expect(message.locator('xpath=ancestor::li[1]/preceding-sibling::li[1]').getByRole('button', { name: /^Edit EXAMPLE STUB 1,/ })).toBeVisible()
    await expect(message.locator('xpath=ancestor::li[1]/following-sibling::li[1]').getByRole('button', { name: /^Edit EXAMPLE STUB 3,/ })).toBeVisible()
  })

  // Windows high contrast drops the fill that says a button's panel is open (and the tint of its row), so the button's edge is the palette's highlight.
  test('the button of the open panel has the palette\'s highlight for its edge in Windows high contrast, and the others do not', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubList(page, [1, 2].map(stubRow), 2)
    await page.goto('/uncategorised')
    await stubEdit(page, 1).click()
    await expect(page.getByRole('region', { name: /^Edit Category and Note/ })).toBeVisible()
    await page.emulateMedia({ forcedColors: 'active' })
    const highlight = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.color = 'Highlight'
      document.body.append(probe)
      const colour = getComputedStyle(probe).color
      probe.remove()
      return colour
    })
    const edge = (n: number) => stubEdit(page, n).evaluate((button) => ({ colour: getComputedStyle(button).borderTopColor, width: parseFloat(getComputedStyle(button).borderTopWidth) }))
    expect(await edge(1)).toEqual({ colour: highlight, width: 1 })
    expect((await edge(2)).colour).not.toBe(highlight)
  })
})

test('the details show what Sync supplies, and a Bank Time only when the bank gave one', async ({ page, context }) => {
  await signInAs(context, 'member')
  const detail = {
    id: 4242,
    accountId: 1,
    accountName: 'Example savings',
    date: '2026-10-08',
    amountCents: -23456,
    description: 'EXAMPLE CAFE TOWN',
    bankMemo: '',
    bankType: 'EFTPOS',
    bankReference: 'EXAMPLE REF 42',
    bankCounterpartyAccount: '99-9999-9999999-97',
    bankCardSuffix: '1234',
    bankParticulars: 'EXAMPLE PARTICULARS',
    bankPaymentCode: 'EXAMPLE CODE',
    source: 'sync',
    categoryId: 3,
    categoryName: 'Eating out',
    categorySource: 'override',
    note: 'Lunch with Sam',
    bankTime: '2026-10-07T20:15:00.000Z', // 9:15 am on the 8th in NZ
    firstSeenAt: '2026-10-08T06:30:00.000Z', // 7:30 pm
  }
  await page.route('**/api/transactions/4242', (route) => route.fulfill({ json: detail }))
  await page.goto('/transactions/4242')

  const bank = page.getByRole('region', { name: 'From the bank' })
  await expect(bank).toContainText('Synced from Akahu')
  await expect(bank).toContainText('99-9999-9999999-97')
  await expect(bank).toContainText('Ending 1234')
  await expect(bank).toContainText('EXAMPLE PARTICULARS')
  await expect(bank).toContainText('EXAMPLE CODE')
  await expect(bank).toContainText('EXAMPLE REF 42')
  await expect(bank).toContainText('Bank Time')
  await expect(bank).toContainText('Thu 8 Oct 2026, 9:15 am')
  await expect(bank).toContainText('First seen by Akahu')
  await expect(bank).toContainText('Thu 8 Oct 2026, 7:30 pm')
  await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Override: set by the Admin')
  await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Lunch with Sam')
  await noAxeViolations(page)

  // The same Transaction without a Bank Time shows no time at all, though the raw date has one.
  await page.unroute('**/api/transactions/4242')
  await page.route('**/api/transactions/4242', (route) => route.fulfill({ json: { ...detail, bankTime: null } }))
  await page.reload()
  await expect(page.getByRole('region', { name: 'From the bank' })).toContainText('First seen by Akahu')
  await expect(page.getByRole('region', { name: 'From the bank' }).getByText('Bank Time')).toHaveCount(0)
})

test.describe('a Transaction that does not exist', () => {
  test.use({ expectedStatuses: [404] }) // the API answers 404, which the browser logs; nothing else may fail

  test('says so', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/transactions/999999999')
    await expect(page.getByRole('heading', { level: 1, name: 'Transaction not found' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('There is no Transaction with that number')
    await noAxeViolations(page)
  })
})

// An Edit button on each row of the Admin's list, and the panel it opens under that row. Twenty Transactions, so that the page scrolls and the row is some way down it.
const EDIT_ROWS = 20
const editRow = (stamp: string, i: number) => ({ date: `2012-02-${String(i + 1).padStart(2, '0')}`, description: `EXAMPLE EDIT ${stamp} ${String(i).padStart(2, '0')}` })
async function seedEditRows(context: BrowserContext, baseURL: string, project: string) {
  const stamp = `edit${project}${Date.now()}`
  await seed(context, baseURL, [{ account: accountsFor(project).savings, rows: Array.from({ length: EDIT_ROWS }, (_, i) => ({ ...editRow(stamp, i), amountCents: -100 - i })) }])
  const editName = (i: number) => `${editRow(stamp, i).description}, ${dateText(editRow(stamp, i).date)}`
  return { stamp, editName, edit: (page: Page, i: number) => rowButton(page, 'Edit', editName(i)) }
}
const editPanel = (page: Page) => page.getByRole('region', { name: 'Edit Category and Note' })
/** The row the panel is under: the one before the panel's own row (a table), or the card before its card (a phone). */
const rowAbove = (panel: Locator, element: 'tr' | 'li') => panel.locator(`xpath=ancestor::${element}[1]/preceding-sibling::${element}[1]`).getByRole('button', { name: /^Edit / })
const scrollOffset = (page: Page) => page.evaluate(() => window.scrollY)
const PAGE_ROWS = 60

test("a row's Edit button opens the Edit panel under that row without moving the page, one panel at a time, and Cancel and Save put focus back on the button", async ({ page, context, baseURL }, testInfo) => {
  const { stamp, editName, edit } = await seedEditRows(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto(`/transactions?q=${stamp}`)
  // Newest first, so the first Transaction is the last one made: these are the fifth and the seventh rows.
  const [first, second] = [EDIT_ROWS - 5, EDIT_ROWS - 7]
  await expect(edit(page, first)).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Action', exact: true })).toBeVisible() // one action, so the heading is singular
  await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0) // a row with one action has a button for it, not a menu
  await expectTableLook(page.getByRole('table', { name: 'Transactions matching the search' }))
  await edit(page, first).evaluate((button) => window.scrollTo(0, window.scrollY + button.getBoundingClientRect().top - 130)) // the row is some way down the page
  const scrolled = await scrollOffset(page)
  expect(scrolled).toBeGreaterThan(300)

  // It opens directly under its row, across the table, named for the Transaction, and the page stays where it was.
  await edit(page, first).click()
  await expect(editPanel(page)).toBeVisible()
  await expect(editPanel(page)).toHaveAccessibleName(`Edit Category and Note, ${editName(first)}`)
  await expect(page.getByRole('heading', { level: 2, name: `Edit Category and Note, ${editName(first)}` })).toBeVisible() // the visible title names it as well
  await expect(page.locator('#edit-category')).toBeFocused()
  await expect(edit(page, first)).toHaveAttribute('aria-expanded', 'true')
  await expect(edit(page, first)).toHaveAttribute('aria-controls', (await editPanel(page).getAttribute('id'))!)
  await expect(rowAbove(editPanel(page), 'tr')).toHaveAccessibleName(`Edit ${editName(first)}`)
  const [table, box] = await Promise.all([page.getByRole('table').boundingBox(), editPanel(page).boundingBox()])
  expect(box!.width).toBeGreaterThan(table!.width - 40)
  expect(await scrollOffset(page)).toBe(scrolled)

  // Pressing the button of the panel that is open puts focus in it.
  await editPanel(page).getByLabel('Note', { exact: true }).focus()
  await edit(page, first).click()
  await expect(page.locator('#edit-category')).toBeFocused()
  await expect(editPanel(page)).toHaveCount(1)

  // Opening another closes the first: there is one panel, under the second row.
  const typed = `Not saved yet ${stamp}`
  await editPanel(page).getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
  await editPanel(page).getByLabel('Note', { exact: true }).fill(typed)
  await edit(page, second).click()
  await expect(editPanel(page)).toHaveCount(1)
  await expect(rowAbove(editPanel(page), 'tr')).toHaveAccessibleName(`Edit ${editName(second)}`)
  await expect(edit(page, first)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#edit-category')).toBeFocused()
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue('') // this panel is its own, not the first one's
  expect(await scrollOffset(page)).toBe(scrolled)

  // What was typed in the first is still there when its panel is opened again, and Cancel throws it away.
  await edit(page, first).click()
  await expect(editPanel(page)).toHaveCount(1)
  await expect(rowAbove(editPanel(page), 'tr')).toHaveAccessibleName(`Edit ${editName(first)}`)
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue(typed)
  await expect(editPanel(page).getByLabel('Category', { exact: true }).locator('option:checked')).toHaveText('Groceries')

  // Cancel closes it and puts focus back on that row's button, with the page where it was.
  await editPanel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(editPanel(page)).toHaveCount(0)
  await expect(edit(page, first)).toBeFocused()
  await expect(edit(page, first)).toHaveAttribute('aria-expanded', 'false')
  expect(await scrollOffset(page)).toBe(scrolled)
  await edit(page, first).click()
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue('')
  await expect(editPanel(page).getByLabel('Category', { exact: true }).locator('option:checked')).toHaveText('No Override')

  // Save puts focus back on the button too, says so under the row it was said of (a plain line there; the line at the top, which a screen reader announces, is not drawn), and the row shows the change.
  await edit(page, second).click()
  await editPanel(page).getByLabel('Category', { exact: true }).selectOption({ label: 'Home and garden' })
  await editPanel(page).getByLabel('Note', { exact: true }).fill(`Paint for the fence ${stamp}`)
  await editPanel(page).getByRole('button', { name: 'Save', exact: true }).click()
  const saying = `Saved ${editRow(stamp, second).description}.`
  const line = page.getByRole('table').getByText(saying)
  await expect(line).toBeVisible()
  await expect(line.locator('xpath=ancestor::tr[1]/preceding-sibling::tr[1]').getByRole('button', { name: `Edit ${editName(second)}`, exact: true })).toBeVisible() // directly under its row
  await expect(line).not.toBeFocused()
  await expect(line).not.toHaveAttribute('role', 'status')
  const announcer = page.getByRole('status').filter({ hasText: saying })
  await expect(announcer).toHaveCount(1) // said once
  expect((await announcer.boundingBox())!.width).toBeLessThanOrEqual(1) // and not drawn a second time
  await expect(editPanel(page)).toHaveCount(0)
  await expect(edit(page, second)).toBeFocused()
  await expect(edit(page, second).locator('xpath=ancestor::tr[1]')).toContainText('Home and garden')
  expect(await scrollOffset(page)).toBe(scrolled)

  // Opening a panel clears the line; the panel is where it was.
  await edit(page, first).click()
  await expect(editPanel(page)).toBeVisible()
  await expect(line).toHaveCount(0)
  await noAxeViolationsFromTop(page)

  // The table becoming cards starts the panel again, and what was typed in it stays, and focus stays in the box it was in (the Note here, not the first field).
  await editPanel(page).getByLabel('Note', { exact: true }).fill(`Across layouts ${stamp}`)
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue(`Across layouts ${stamp}`)
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toBeFocused()
  await expect(rowAbove(editPanel(page), 'li')).toHaveAccessibleName(`Edit ${editName(first)}`)
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue(`Across layouts ${stamp}`)
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toBeFocused()
})

test('a panel opened from a row near the bottom of the screen scrolls the page by no more than it must, and not to a field in the middle', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, edit } = await seedEditRows(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(`/transactions?q=${stamp}`)
  const row = EDIT_ROWS - 8
  await expect(edit(page, row)).toBeVisible()
  await edit(page, row).evaluate((button) => window.scrollTo(0, window.scrollY + button.getBoundingClientRect().top - (window.innerHeight - 100))) // the button is 100px from the bottom of the window
  const scrolled = await scrollOffset(page)

  await edit(page, row).click()
  await expect(editPanel(page)).toBeVisible()
  await expect(page.locator('#edit-category')).toBeFocused()
  const box = (await editPanel(page).boundingBox())!
  const moved = (await scrollOffset(page)) - scrolled
  const sticksOut = Math.max(0, box.y + moved + box.height - 800) // how far the panel's foot was below the window before the page moved
  expect(box.y + box.height).toBeLessThanOrEqual(800 + 1) // all of the panel is on the screen
  expect(moved).toBeGreaterThan(0) // it had to be
  expect(moved).toBeLessThanOrEqual(sticksOut + 1) // and the page moved no further than that
  await expect(edit(page, row)).toBeInViewport() // so its row is still there
})

test("on a phone a row's Edit panel opens under that Transaction's card", async ({ page, context, baseURL }, testInfo) => {
  const { stamp, editName, edit } = await seedEditRows(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/transactions?q=${stamp}`)
  const row = EDIT_ROWS - 3
  await expect(edit(page, row)).toBeVisible()

  await edit(page, row).click()
  await expect(editPanel(page)).toBeVisible()
  await expect(page.getByRole('list', { name: 'Transactions matching the search' }).getByRole('region', { name: 'Edit Category and Note' })).toHaveCount(1)
  await expect(rowAbove(editPanel(page), 'li')).toHaveAccessibleName(`Edit ${editName(row)}`)
  const [card, box] = await Promise.all([editPanel(page).locator('xpath=ancestor::li[1]/preceding-sibling::li[1]').boundingBox(), editPanel(page).boundingBox()])
  expect(box!.width).toBeCloseTo(card!.width, 0) // as wide as the card above it
  await noAxeViolationsFromTop(page)
  await editPanel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(edit(page, row)).toBeFocused()
})

test('a panel whose top would be under the sticky header is scrolled out from under it', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, edit } = await seedEditRows(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(`/transactions?q=${stamp}`)
  const row = EDIT_ROWS - 8
  await expect(edit(page, row)).toBeVisible()
  await edit(page, row).evaluate((button) => window.scrollTo(0, window.scrollY + button.getBoundingClientRect().top + 40)) // the button is 40px above the top of the window, its row under the header
  await edit(page, row).dispatchEvent('click') // nothing of it is there to press, as when the panel is drawn again by the table becoming cards
  await expect(editPanel(page)).toBeVisible()
  const header = (await siteHeader(page).boundingBox())!
  const box = (await editPanel(page).boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1) // the whole of the panel, its title too, is below the header
  expect(box.y + box.height).toBeLessThanOrEqual(800 + 1)
  expect((await edit(page, row).boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1) // and so is its row's button, which the reader pressed
})

test('a panel too tall for the window has its row at the top, under the header, and not its foot with the row hidden', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, edit } = await seedEditRows(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1100, height: 420 })
  await page.goto(`/transactions?q=${stamp}`)
  const row = EDIT_ROWS - 8
  await expect(edit(page, row)).toBeVisible()
  await edit(page, row).evaluate((button) => window.scrollTo(0, window.scrollY + button.getBoundingClientRect().top - (window.innerHeight - 100)))
  await edit(page, row).click()
  await expect(editPanel(page)).toBeVisible()
  const header = (await siteHeader(page).boundingBox())!
  const [button, box] = [(await edit(page, row).boundingBox())!, (await editPanel(page).boundingBox())!]
  expect(box.height).toBeGreaterThan(420 - header.height) // it does not fit under the header
  expect(button.y).toBeGreaterThanOrEqual(header.y + header.height - 1) // so the button the reader pressed is whole, below the header, and not scrolled off under it
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height) // with the top of the panel under it
  await expect(page.getByRole('heading', { level: 2, name: /^Edit Category and Note/ })).toBeInViewport()
})

// More Transactions than a page holds (50), so that one can be on the first page, with its panel open, while the reader goes to the second.
test('what is typed in a panel is still there when the reader comes back to its page', async ({ page, context, baseURL }, testInfo) => {
  const stamp = `paged${testInfo.project.name}${Date.now()}`
  await seed(context, baseURL!, [
    {
      account: accountsFor(testInfo.project.name).savings,
      rows: Array.from({ length: PAGE_ROWS }, (_, i) => ({ date: `2012-04-${String((i % 28) + 1).padStart(2, '0')}`, description: `EXAMPLE PAGED ${stamp} ${String(i).padStart(2, '0')}`, amountCents: -100 - i })),
    },
  ])
  await page.goto(`/transactions?q=${stamp}`)
  const summary = page.getByRole('status').filter({ hasText: 'Showing' })
  await expect(summary).toContainText(`Showing 1 to 50 of ${PAGE_ROWS}`)

  const first = page.getByRole('button', { name: /^Edit / }).first()
  const named = (await first.getAttribute('aria-label'))!
  await first.click()
  await editPanel(page).getByLabel('Note', { exact: true }).fill(`Typed on page one ${stamp}`)
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(summary).toContainText(`Showing 51 to ${PAGE_ROWS} of ${PAGE_ROWS}`)
  await expect(editPanel(page)).toHaveCount(0) // its row is not on this page
  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(summary).toContainText(`Showing 1 to 50 of ${PAGE_ROWS}`)
  await expect(editPanel(page)).toHaveCount(1)
  await expect(rowAbove(editPanel(page), 'tr')).toHaveAccessibleName(named)
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue(`Typed on page one ${stamp}`)

  // Opening another row's panel and going away and back does not lose it either.
  await page.getByRole('button', { name: /^Edit / }).nth(2).click()
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(summary).toContainText(`Showing 51 to ${PAGE_ROWS} of ${PAGE_ROWS}`)
  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(summary).toContainText(`Showing 1 to 50 of ${PAGE_ROWS}`)
  await page.getByRole('button', { name: named }).click()
  await expect(editPanel(page).getByLabel('Note', { exact: true })).toHaveValue(`Typed on page one ${stamp}`)
})

test('the Admin edits a Transaction from its details and sees the change there', async ({ page, context, baseURL }, testInfo) => {
  const { stamp, names } = await seedFour(context, baseURL!, testInfo.project.name)
  await page.goto(`/transactions?q=${stamp}`)
  await page.getByRole('link', { name: names.hardware }).click()
  const details = await detailsOpened(page)
  const editButton = details.getByRole('button', { name: 'Edit Category and Note', exact: true })

  await editButton.click()
  await expect(page.getByLabel('Category', { exact: true })).toBeFocused()
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Home and garden' })
  await page.getByLabel('Note', { exact: true }).fill(`Paint for the fence ${stamp}`)
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  const summary = page.getByRole('region', { name: 'Summary' })
  await expect(summary).toContainText('Home and garden')
  await expect(summary).toContainText('Override: set by the Admin')
  await expect(summary).toContainText(`Paint for the fence ${stamp}`)
  await expect(editButton).toBeFocused()
  await noAxeViolations(page)

  // The list sees it too, and can filter by it.
  await page.getByRole('link', { name: 'Back to Transactions' }).click()
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Home and garden' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('link', { name: names.hardware })).toBeVisible()
  await expect(dataRows(page)).toHaveCount(1)
  // Searching the Note finds it.
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'All Categories' })
  await searchFor(page, `fence ${stamp}`)
  await expect(page.getByRole('link', { name: names.hardware })).toBeVisible()
})
