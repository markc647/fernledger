import { readFileSync } from 'node:fs'
import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

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
 * test that clicks straight away then races the navigation (slower on CI). Every row of the list has an "Edit Category and
 * Note for …" button too, so the buttons are looked for inside the details only.
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
  await noAxeViolations(page)

  // Account.
  await page.getByLabel('Account', { exact: true }).selectOption({ label: savings.name })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(2)
  await expect(page.getByRole('link', { name: names.cafeTwo })).toHaveCount(0)

  // Dates, both ends included: the first of October is out of this range, the eighth is in.
  await page.getByLabel('From', { exact: true }).fill('2012-10-02')
  await page.getByLabel('To', { exact: true }).fill('2012-10-08')
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
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('2012-10-02')
  await page.goBack()
  await expect(page.getByText('No Transactions match these filters.')).toBeVisible()

  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(searchBox(page)).toHaveValue('')
  await expect(page).not.toHaveURL(/q=/)
  await expect(page.getByLabel('Account', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Category', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('')
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
  await page.getByLabel('From', { exact: true }).fill('2012-10-09')
  await page.getByLabel('To', { exact: true }).fill('2012-10-08')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('before the “From” date')
  await expect(page.getByLabel('To', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(page).not.toHaveURL(/from=/)
  await noAxeViolations(page)

  // An address typed by hand with the same mistake gets the same explanation, not a list.
  await page.goto('/transactions?from=2012-10-09&to=2012-10-08')
  await expect(page.getByRole('alert')).toContainText('before the “From” date')
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
  await expect(summary).toContainText('Money out')
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
  await page.getByLabel('From', { exact: true }).fill('2012-10-02')
  await expect(page.getByText(hint)).toBeVisible()
  await page.getByLabel('From', { exact: true }).fill('')
  await expect(page.getByText(hint)).toHaveCount(0)
})

test('a Member downloads the Transactions they searched for as a CSV file, with formulas defused, once Search has been pressed', async ({ page, context, baseURL }, testInfo) => {
  const { savings } = accountsFor(testInfo.project.name)
  const stamp = `csv${testInfo.project.name}${Date.now()}`
  await seed(context, baseURL!, [
    {
      account: savings,
      rows: [
        { date: '2012-06-02', description: `=EXAMPLE ${stamp} FORMULA`, amountCents: -1234 },
        { date: '2012-06-01', description: `EXAMPLE ${stamp} PLAIN`, amountCents: 5000 },
        { date: '2012-07-01', description: `EXAMPLE ${stamp} OUTSIDE`, amountCents: -100 },
      ],
    },
  ])
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}&from=2012-06-01&to=2012-06-30`)
  await expect(dataRows(page)).toHaveCount(2)
  const link = page.getByRole('link', { name: 'Download CSV' })
  await expect(link).toBeVisible()
  await noAxeViolations(page)

  // The file holds what is shown, so it waits while the filters typed are not the ones applied.
  await searchBox(page).fill('something else')
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled()
  await expect(link).toHaveCount(0)
  await searchBox(page).fill(stamp)
  await expect(link).toBeVisible()

  const [file] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(file.suggestedFilename()).toBe('fernledger-transactions-2012-06-01-to-2012-06-30.csv')
  const text = readFileSync(await file.path(), 'utf8')
  const byteOrderMark = String.fromCharCode(0xfeff) // so Excel reads the file as UTF-8
  expect(text).toBe(
    [
      `${byteOrderMark}Date,Account,Description,Category,Note,Amount,Bank type,Bank memo,Bank reference,Bank counterparty account,Bank particulars,Bank payment code,Bank card suffix`,
      // A bank file gives a type and a memo and none of the rest, which are empty cells all the same.
      `2012-06-01,${savings.name},EXAMPLE ${stamp} PLAIN,Uncategorised,,50.00,EFTPOS,EFTPOS,,,,,`,
      `2012-06-02,${savings.name},'=EXAMPLE ${stamp} FORMULA,Uncategorised,,-12.34,EFTPOS,EFTPOS,,,,,`,
      '',
      'Totals',
      'Money in,50.00',
      'Money out,-12.34',
      'Net,37.66',
      'Transactions,2',
      '',
    ].join('\r\n'),
  )
})

test('says how many Transactions match, and warns before a download that would stop short, and where saved files are explained', async ({ page, context }) => {
  await signInAs(context, 'member')
  const row = { id: 4242, accountId: 1, accountName: 'Example savings', date: '2026-10-08', description: 'EXAMPLE CAFE TOWN', bankType: 'EFTPOS', amountCents: -2345, categoryId: null, categoryName: null, categorySource: null, note: null }
  let total = 5001
  await page.route(/\/api\/transactions\?/, (route) => {
    const countOnly = new URL(route.request().url()).searchParams.get('count') === 'only'
    return route.fulfill({ json: countOnly ? { total, transactions: [] } : { total: null, transactions: [row] } })
  })
  const matches = page.locator('#filter-download-count')
  const warning = page.getByText('Only the oldest 5,000 will be saved. Set From and To to one year at a time to save the rest.')

  await page.goto('/transactions')
  await expect(matches).toHaveText('5,001 Transactions match')
  await expect(warning).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAccessibleDescription(/5,001 Transactions match.*Only the oldest 5,000 will be saved/)
  await noAxeViolations(page)

  // Exactly the most is not too many, and one is "matches".
  total = 5000
  await page.reload()
  await expect(matches).toHaveText('5,000 Transactions match')
  await expect(warning).toHaveCount(0)
  total = 1
  await page.reload()
  await expect(matches).toHaveText('1 Transaction matches')

  // What leaves Fernledger's protection is explained where the Member can read it.
  await page.getByRole('search', { name: 'Search Transactions' }).getByRole('link', { name: 'About your data' }).click()
  await expect(page).toHaveURL(/\/about-your-data#seen$/)
  await expect(page.getByText('A file saved from Fernledger, such as a CSV export of Transactions, is outside all of this.')).toBeVisible()
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
