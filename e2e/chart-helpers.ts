import type { Page } from '@playwright/test'
import { expect } from './fixtures'

// What a spec needs to look at the Charts (the Charts page and the Dashboard's charts) with answers of its own, whatever the shared database holds: a net worth the Worker
// refuses for having more than 49 Accounts (worker/net-worth.ts) draws nothing. The specs that look at the charts stub both answers and wait for the pictures
// (dashboard.spec.ts, shell.spec.ts).

export const netWorth = (page: Page) => page.getByRole('region', { name: 'Net worth over time' })
export const spending = (page: Page) => page.getByRole('region', { name: 'Spending by Category' })
export const LINE = /^Line chart of net worth by month/

/** The region has drawn its chart: a figure named for a screen reader holding the chart's own picture. */
export const drawn = async (region: ReturnType<typeof netWorth>, name: RegExp) => {
  const figure = region.getByRole('img', { name })
  await expect(figure).toBeVisible()
  await expect(figure.locator('svg.recharts-surface')).toBeVisible()
  return figure
}

// What the Worker answers when the charts ask: a made-up net worth of three months, and made-up spending. Whatever range the page asks for gets the same answer.
export const NET_WORTH = {
  range: '24-months',
  counted: [{ accountId: 1, accountName: 'Example everyday', lastDate: '2026-10-07' }],
  notCounted: [],
  points: [
    { date: '2026-08-31', cents: 1_000_000 },
    { date: '2026-09-30', cents: 1_050_000 },
    { date: '2026-10-07', cents: 1_080_000 },
  ],
  tooManyAccounts: null,
}
export const stubNetWorth = (page: Page, answer: object = NET_WORTH) => page.route(/\/api\/charts\/net-worth/, (route) => route.fulfill({ json: answer }))
export const stubSpending = (page: Page, categories: object[], totalCents: number) =>
  page.route(/\/api\/charts\/spending\?/, (route) => route.fulfill({ json: { from: '2026-10-01', to: '2026-10-31', totalCents, categories } }))
export const SPENT = [
  { categoryId: 1, name: 'Fuel', cents: 9000 },
  { categoryId: 2, name: 'Groceries', cents: 4550 },
  { categoryId: null, name: 'Uncategorised', cents: 2500 },
]
