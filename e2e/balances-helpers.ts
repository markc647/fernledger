import type { Page } from '@playwright/test'

// Answers for the Balances table of the Summary and the Dashboard (its Checked and Sync columns), so a spec can show every state whatever the shared database holds. Sync is not built and no
// Account has been synced, so the real Worker says Akahu Sync is not set up and its Sync column is not there: a spec that looks at the column stubs the answers, with these.

export const stubAccount = (accountId: number, accountName: string, balanceCents: number, syncedInLast24Hours = false) => ({
  accountId,
  accountName,
  balanceCents,
  asOfDate: '2026-10-08',
  cutoverDate: null,
  latestStatus: 'matched',
  syncedInLast24Hours,
  linked: syncedInLast24Hours,
})
/** Everyday was synced in the last 24 hours, and Savings and the card were not. */
export const BALANCES = [stubAccount(1, 'Example everyday', 123_400, true), stubAccount(2, 'Example savings', 5_000_000), stubAccount(3, 'Example card', -45_000)]

export const difference = (accountId: number, accountName: string, differenceCents: number, asOfDate = '2026-10-08') => ({ accountId, accountName, asOfDate, since: '2026-09-30', differenceCents })
export const latestCheck = (accountId: number, accountName: string, status: string | null) => ({ accountId, accountName, asOfDate: status === null ? null : '2026-10-08', status })

/** Everyday agrees, Savings differs by $12.34, and nothing has been compared for the card. */
export const CHECKS = {
  differences: [difference(2, 'Example savings', -1234)],
  accounts: [latestCheck(1, 'Example everyday', 'matched'), latestCheck(2, 'Example savings', 'differs'), latestCheck(3, 'Example card', null)],
}

/** What `/api/features` says. When Akahu Sync is not set up the D1 usage bar is, so a column that was shown whenever some feature is enabled would show here, and a test of its absence would fail. */
export const FEATURES = (syncSetUp: boolean) => ({
  features: [
    { id: 'akahu-sync', name: 'Akahu Sync', enabled: syncSetUp },
    { id: 'd1-usage', name: 'D1 usage bar', enabled: !syncSetUp },
  ],
})

/** Answers the three requests the Balances table makes. */
export async function stubBalances(page: Page, { checks = CHECKS, syncSetUp = false, balances = BALANCES }: { checks?: object; syncSetUp?: boolean; balances?: object[] } = {}) {
  await page.route('**/api/balances', (route) => route.fulfill({ json: { accounts: balances } }))
  await page.route('**/api/balance-checks', (route) => route.fulfill({ json: checks }))
  await page.route('**/api/features', (route) => route.fulfill({ json: FEATURES(syncSetUp) }))
}
