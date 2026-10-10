import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// The Dashboard (where the Admin lands), the Summary (where a Member does) and the Charts, against the real Worker. The light and dark projects share one local
// database, so each has two Accounts of its own, and its own months of Transactions (2004, which no other spec uses: June for light and September for dark,
// with the month before each for a second point on the net worth line), so the amounts below are the only ones in the dates a test asks about and nothing from
// another spec can pair with them as a Transfer. They are older than every other spec's Transactions on purpose: the Summary's newest five and the first
// page of the Transactions list belong to the specs that look for theirs there. Payees avoid "EXAMPLE", which other specs' Rules look for.
const dataFor = (project: string) => {
  const dark = project === 'dark'
  const month = dark ? '2004-09' : '2004-06'
  return {
    month,
    earlier: dark ? '2004-08' : '2004-05',
    everyday: { number: `99-9999-9999999-${dark ? '66' : '64'}`, name: `Dashboard everyday ${project}` },
    savings: { number: `99-9999-9999999-${dark ? '67' : '65'}`, name: `Dashboard savings ${project}` },
    words: dark ? 'September 2004' : 'June 2004',
    from: `${month}-01`,
    to: `${month}-30`,
  }
}

type Row = { day: string; id: string; payee: string; amountCents: number; category?: string; earlier?: boolean }

/** Spending $90.00 on Fuel, $45.50 on Groceries (a $10.00 refund comes off) and $25.00 that is Uncategorised, in a month that also holds a Transfer, a wage and a loan. */
const rowsFor = (project: string): { everyday: Row[]; savings: Row[] } => ({
  everyday: [
    { day: '28', id: 'E1', payee: 'DASHBOARD EARLIER', amountCents: -100, earlier: true }, // the month before: a second month for the net worth line
    { day: '03', id: 'G1', payee: 'DASHBOARD GROCERY A', amountCents: -4000, category: 'Groceries' },
    { day: '10', id: 'G2', payee: 'DASHBOARD GROCERY B', amountCents: -1550, category: 'Groceries' },
    { day: '11', id: 'G3', payee: 'DASHBOARD GROCERY REFUND', amountCents: 1000, category: 'Groceries' },
    { day: '05', id: 'F1', payee: 'DASHBOARD FUEL', amountCents: -9000, category: 'Fuel' },
    { day: '12', id: 'M1', payee: 'DASHBOARD MYSTERY', amountCents: -2500 },
    { day: '15', id: 'T1', payee: 'DASHBOARD MOVED OUT', amountCents: -50_000 }, // $500.00 to the savings Account: a Transfer, not spending
    { day: '20', id: 'W1', payee: 'DASHBOARD PAY', amountCents: 200_000, category: 'Wages and salary' }, // Income
    { day: '22', id: 'L1', payee: 'DASHBOARD LENT', amountCents: -30_000, category: 'Loans' }, // money lent: neither
  ].map((row) => ({ ...row, id: `${project}${row.id}` })),
  savings: [{ day: '15', id: `${project}T2`, payee: 'DASHBOARD MOVED IN', amountCents: 50_000 }],
})
const SPENDING = { fuel: '$90.00', groceries: '$45.50', uncategorised: '$25.00', total: '$160.50' }

/** Imports the month's Transactions (a repeat is recognised and adds none) and gives them their Categories. */
async function seed(context: BrowserContext, baseURL: string, project: string) {
  await signInAs(context, 'admin')
  const headers = { Origin: baseURL }
  const { month, earlier, everyday, savings, to } = dataFor(project)
  const rows = rowsFor(project)
  for (const [account, list, ledgerCents] of [[everyday, rows.everyday, 1_000_000], [savings, rows.savings, 50_000]] as const) {
    const imported = await context.request.post('/api/imports/chunks', {
      headers,
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: list.length, skipped: 0, from: `${earlier}-01`, to, ledgerBalance: { cents: ledgerCents, date: to } },
        rows: list.map((r) => ({ date: `${r.earlier ? earlier : month}-${r.day}`, uniqueId: r.id, tranType: 'TFR', chequeNumber: null, payee: r.payee, bankMemo: '', amountCents: r.amountCents })),
      },
    })
    expect(imported.ok()).toBe(true)
  }
  const categories = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  for (const row of rows.everyday) {
    if (!row.category) continue
    const found = await context.request.get(`/api/transactions?text=${encodeURIComponent(row.payee)}&from=${month}-01&to=${to}&count=false`)
    const { transactions } = (await found.json()) as { transactions: { id: number }[] }
    const override = await context.request.put(`/api/transactions/${transactions[0]!.id}/override`, { headers, data: { categoryId: categories.find((c) => c.name === row.category)!.id } })
    expect(override.ok()).toBe(true)
  }
}

