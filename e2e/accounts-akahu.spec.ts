import type { Locator, Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'

// What the Accounts screen shows of what Akahu says about a linked Account (ticket 42). The Worker's answer is stubbed, because Sync is what fills
// these columns and a browser test does not reach Akahu. The stub even carries a logo URL, which the real Worker never sends the browser: the
// page must not draw or fetch one whatever it is given. Times are NZ times, whatever the device's time zone, so the device is in Los Angeles.

test.use({ timezoneId: 'America/Los_Angeles' })

const LOGO = 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001'

const none = {
  akahuAccountId: null,
  akahuName: null,
  akahuFormattedAccount: null,
  akahuAttributes: null,
  akahuConnectionId: null,
  akahuConnectionType: null,
  akahuStatus: null,
  akahuType: null,
  akahuConnectionName: null,
  akahuConnectionLogo: null,
  akahuBalanceCurrency: null,
  akahuBalanceCurrentCents: null,
  akahuBalanceAvailableCents: null,
  akahuRefreshedBalanceAt: null,
  akahuRefreshedMetaAt: null,
  akahuRefreshedTransactionsAt: null,
  akahuSyncedAt: null,
  akahuMissingSince: null,
  akahuLastFailure: null,
}

const ACCOUNTS = [
  // Linked, and Akahu said everything. Its balance is lower than the one it will give for "available".
  {
    ...none,
    id: 1,
    name: 'Example everyday',
    accountNumber: '99-9999-9999999-27',
    cutoverDate: null,
    akahuAccountId: 'acc_example000000000000001',
    akahuName: 'EXAMPLE EVERYDAY',
    akahuFormattedAccount: '99-9999-9999999-27',
    akahuStatus: 'ACTIVE',
    akahuType: 'CHECKING',
    akahuAttributes: ['PAYMENT_TO', 'PAYMENT_FROM', 'TRANSACTIONS'],
    akahuConnectionId: 'conn_example0000000000001',
    akahuConnectionName: 'Example Bank',
    akahuConnectionType: 'official',
    akahuConnectionLogo: LOGO,
    akahuBalanceCurrency: 'NZD',
    akahuBalanceCurrentCents: 70_717,
    akahuBalanceAvailableCents: 70_010,
    akahuRefreshedBalanceAt: '2026-10-21T02:46:00.000Z',
    akahuRefreshedMetaAt: '2026-10-21T02:47:00.000Z',
    akahuRefreshedTransactionsAt: '2026-10-20T18:05:00.000Z',
    akahuSyncedAt: '2026-10-20T18:00:00.000Z',
  },
  // Not linked.
  { ...none, id: 2, name: 'Example savings', accountNumber: '99-9999-9999999-28', cutoverDate: null },
  // Linked, and Akahu gave no balance, no logo and nothing about when it refreshed.
  {
    ...none,
    id: 3,
    name: 'Example card',
    accountNumber: '99-9999-9999999-29',
    cutoverDate: null,
    akahuAccountId: 'acc_example000000000000003',
    akahuName: 'EXAMPLE CARD',
    akahuStatus: 'INACTIVE',
    akahuType: 'CREDIT_CARD',
    akahuConnectionName: 'Example Bank',
  },
  // Linked, and no Sync has read it yet.
  { ...none, id: 4, name: 'Example new link', accountNumber: '99-9999-9999999-32', cutoverDate: null, akahuAccountId: 'acc_example000000000000004' },
  // Linked, Synced before, and Akahu has since stopped listing it: its Account Link is broken (ticket 29, spec 32).
  {
    ...none,
    id: 5,
    name: 'Example gone',
    accountNumber: '99-9999-9999999-34',
    cutoverDate: null,
    akahuAccountId: 'acc_example000000000000005',
    akahuName: 'EXAMPLE GONE',
    akahuConnectionName: 'Example Bank',
    akahuSyncedAt: '2026-10-18T18:00:00.000Z',
    akahuMissingSince: '2026-10-19T18:00:00.000Z',
  },
]

async function open(page: Page, context: Parameters<typeof signInAs>[0], role: 'admin' | 'member' = 'member') {
  await signInAs(context, role)
  await page.route('**/api/accounts', (route) => route.fulfill({ json: ACCOUNTS }))
  await page.goto('/accounts')
  return page.getByRole('table', { name: 'Accounts' }).getByRole('row')
}

/**
 * What Akahu says about an Account is a row of its own under it, across the table, and not a column (A1), so these tests read that row.
 * It is found by the words only it carries: the screen-reader label that says whose details they are.
 */
const akahuRow = (rows: Locator, name: string) => rows.filter({ hasText: `From Akahu, ${name}` })

test('a linked Account shows the bank, Akahu\'s name beside Fernledger\'s, its type and status, the balance with its currency, when Akahu last read the bank and when Fernledger last Synced it, in NZ time', async ({ page, context }) => {
  const rows = await open(page, context)
  await expect(rows.getByRole('cell', { name: 'Example everyday', exact: true })).toBeVisible()
  const row = akahuRow(rows, 'Example everyday')
  const akahu = row.getByRole('term').locator('xpath=ancestor::dl[1]')
  const fact = async (term: string) => akahu.locator(`dt:text-is("${term}") + dd`).innerText()
  expect(await fact('Bank')).toBe('Example Bank')
  expect(await fact("Akahu's name")).toBe('EXAMPLE EVERYDAY')
  expect(await fact("Akahu's account number")).toBe('99-9999-9999999-27')
  expect(await fact('Type')).toBe('Checking')
  expect(await fact('Status')).toBe('Active')
  // Akahu's own words, read as words: what it says it can do with the Account, which bank connection it came from and of what kind (ticket 42).
  expect(await fact("Akahu's attributes")).toBe('Payment to, Payment from, Transactions')
  expect(await fact("Akahu's connection ID")).toBe('conn_example0000000000001')
  expect(await fact("Akahu's connection type")).toBe('Official')
  expect(await fact('Balance')).toBe('$707.17 NZD ($700.10 available)')
  // 02:46 UTC on 21 October is 3:46 pm that day in NZ (UTC+13), and 18:05 UTC on the 20th is 7:05 am on the 21st.
  expect(await fact('Akahu last read the bank')).toBe('Balance: Wed 21 Oct 2026, 3:46 pm; Account details: Wed 21 Oct 2026, 3:47 pm; Transactions: Wed 21 Oct 2026, 7:05 am')
  // Fernledger's own last Sync is a different time from those, and the screen keeps the two apart: 18:00 UTC on the 20th is 7:00 am on the 21st.
  expect(await fact('Last Sync')).toBe('Wed 21 Oct 2026, 7:00 am')
  await expect(row).not.toContainText('refreshed')
})

test('a linked Account Akahu says can do nothing has a line saying so, which is not the same as no attributes at all', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ ...ACCOUNTS[0], akahuAttributes: [] }, { ...ACCOUNTS[2], akahuAttributes: null }] }))
  await page.goto('/accounts')
  const rows = page.getByRole('table', { name: 'Accounts' }).getByRole('row')
  await expect(akahuRow(rows, 'Example everyday').locator(`dt:text-is("Akahu's attributes") + dd`)).toHaveText('None')
  await expect(akahuRow(rows, 'Example card').getByText("Akahu's attributes")).toHaveCount(0)
})

