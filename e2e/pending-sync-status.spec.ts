import type { Page } from '@playwright/test'
import { FEATURES, stubBalances } from './balances-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'

// Pending money above the Transactions table, and the Sync status above the Balances (ticket 29, spec 32, 54-60). Both are filled by
// Sync, which a browser test does not run, so the Worker's answers are stubbed. Times are NZ times whatever the device's time zone.

test.use({ timezoneId: 'America/Los_Angeles' })

const PENDING = [
  { id: 1, accountId: 1, accountName: 'Example everyday', date: '2026-10-21', description: 'PENDING CAFE', amountCents: -450, bankType: 'EFTPOS', syncedAt: '2026-10-20T18:00:00.000Z' },
  { id: 2, accountId: 2, accountName: 'Example savings', date: '2026-10-20', description: 'PENDING TRANSFER', amountCents: 12_500, bankType: null, syncedAt: '2026-10-20T18:00:00.000Z' },
]

/** A linked Account as the Accounts list gives it, with only what the Sync status reads spelled out. */
const linked = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Example everyday',
  accountNumber: '99-9999-9999999-33',
  cutoverDate: null,
  akahuAccountId: 'acc_example000000000000001',
  akahuSyncedAt: '2026-10-20T18:00:00.000Z',
  akahuMissingSince: null,
  akahuLastFailure: null,
  akahuName: 'EXAMPLE EVERYDAY',
  akahuStatus: 'ACTIVE',
  akahuType: 'CHECKING',
  akahuConnectionName: 'Example Bank',
  akahuBalanceCurrency: 'NZD',
  akahuBalanceCurrentCents: 70_717,
  akahuBalanceAvailableCents: null,
  akahuRefreshedBalanceAt: null,
  akahuRefreshedMetaAt: null,
  akahuRefreshedTransactionsAt: null,
  ...over,
})

const pendingSection = (page: Page) => page.getByRole('region', { name: 'Pending' })

async function openTransactions(page: Page, context: Parameters<typeof signInAs>[0], pending: object[] = PENDING) {
  await signInAs(context, 'member')
  await page.route('**/api/transactions/pending', (route) => route.fulfill({ json: pending }))
  await page.goto('/transactions')
  return pendingSection(page)
}

/** The Summary, with the Balances card's answers stubbed and Akahu Sync set up, so the Sync status is there to read. */
async function openSummary(page: Page, context: Parameters<typeof signInAs>[0], accounts: object[], role: 'admin' | 'member' = 'member') {
  await signInAs(context, role)
  await stubBalances(page, { syncSetUp: true })
  await page.route('**/api/features', (route) => route.fulfill({ json: FEATURES(true) }))
  await page.route('**/api/accounts', (route) => route.fulfill({ json: accounts }))
  await page.goto('/')
  return page.getByRole('region', { name: 'Balances' })
}

test('the Transactions page lists the pending money above the table, marked as pending and dated in NZ time', async ({ page, context }) => {
  const pending = await openTransactions(page, context)
  await expect(pending.getByRole('heading', { name: 'Pending' })).toBeVisible()
  // 18:00 UTC on 20 October is 7:00 am on the 21st in NZ.
  await expect(pending).toContainText('Reported by the bank and not settled yet, as at Wed 21 Oct 2026 at 7:00 am.')
  await expect(pending).toContainText('These may still change or disappear, so they are in no Budget, Report or total.')
  const rows = pending.getByRole('table', { name: 'Pending Transactions, newest first' }).getByRole('row')
  await expect(rows.filter({ hasText: 'PENDING CAFE' })).toContainText('$4.50')
  await expect(rows.filter({ hasText: 'PENDING CAFE' })).toContainText('Example everyday')
  await expect(rows.filter({ hasText: 'PENDING TRANSFER' })).toContainText('$125.00')
})

// Above the search and whatever follows it, so pending money is never read as one of the Transactions the search found. The
// shared database may hold no Transaction for this spec, in which case the list shows its empty message and no table at all.
test('the pending money is above the search and the Transactions it finds', async ({ page, context }) => {
  const pending = await openTransactions(page, context)
  const search = page.getByRole('search', { name: 'Search Transactions' })
  await expect(search).toBeVisible()
  await expect(page.getByRole('table', { name: /^Transactions/ }).filter({ hasText: 'PENDING CAFE' })).toHaveCount(0)
  const [pendingBox, searchBox] = [await pending.boundingBox(), await search.boundingBox()]
  expect(pendingBox!.y).toBeLessThan(searchBox!.y)
})

test('nothing is said about pending money when there is none', async ({ page, context }) => {
  await openTransactions(page, context, [])
  await expect(pendingSection(page)).toHaveCount(0)
  await expect(page.getByText('Pending', { exact: true })).toHaveCount(0)
})

test('the pending money passes the accessibility scan', async ({ page, context }) => {
  const pending = await openTransactions(page, context)
  await expect(pending.getByText('PENDING CAFE')).toBeVisible()
  await noAxeViolations(page)
})

test('the Summary says when the bank data was last updated, above the balances', async ({ page, context }) => {
  const balances = await openSummary(page, context, [linked()])
  await expect(balances).toContainText('Bank data last updated Wed 21 Oct 2026 at 7:00 am.')
  const [statusBox, tableBox] = [await balances.getByText('Bank data last updated').boundingBox(), await balances.getByRole('table').boundingBox()]
  expect(statusBox!.y).toBeLessThan(tableBox!.y)
})

test('a Member is told the cause and not the Admin’s actions; the Admin is told both', async ({ page, context }) => {
  const asMember = await openSummary(page, context, [linked({ akahuLastFailure: 'refused' })], 'member')
  await expect(asMember).toContainText('Akahu token invalid: Akahu refused the tokens, so nothing could be read.')
  await expect(asMember).not.toContainText('set them again in Settings')

  const asAdmin = await openSummary(page, context, [linked({ akahuLastFailure: 'refused' })], 'admin')
  await expect(asAdmin).toContainText('Akahu token invalid')
  await expect(asAdmin).toContainText('Check both tokens in Akahu, set them again in Settings, then run a Sync.')
})

test('a broken Account Link is named on the Summary with the bank that needs reconnecting', async ({ page, context }) => {
  const balances = await openSummary(page, context, [linked({ akahuMissingSince: '2026-10-18T18:00:00.000Z' })], 'admin')
  await expect(balances).toContainText('Example Bank needs reconnecting in Akahu')
  await expect(balances).toContainText('No Transaction has been removed.')
})

test('the Sync status says nothing where no Account is linked to Akahu', async ({ page, context }) => {
  const balances = await openSummary(page, context, [linked({ akahuAccountId: null })])
  await expect(balances.getByRole('table')).toBeVisible()
  await expect(balances).not.toContainText('Bank data last updated')
})

test('the Sync status passes the accessibility scan with a cause and an action', async ({ page, context }) => {
  const balances = await openSummary(page, context, [linked({ akahuMissingSince: '2026-10-18T18:00:00.000Z' })], 'admin')
  await expect(balances.getByText('needs reconnecting in Akahu')).toBeVisible()
  await noAxeViolations(page)
})