const dollars = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const darkClass = (dark: boolean) => (dark ? /dark/ : /^(?!.*dark)/)
const sizeButton = (page: Page, name: 'A' | 'A+' | 'A++') => page.getByRole('group', { name: 'Text size' }).getByRole('button', { name, exact: true })

const netWorth = (page: Page) => page.getByRole('region', { name: 'Net worth over time' })
const spending = (page: Page) => page.getByRole('region', { name: 'Spending by Category' })
/** The region has drawn its chart: a figure named for a screen reader holding the chart's own picture. */
const drawn = async (region: ReturnType<typeof netWorth>, name: RegExp) => {
  const figure = region.getByRole('img', { name })
  await expect(figure).toBeVisible()
  await expect(figure.locator('svg.recharts-surface')).toBeVisible()
  return figure
}

/** Shows spending between two dates, as the person who chooses dates does. */
async function chooseDates(page: Page, from: string, to: string) {
  await spending(page).getByLabel('Period', { exact: true }).selectOption('custom')
  await spending(page).getByLabel('From', { exact: true }).fill(from)
  await spending(page).getByLabel('To', { exact: true }).fill(to)
}

// The same API as the pages, so the tests can say what the pages should show.
const balancesNow = async (context: BrowserContext) => {
  const { accounts } = (await (await context.request.get('/api/balances')).json()) as { accounts: { balanceCents: number | null }[] }
  return accounts.reduce((sum, a) => sum + (a.balanceCents ?? 0), 0)
}

test.describe.configure({ mode: 'serial' })

test('the Admin lands on the Dashboard: their tools, every part of the Summary, and the charts', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(page.locator('html')).toHaveClass(darkClass(testInfo.project.name === 'dark'))

  // The navigation calls the Admin's landing page the Dashboard, and has no separate Summary.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Summary' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Charts' })).toBeVisible()

  // The Admin's tools lead to the Admin's pages.
  const tools = page.getByRole('region', { name: 'Your tools' })
  for (const [name, href] of [['Import', '/import'], ['Uncategorised', '/uncategorised'], ['Rules', '/rules'], ['Categories', '/categories'], ['Budgets', '/budgets'], ['Settings', '/settings']]) {
    await expect(tools.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute('href', href!)
  }

  // Everything the Summary shows is here too: they are the same parts.
  for (const name of ['Balances', 'Budget vs actual', 'Recent transactions']) await expect(page.getByRole('region', { name })).toBeVisible()

  // And the charts, drawn from the data.
  await drawn(netWorth(page), /^Line chart of net worth by month/)
  await expect(spending(page).getByRole('combobox', { name: 'Period' })).toHaveValue('this-month')
  await expect(spending(page).getByRole('heading', { level: 2 })).toBeVisible()
  await noAxeViolations(page)
})

test('a Member lands on the Summary, which leads to the Charts, and sees none of the Admin\'s tools', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Your tools' })).toHaveCount(0)
  // The Summary draws no chart itself; it leads to them.
  await expect(page.locator('svg.recharts-surface')).toHaveCount(0)

  await page.getByRole('region', { name: 'Charts' }).getByRole('link', { name: 'See the charts' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Charts' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Charts' })).toHaveAttribute('aria-current', 'page')
  await drawn(netWorth(page), /^Line chart of net worth by month/)
  await expect(spending(page)).toBeVisible()
})

test('a Member\'s Summary and the Dashboard have the same Balances, so the Dashboard cannot disagree with the Summary', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  const balances = page.getByRole('region', { name: 'Balances' })
  // Read once the Accounts have arrived, or both would be "Loading…".
  const loaded = () => expect(balances.getByRole('row', { name: new RegExp(dataFor(testInfo.project.name).everyday.name) })).toBeVisible()
  await signInAs(context, 'member')
  await page.goto('/')
  await loaded()
  const asMember = await balances.innerText()
  await signInAs(context, 'admin')
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await loaded()
  expect(await balances.innerText()).toBe(asMember)
})

test('net worth is the Accounts\' balances added up: the newest figure is the Balances\' total, and the line is drawn', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  const total = await balancesNow(context)
  await signInAs(context, 'member')
  await page.goto('/charts')

  const figure = await drawn(netWorth(page), /^Line chart of net worth by month/)
  await expect(figure.locator('path.recharts-line-curve')).toHaveAttribute('d', /^M[\d.]+/)
  // The figures are under "Show the figures", newest first; they are what a screen reader and the table hold.
  await netWorth(page).getByText('Show the figures').click()
  const newest = netWorth(page).getByRole('row').nth(1)
  await expect(newest).toContainText(dollars(total))
  await expect(netWorth(page).getByRole('table', { name: 'Net worth at the end of each month, newest first' })).toBeVisible()
  // The sentence for a screen reader says where the line ends, in the same dollars.
  expect(await figure.getAttribute('aria-label')).toContain(dollars(total))
})