test('an Account with no Akahu link shows none of it, and says it is not linked', async ({ page, context }) => {
  const row = akahuRow(await open(page, context), 'Example savings')
  await expect(row).toContainText('Not linked to Akahu')
  await expect(row.getByRole('term')).toHaveCount(0)
  await expect(row).not.toContainText(/null|undefined|NaN|Invalid/)
})

test('a linked Account whose balance and optional fields are missing shows what Akahu gave and says the balance was not given', async ({ page, context }) => {
  const row = akahuRow(await open(page, context), 'Example card')
  await expect(row.locator('dt:text-is("Bank") + dd')).toHaveText('Example Bank')
  await expect(row.locator('dt:text-is("Akahu\'s name") + dd')).toHaveText('EXAMPLE CARD')
  await expect(row.locator('dt:text-is("Type") + dd')).toHaveText('Credit card')
  await expect(row.locator('dt:text-is("Status") + dd')).toHaveText('Inactive')
  await expect(row.locator('dt:text-is("Balance") + dd')).toHaveText('Akahu did not give one')
  await expect(row.getByText('Akahu last read the bank')).toHaveCount(0)
  // Nothing has Synced it, and it says so rather than leaving a blank.
  await expect(row.locator('dt:text-is("Last Sync") + dd')).toHaveText('Never synced')
  await expect(row).not.toContainText(/null|undefined|NaN|Invalid/)
})

test('a linked Account Akahu gave no status, type or bank for shows the lines it has and no empty ones', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ ...ACCOUNTS[2], akahuStatus: null, akahuType: null, akahuConnectionName: null }] }))
  await page.goto('/accounts')
  const row = akahuRow(page.getByRole('table', { name: 'Accounts' }).getByRole('row'), 'Example card')
  await expect(row.locator("dt:text-is(\"Akahu's name\") + dd")).toHaveText('EXAMPLE CARD')
  await expect(row.getByRole('term')).toHaveText(["Akahu's name", 'Balance', 'Last Sync'])
})

