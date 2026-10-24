import type { Page, Request } from '@playwright/test'
import { expect } from './fixtures'

// What a spec needs to look at the two charts with answers of its own, whatever the shared database holds: net worth (the Net worth page) which the Worker refuses for having more
// than 47 Accounts (worker/net-worth.ts) and then draws nothing, and spending by Category (the Spending by Category Report), whose bars are drawn from the Report's own answer. The specs
// that look at the charts stub the answer and wait for the picture (dashboard.spec.ts, display.spec.ts, shell.spec.ts, report-spending.spec.ts).

export const NET_WORTH_PATH = '/reports/net-worth'
export const netWorth = (page: Page) => page.getByRole('region', { name: 'Net worth over time' })
export const LINE = /^Line chart of net worth by month/
/** The Spending by Category Report's bar chart, which is a figure named in a sentence (src/lib/charts.ts, `spendingSummary`). */
export const BARS = /^Bar chart of the/
export const spendingChart = (page: Page) => page.getByRole('img', { name: BARS })

/** The region has drawn its chart: a figure named for a screen reader holding the chart's own picture. */
export const drawn = async (region: ReturnType<typeof netWorth>, name: RegExp) => {
  const figure = region.getByRole('img', { name })
  await expect(figure).toBeVisible()
  await expect(figure.locator('svg.recharts-surface')).toBeVisible()
  return figure
}

// Net worth is not asked for until its button is pressed (it reads every Transaction of every Account, ADR 0004): these press it, and wait for the picture.
export const pressShowNetWorth = (page: Page) => netWorth(page).getByRole('button', { name: 'Show net worth' }).click()
export const showNetWorth = async (page: Page) => {
  await pressShowNetWorth(page)
  return drawn(netWorth(page), LINE)
}

/** The spending chart has drawn: its figure, named for a screen reader, holds the chart's own picture. */
export const spendingDrawn = async (page: Page, name: RegExp = BARS) => {
  const figure = page.getByRole('img', { name })
  await expect(figure).toBeVisible()
  await expect(figure.locator('svg.recharts-surface')).toBeVisible()
  return figure
}

/** Answers the net worth request with `NET_WORTH`, and keeps the address of each one the page makes: the list stays empty until the page asks. */
export async function spyNetWorth(page: Page) {
  const asked: string[] = []
  await page.route(/\/api\/charts\/net-worth/, (route) => {
    asked.push(route.request().url())
    return route.fulfill({ json: NET_WORTH })
  })
  return asked
}

/** The address of every request the page makes to the Worker's API, in order, whatever is asked: for a test that holds a page to the reads it is allowed. `stop()` ends the listing. */
export function spyApi(page: Page) {
  const asked: string[] = []
  const listen = (request: Request) => {
    const { pathname, search } = new URL(request.url())
    if (pathname.startsWith('/api/')) asked.push(pathname + search)
  }
  page.on('request', listen)
  return Object.assign(asked, { stop: () => void page.off('request', listen) })
}

// What the Worker answers when net worth is asked for: a made-up net worth of three months. Whatever range the page asks for gets the same answer.
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

/** Made-up spending by Category, the biggest first, as the Report's request answers. */
export const SPENT = [
  { categoryId: 1, name: 'Fuel', cents: 9000 },
  { categoryId: 2, name: 'Groceries', cents: 4550 },
  { categoryId: null, name: 'Uncategorised', cents: 2500 },
]
/**
 * Answers the Spending by Category Report's request (`/api/reports/spending`) with these Categories, for the dates of October 2026, and the Accounts request with one Account, so the
 * Report is made whatever the shared database holds (with none, the Report says there are no Accounts yet).
 */
export async function stubSpendingReport(page: Page, categories: object[], totalCents: number) {
  await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example everyday', accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
  await page.route(/\/api\/reports\/spending\?/, (route) => route.fulfill({ json: { from: '2026-10-01', to: '2026-10-31', totalCents, categories } }))
}
/** The Report's address for the dates `stubSpendingReport` answers for, all Accounts. */
export const SPENDING_REPORT_PATH = '/reports/spending?from=2026-10-01&to=2026-10-31'