test('net worth\'s figures open from the keyboard, and the control is a touch target', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/charts')
  await drawn(netWorth(page), /^Line chart of net worth by month/)
  const summary = netWorth(page).getByText('Show the figures')
  expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(netWorth(page).getByRole('table')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(netWorth(page).getByRole('table')).toBeHidden()
})

test('spending by Category for dates the reader chooses leaves out the Transfer, the wage and the loan, and the figures are in a table', async ({ page, context, baseURL }, testInfo) => {
  const { words, from, to } = dataFor(testInfo.project.name)
  await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/charts')
  await chooseDates(page, from, to)

  const table = spending(page).getByRole('table', { name: `Spending by Category in ${words}` })
  await expect(table.getByRole('row')).toHaveCount(4) // the heading and three Categories
  const rows = table.getByRole('row')
  await expect(rows.nth(1)).toContainText('Fuel')
  await expect(rows.nth(1)).toContainText(SPENDING.fuel)
  await expect(rows.nth(2)).toContainText('Groceries')
  await expect(rows.nth(2)).toContainText(SPENDING.groceries) // $40.00 and $15.50, less a $10.00 refund
  await expect(rows.nth(3)).toContainText('Uncategorised')
  await expect(rows.nth(3)).toContainText(SPENDING.uncategorised)
  // The $500.00 Transfer, $2,000.00 wage and $300.00 loan are in none of it.
  await expect(spending(page).getByText(`Total spending in ${words}: ${SPENDING.total}`)).toBeVisible()
  await expect(table).not.toContainText('Wages and salary')
  await expect(table).not.toContainText('Loans')
  await expect(table).not.toContainText('$500.00')
  await expect(table).not.toContainText('$2,000.00')
  await expect(table).not.toContainText('$300.00')

  const figure = await drawn(spending(page), new RegExp(`^Bar chart of the 3 Categories that spent the most in ${words}`))
  expect(await figure.locator('.recharts-bar-rectangle').count()).toBe(3)
})

test('a period the Worker names is asked for by name, and a mistake in the dates is explained and not asked about', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/charts')
  const region = spending(page)
  await expect(region.getByRole('combobox', { name: 'Period' })).toHaveValue('this-month')

  const asked = page.waitForRequest((request) => request.url().includes('/api/charts/spending?period=last-month'))
  await region.getByLabel('Period', { exact: true }).selectOption('last-month')
  await asked
  const lastMonth = new Date(new Date().toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }))
  lastMonth.setDate(1)
  lastMonth.setMonth(lastMonth.getMonth() - 1)
  await expect(region).toContainText(lastMonth.toLocaleString('en-NZ', { month: 'long', year: 'numeric' }))

  // Dates the wrong way round: the To date is marked and explained, and nothing more is asked of the Worker.
  await region.getByLabel('Period', { exact: true }).selectOption('custom')
  const requests: string[] = []
  page.on('request', (request) => request.url().includes('/api/charts/spending') && requests.push(request.url()))
  await region.getByLabel('From', { exact: true }).fill('2034-06-30')
  await region.getByLabel('To', { exact: true }).fill('2034-06-01')
  await expect(region.getByRole('alert')).toHaveText('The “To” date is before the “From” date. Change one of them to see the chart.')
  await expect(region.getByLabel('To', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  expect(requests).toEqual([])

  // Putting them right asks, and the explanation goes.
  await region.getByLabel('To', { exact: true }).fill('2034-06-30')
  await expect(region.getByRole('alert')).toHaveCount(0)
  await expect.poll(() => requests.some((url) => url.includes('from=2034-06-30') && url.includes('to=2034-06-30'))).toBe(true)
})

test('the charts have no WCAG 2.2 AA violations in this theme, with their data, at the largest text size, and on a phone', async ({ page, context, baseURL }, testInfo) => {
  const { from, to, words } = dataFor(testInfo.project.name)
  await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  for (const viewport of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/charts')
    await expect(page.locator('html')).toHaveClass(darkClass(testInfo.project.name === 'dark'))
    await sizeButton(page, 'A++').click()
    await expect(sizeButton(page, 'A++')).toHaveAttribute('aria-pressed', 'true')
    await chooseDates(page, from, to)
    await drawn(netWorth(page), /^Line chart of net worth by month/)
    await drawn(spending(page), new RegExp(`^Bar chart of the 3 Categories that spent the most in ${words}`))
    await netWorth(page).getByText('Show the figures').click() // the table is part of what is scanned
    await expect(netWorth(page).getByRole('table').or(netWorth(page).getByRole('list', { name: /Net worth at the end of each month/ }))).toBeVisible()
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
    await noAxeViolations(page)
  }
})

