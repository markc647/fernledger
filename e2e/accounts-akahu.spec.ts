import type { Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'

// What the Accounts screen shows of what Akahu says about a linked Account (ticket 42). The Worker's answer is stubbed, because Sync is what fills
// these columns and a browser test does not reach Akahu. The stub even carries a logo URL, which the real Worker never sends the browser: the
// page must not draw or fetch one whatever it is given. Times are NZ times, whatever the device's time zone, so the device is in Los Angeles.

test.use({ timezoneId: 'America/Los_Angeles' })

const LOGO = 'https://cdn.akahu.nz/logos/connections/conn_example0000000000001'

const none = {
  akahuAccountId: null,
  akahuName: null,
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
    akahuStatus: 'ACTIVE',
    akahuType: 'CHECKING',
    akahuConnectionName: 'Example Bank',
    akahuConnectionLogo: LOGO,
    akahuBalanceCurrency: 'NZD',
    akahuBalanceCurrentCents: 70_717,
    akahuBalanceAvailableCents: 70_010,
    akahuRefreshedBalanceAt: '2026-10-21T02:46:00.000Z',
    akahuRefreshedMetaAt: '2026-10-21T02:47:00.000Z',
    akahuRefreshedTransactionsAt: '2026-10-20T18:05:00.000Z',
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
]

async function open(page: Page, context: Parameters<typeof signInAs>[0], role: 'admin' | 'member' = 'member') {
  await signInAs(context, role)
  await page.route('**/api/accounts', (route) => route.fulfill({ json: ACCOUNTS }))
  await page.goto('/accounts')
  return page.getByRole('table', { name: 'Accounts' }).getByRole('row')
}

test('a linked Account shows the bank, Akahu\'s name beside Fernledger\'s, its type and status, the balance with its currency and when Akahu refreshed it, in NZ time', async ({ page, context }) => {
  const row = (await open(page, context)).filter({ hasText: 'Example everyday' })
  await expect(row.getByRole('cell', { name: 'Example everyday', exact: true })).toBeVisible()
  const akahu = row.getByRole('term').locator('xpath=ancestor::dl[1]')
  const fact = async (term: string) => akahu.locator(`dt:text-is("${term}") + dd`).innerText()
  expect(await fact('Bank')).toBe('Example Bank')
  expect(await fact("Akahu's name")).toBe('EXAMPLE EVERYDAY')
  expect(await fact('Type')).toBe('Checking')
  expect(await fact('Status')).toBe('Active')
  expect(await fact('Balance')).toBe('$707.17 NZD ($700.10 available)')
  // 02:46 UTC on 21 October is 3:46 pm that day in NZ (UTC+13), and 18:05 UTC on the 20th is 7:05 am on the 21st.
  expect(await fact('Balance refreshed')).toBe('Wed 21 Oct 2026, 3:46 pm')
  expect(await fact('Details refreshed')).toBe('Wed 21 Oct 2026, 3:47 pm')
  expect(await fact('Transactions refreshed')).toBe('Wed 21 Oct 2026, 7:05 am')
})

test('an Account with no Akahu link shows none of it, and says it is not linked', async ({ page, context }) => {
  const row = (await open(page, context)).filter({ hasText: 'Example savings' })
  await expect(row).toContainText('Not linked to Akahu')
  await expect(row.getByRole('term')).toHaveCount(0)
  await expect(row).not.toContainText(/null|undefined|NaN|Invalid/)
})

test('a linked Account whose balance and optional fields are missing shows what Akahu gave and says the balance was not given', async ({ page, context }) => {
  const row = (await open(page, context)).filter({ hasText: 'Example card' })
  await expect(row.locator('dt:text-is("Bank") + dd')).toHaveText('Example Bank')
  await expect(row.locator('dt:text-is("Akahu\'s name") + dd')).toHaveText('EXAMPLE CARD')
  await expect(row.locator('dt:text-is("Type") + dd')).toHaveText('Credit card')
  await expect(row.locator('dt:text-is("Status") + dd')).toHaveText('Inactive')
  await expect(row.locator('dt:text-is("Balance") + dd')).toHaveText('Akahu did not give one')
  await expect(row.getByText('refreshed')).toHaveCount(0)
  await expect(row).not.toContainText(/null|undefined|NaN|Invalid/)
})

test('a linked Account that Sync has not read yet says so', async ({ page, context }) => {
  const row = (await open(page, context)).filter({ hasText: 'Example new link' })
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