test('a linked Account that Sync has not read yet says so', async ({ page, context }) => {
  const row = akahuRow(await open(page, context), 'Example new link')
  await expect(row).toContainText('Linked to Akahu. The next Sync will read its details.')
  await expect(row.getByRole('term')).toHaveCount(0)
})

test('the page never draws or fetches the logo, even when it is given the URL', async ({ page, context }) => {
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))
  await open(page, context)
  await expect(page.getByText('Example Bank').first()).toBeVisible()
  // Asked for by the page, and what the browser's own record of loads says it fetched: neither names Akahu's CDN.
  expect(requested.length).toBeGreaterThan(0)
  expect(requested.filter((url) => url.includes('cdn.akahu.nz'))).toEqual([])
  expect((await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))).filter((url) => url.includes('cdn.akahu.nz'))).toEqual([])
  expect(await page.getByRole('table', { name: 'Accounts' }).locator('img').count()).toBe(0)
  expect(await page.evaluate(() => [...document.images].map((image) => image.src).filter((src) => src.includes('cdn.akahu.nz')))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes('cdn.akahu.nz'))).toBe(false)
})

test('the Accounts screen with Akahu\'s details passes the accessibility scan, for the Admin too', async ({ page, context }) => {
  await open(page, context, 'admin')
  await expect(page.getByText('EXAMPLE EVERYDAY', { exact: true })).toBeVisible()
  await noAxeViolations(page)
})

// An answer from before the Link and failure fields were stored leaves them out. Such an Account has nothing wrong with it, and
// showing its details must not fail on a date that is not one.
// The same guard, over an answer that holds no balance and no times at all: a field a stored answer never had is shown as not
// given, and never fails the screen (the contrast sweep's stubbed Account caught this one).
test('an Account whose answer holds no balance or times shows what it has and says the balance was not given', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      json: [{ id: 1, name: 'Example sparse', accountNumber: '99-9999-9999999-34', cutoverDate: null, akahuAccountId: 'acc_example000000000000006', akahuName: 'EXAMPLE SPARSE' }],
    }),
  )
  await page.goto('/accounts')
  const row = akahuRow(page.getByRole('table', { name: 'Accounts' }).getByRole('row'), 'Example sparse')
  await expect(row.locator('dt:text-is("Balance") + dd')).toHaveText('Akahu did not give one')
  await expect(row.locator('dt:text-is("Last Sync") + dd')).toHaveText('Never synced')
  await expect(row).not.toContainText(/null|undefined|NaN|Invalid/)
})

test('an Account whose answer predates the Link fields shows its details and no broken Link', async ({ page, context }) => {
  await signInAs(context, 'member')
  const { akahuMissingSince: _since, akahuLastFailure: _failure, ...older } = ACCOUNTS[0]!
  await page.route('**/api/accounts', (route) => route.fulfill({ json: [older] }))
  await page.goto('/accounts')
  const row = akahuRow(page.getByRole('table', { name: 'Accounts' }).getByRole('row'), 'Example everyday')
  await expect(row.locator("dt:text-is(\"Akahu's name\") + dd")).toHaveText('EXAMPLE EVERYDAY')
  await expect(row).not.toContainText('Account Link broken')
  await expect(row).not.toContainText(/null|undefined|NaN|Invalid/)
})

test('an Account Akahu has stopped listing says its Link is broken, since when, and that nothing was removed', async ({ page, context }) => {
  const row = akahuRow(await open(page, context), 'Example gone')
  await expect(row).toContainText('Account Link broken')
  // 18:00 UTC on 19 October is 7:00 am on the 20th in NZ.
  await expect(row).toContainText('Akahu has stopped listing this account since Tue 20 Oct 2026, 7:00 am.')
  await expect(row).toContainText('No Transaction has been removed')
  // What the last Sync stored stays on show under it: Akahu's own name for the account is how the Admin tells which one it was.
  await expect(row.locator("dt:text-is(\"Akahu's name\") + dd")).toHaveText('EXAMPLE GONE')
  await expect(row.locator('dt:text-is("Bank") + dd')).toHaveText('Example Bank')
  // A Member is not asked to do what only the Admin can (spec 60).
  await expect(row).not.toContainText('Reconnect the bank in Akahu')
})

test('the Admin is sent to Settings to link an Account whose Link is broken again', async ({ page, context }) => {
  const row = akahuRow(await open(page, context, 'admin'), 'Example gone')
  await expect(row).toContainText('Reconnect the bank in Akahu, then')
  await expect(row.getByRole('link', { name: 'link this Account again in Settings' })).toHaveAttribute('href', '/settings')
  await noAxeViolations(page)
})