test('the chart colours are the theme\'s, drawn in the text colour when Windows high contrast is on, and nothing moves', async ({ page, context, baseURL }, testInfo) => {
  const { from, to } = dataFor(testInfo.project.name)
  await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/charts')
  const line = netWorth(page).locator('path.recharts-line-curve')
  const bar = spending(page).locator('.recharts-bar-rectangle path').first()
  await chooseDates(page, from, to)
  await expect(line).toBeVisible()
  await expect(bar).toBeVisible()

  // Nothing is animating in a chart, whatever the reader's motion setting: it draws itself at once.
  expect(await page.evaluate(() => document.querySelector('[data-slot="chart"]')!.getAnimations({ subtree: true }).length)).toBe(0)

  const stroke = (locator: typeof line) => locator.evaluate((el) => getComputedStyle(el).stroke)
  const themed = await stroke(line)
  const text = await page.locator('body').evaluate((el) => getComputedStyle(el).color)
  expect(themed).not.toBe(text) // the theme's own chart colour, not the page's text

  await page.emulateMedia({ forcedColors: 'active' })
  const canvasText = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'CanvasText'
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })
  expect(await stroke(line)).toBe(canvasText)
  expect(await bar.evaluate((el) => getComputedStyle(el).fill)).toBe(canvasText)
})

test.describe('when the answers are not the usual ones', () => {
  test('says so when net worth has more Accounts than can be added up, and when some have no balance yet', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.route('**/api/charts/net-worth', (route) => route.fulfill({ json: { counted: [], notCounted: [], points: [], tooManyAccounts: { count: 52, limit: 49 } } }))
    await page.goto('/charts')
    await expect(netWorth(page)).toContainText('Net worth can be drawn for up to 49 Accounts, and this Fernledger has 52.')
    await expect(netWorth(page).locator('svg.recharts-surface')).toHaveCount(0)

    await page.unroute('**/api/charts/net-worth')
    await page.route('**/api/charts/net-worth', (route) =>
      route.fulfill({
        json: {
          counted: [{ accountId: 1, accountName: 'Example everyday' }],
          notCounted: [{ accountId: 2, accountName: 'Example credit card' }, { accountId: 3, accountName: 'Example savings' }],
          points: [{ date: '2026-08-31', cents: 100_000 }, { date: '2026-09-30', cents: -50_000 }, { date: '2026-10-07', cents: 123_456 }],
          tooManyAccounts: null,
        },
      }),
    )
    await page.reload()
    await expect(netWorth(page)).toContainText('Not counted yet: Example credit card, Example savings. They have no bank balance to work from, so their balance is not in the total.')
    const figure = await drawn(netWorth(page), /^Line chart of net worth by month/)
    expect(await figure.getAttribute('aria-label')).toContain('It was $1,000.00 at the end of August 2026 and $1,234.56 on Wed 7 Oct 2026.')
    await netWorth(page).getByText('Show the figures').click()
    await expect(netWorth(page).getByRole('row').nth(2)).toContainText('−$500.00') // a real minus sign, and the middle month
  })

  test('says so when there is nothing to draw', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.route('**/api/charts/net-worth', (route) => route.fulfill({ json: { counted: [], notCounted: [], points: [], tooManyAccounts: null } }))
    await page.route(/\/api\/charts\/spending\?/, (route) => route.fulfill({ json: { from: '2026-10-01', to: '2026-10-31', totalCents: 0, categories: [] } }))
    await page.goto('/charts')
    await expect(netWorth(page)).toContainText('There are no Accounts yet, so there is no net worth to draw.')
    await expect(spending(page)).toContainText('Nothing was spent in October 2026.')
    await expect(spending(page).locator('svg.recharts-surface')).toHaveCount(0)
  })

  test.describe('when the Worker fails', () => {
    test.use({ expectedStatuses: [500] })

    test('tells the reader to try again instead of drawing nothing', async ({ page, context }) => {
      await signInAs(context, 'member')
      await page.route('**/api/charts/net-worth', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.route(/\/api\/charts\/spending\?/, (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto('/charts')
      await expect(netWorth(page).getByRole('alert')).toHaveText("Fernledger couldn't load net worth. Reload the page to try again.")
      await expect(spending(page).getByRole('alert')).toContainText("Fernledger couldn't load the spending.")
    })
  })
})
