import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'

// Ticket 20: the spending-by-Category Report (spec story 93). It uses the Report frame of ticket 18, so it opens in a new window, says on its face
// what it is, and prints with its table heading on every page. The Report's numbers are held to the Worker's spending totals in
// worker/report-spending.test.ts; this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it
// makes (page count, the text on each page, the margins and the size of the type).

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const MEMBER_EMAIL = 'dev.member@example.com'
const TITLE = `Mum's "family" finances \\ Report` // quote, apostrophe and backslash: the Admin can type any of them
const NOW = new Date('2026-10-08T02:42:00.000Z') // 3:42 pm in NZ
const GENERATED = `Generated Thu 8 Oct 2026 at 3:42 pm by ${MEMBER_EMAIL}`

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2021 and 2022), and a Report of that
// year lists only that project's Transactions even for every Account. No other spec uses these years.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  return {
    project,
    year: light ? 2021 : 2022,
    everyday: { number: light ? '99-9999-9999999-74' : '99-9999-9999999-76', name: `Spending everyday ${project}` },
    savings: { number: light ? '99-9999-9999999-75' : '99-9999-9999999-77', name: `Spending savings ${project}` },
    income: { number: light ? '99-9999-9999999-78' : '99-9999-9999999-79', name: `Spending income only ${project}` },
    rates: `Rates ${project}`,
    fuel: `Fuel ${project}`,
    food: `Food ${project}`,
    back: `Money back ${project}`,
    pay: `Pay ${project}`,
    loan: `Loan ${project}`,
  }
}

// Dates and money, written the way the app writes them.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const dateText = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
/** What a Spent cell says: no sign, and "back" after an amount that is less than nothing. */
const spent = (cents: number) => `$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}${cents < 0 ? ' back' : ''}`

// What the year holds, by Account, in cents (money out is negative). The Transfer, the wages (Income) and the loan are not Spending.
const EVERYDAY = { rates: 30_000, fuel: 9000, food: 5550, back: -2500, uncategorised: 400 }
const SAVINGS = { food: 2000 }
const ALL = { rates: EVERYDAY.rates, fuel: EVERYDAY.fuel, food: EVERYDAY.food + SAVINGS.food, back: EVERYDAY.back, uncategorised: EVERYDAY.uncategorised }
const total = (figures: Record<string, number>) => Object.values(figures).reduce((sum, cents) => sum + cents, 0)

type Seeded = { everydayId: number; savingsId: number; incomeId: number }
const seeded = new Map<string, Seeded>()

type Row = { date: string; payee: string; amountCents: number; category?: string }
/** The project's three Accounts and their Categories and Transactions (see EVERYDAY). Safe to repeat: an Import recognises rows it already holds. */
async function seed(context: BrowserContext, baseURL: string, project: string): Promise<Seeded> {
  const known = seeded.get(project)
  if (known) return known
  const d = dataFor(project)
  const { year } = d
  const headers = { Origin: baseURL }
  await signInAs(context, 'admin')

  // Categories of this project's own, found again if an earlier run left them.
  const existing = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  const categoryId = async (name: string, kind: 'spending' | 'income' | 'loans') => {
    const found = existing.find((c) => c.name === name)
    if (found) return found.id
    const res = await context.request.post('/api/categories', { headers, data: { name, kind } })
    expect(res.ok()).toBe(true)
    return ((await res.json()) as { id: number }).id
  }
  const categories: Record<string, number> = {
    [d.rates]: await categoryId(d.rates, 'spending'),
    [d.fuel]: await categoryId(d.fuel, 'spending'),
    [d.food]: await categoryId(d.food, 'spending'),
    [d.back]: await categoryId(d.back, 'spending'),
    [d.pay]: await categoryId(d.pay, 'income'),
    [d.loan]: await categoryId(d.loan, 'loans'),
  }

  const say = (what: string) => `SPENDRPT ${project} ${what}`
  const everydayRows: Row[] = [
    { date: `${year}-01-10`, payee: say('food 1'), amountCents: -4000, category: d.food },
    { date: `${year}-02-05`, payee: say('food 2'), amountCents: -2550, category: d.food },
    { date: `${year}-02-20`, payee: say('food refund'), amountCents: 1000, category: d.food }, // a refund comes off
    { date: `${year}-03-03`, payee: say('fuel'), amountCents: -9000, category: d.fuel },
    { date: `${year}-03-15`, payee: say('rates'), amountCents: -30_000, category: d.rates },
    { date: `${year}-04-10`, payee: say('money back'), amountCents: 2500, category: d.back }, // more came back than went out
    { date: `${year}-04-02`, payee: say('nobody has a Category for this'), amountCents: -700 },
    { date: `${year}-04-03`, payee: say('a payment in with no Category'), amountCents: 300 },
    { date: `${year}-01-15`, payee: say('wages'), amountCents: 250_000, category: d.pay }, // Income: not Spending
    { date: `${year}-03-20`, payee: say('a loan'), amountCents: -50_000, category: d.loan }, // Loans: not Spending
    { date: `${year}-05-05`, payee: say('to savings'), amountCents: -20_000 }, // the other half is in Savings: a Transfer
  ]
  const savingsRows: Row[] = [
    { date: `${year}-01-12`, payee: say('food in savings'), amountCents: -2000, category: d.food },
    { date: `${year}-05-05`, payee: say('from everyday'), amountCents: 20_000 },
  ]
  // An Account with a Transaction but no Spending: the Report for it has nothing to add up.
  const incomeRows: Row[] = [{ date: `${year}-09-09`, payee: say('wages in the Income-only Account'), amountCents: 100_000, category: d.pay }]
  const importRows = async (account: { number: string; name: string }, rows: Row[], tag: string) => {
    const res = await context.request.post('/api/imports/chunks', {
      headers,
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: `${year}-01-01`, to: `${year}-12-31`, ledgerBalance: { cents: 0, date: `${year}-12-31` } },
        rows: rows.map((r, i) => ({ date: r.date, uniqueId: `SPR${year}${tag}${i}`, tranType: 'EFTPOS', chequeNumber: null, payee: r.payee, bankMemo: 'EFTPOS', amountCents: r.amountCents })),
      },
    })
    expect(res.ok()).toBe(true)
  }
  await importRows(d.everyday, everydayRows, 'E')
  await importRows(d.savings, savingsRows, 'S') // the second Account pairs its $200.00 in with the first's $200.00 out
  await importRows(d.income, incomeRows, 'I')

  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const idOf = (name: string) => accounts.find((a) => a.name === name)!.id
  const result = { everydayId: idOf(d.everyday.name), savingsId: idOf(d.savings.name), incomeId: idOf(d.income.name) }
  for (const [accountId, rows] of [[result.everydayId, everydayRows], [result.savingsId, savingsRows], [result.incomeId, incomeRows]] as const) {
    const { transactions } = (await (await context.request.get(`/api/transactions?accountId=${accountId}&from=${year}-01-01&to=${year}-12-31&limit=200&count=false`)).json()) as { transactions: { id: number; description: string }[] }
    expect(transactions).toHaveLength(rows.length)
    for (const row of rows) {
      if (!row.category) continue
      const found = transactions.find((t) => t.description === row.payee)
      expect(found, row.payee).toBeDefined()
      expect((await context.request.put(`/api/transactions/${found!.id}/override`, { headers, data: { categoryId: categories[row.category] } })).ok()).toBe(true)
    }
  }
  seeded.set(project, result)
  return result
}

// The Settings are shared by every test and both themes, so each test leaves the defaults behind (as reports.spec.ts does).
test.afterEach(async ({ request, baseURL }) => {
  const reset = await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title: 'Fernledger' } })
  expect(reset.ok()).toBe(true)
})
const setTitle = async (request: APIRequestContext, baseURL: string | undefined, app_title: string) =>
  expect((await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title } })).ok()).toBe(true)

/** The Report's address: `account` is left out for every Account. */
const address = (account: number | null, from: string, to: string) => `/reports/spending?${account === null ? '' : `account=${account}&`}from=${from}&to=${to}`
const wholeYear = (year: number) => ({ from: `${year}-01-01`, to: `${year}-12-31` })
const article = (page: Page) => page.getByRole('article', { name: 'Spending by Category' })
const tableOf = (page: Page) => article(page).getByRole('table', { name: 'Spending in each Category' })
const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('the Reports page offers it with a form of its own, for all Accounts or one, and opens it in a new window', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Spending by Category' })).toBeVisible()

    const form = page.getByRole('form', { name: 'Spending by Category' })
    await expect(form.getByLabel('Account')).toHaveValue('') // every Account unless one is chosen
    await form.getByLabel('From').fill(`${d.year}-01-01`)
    await form.getByLabel('To').fill(`${d.year}-12-31`)
    const [all] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(all.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
    expect(new URL(all.url()).pathname).toBe('/reports/spending')
    expect(Object.fromEntries(new URL(all.url()).searchParams)).toEqual({ account: '', from: `${d.year}-01-01`, to: `${d.year}-12-31` })
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible() // the Reports page is still where it was

    await form.getByLabel('Account').selectOption({ label: d.everyday.name })
    const [one] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(one.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
    expect(Object.fromEntries(new URL(one.url()).searchParams)).toEqual({ account: String(everydayId), from: `${d.year}-01-01`, to: `${d.year}-12-31` })
  })

  test('the Reports page has no WCAG 2.2 AA violations with all three forms on it', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(page.getByRole('form')).toHaveCount(3)
    await noAxeViolations(page)
  })

  test('its form asks for real dates, in order, and opens nothing until they are', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/reports')
    const form = page.getByRole('form', { name: 'Spending by Category' })
    const open = form.getByRole('button', { name: 'Open Report in a new window' })

    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await form.getByLabel('From').fill('2022-12-31')
    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await form.getByLabel('To').fill('2022-01-01')
    await open.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(form.getByLabel('To')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('form', { name: 'Transaction listing' }).getByRole('alert')).toHaveCount(0) // the other forms are untouched
    expect(context.pages()).toHaveLength(1)
  })

  test('an address without dates, with dates the wrong way round, or with no such Account explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const [path, words, alert] of [
      ['/reports/spending', 'Choose the first and last dates', false],
      ['/reports/spending?from=2022-12-31&to=2022-01-01', 'before the “From” date', true],
      ['/reports/spending?account=999999999&from=2022-01-01&to=2022-12-31', 'There is no such Account', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status')).toContainText(words)
      await expect(page.getByRole('button', { name: 'Open Report in a new window' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without dates
    }
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const { year } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.addInitScript(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => void ((window as unknown as { printed: number }).printed += 1)
    })
    await page.goto(address(null, `${year}-01-01`, `${year}-12-31`))
    await page.getByRole('button', { name: 'Print or save as PDF' }).click()
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// On screen

test.describe('on screen', () => {
  test.beforeEach(async ({ context }) => {
    await context.clock.setFixedTime(NOW) // keeps running; only the date is fixed
  })

  /** The table's Categories and what each spent, as the page words them, once the Report has loaded. */
  const rowsOf = async (page: Page) => {
    await expect(tableOf(page)).toBeVisible()
    return {
      names: await tableOf(page).locator('tbody tr td:nth-child(1)').allTextContents(),
      spent: await tableOf(page).locator('tbody tr td:nth-child(2)').allTextContents(),
    }
  }

  test('has the title block, what is counted, the total, and a row for each Category, largest first, with Uncategorised on its own', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))

    const report = article(page)
    await expect(report.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText('Account: All Accounts: ')
    await expect(header).toContainText(`${d.everyday.name} (${d.everyday.number})`) // each Account, with its bank number
    await expect(header).toContainText(`${d.savings.name} (${d.savings.number})`)
    await expect(header).toContainText(`Dates: ${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`)
    await expect(header).toContainText(GENERATED)

    // Said before the figures: what Spending is, that Uncategorised counts, and what is left out.
    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('less any money that came back, such as a refund')
    await expect(about).toContainText('Transactions that have no Category yet count as Spending too')
    await expect(about).toContainText('Transfers between your own Accounts, Pending Transactions, Loans and Income are not Spending')

    const section = report.getByRole('region', { name: 'Spending in each Category' })
    await expect(section.locator('dl')).toContainText('Total spending')
    await expect(section.locator('dl')).toContainText(spent(total(ALL)))
    const table = tableOf(page)
    await expect(table.getByRole('columnheader')).toHaveText(['Category', 'Spent'])
    // Largest first; what came back is below the rest; Uncategorised is last and its own row.
    expect(await rowsOf(page)).toEqual({
      names: [d.rates, d.fuel, d.food, d.back, 'Uncategorised'],
      spent: [spent(ALL.rates), spent(ALL.fuel), spent(ALL.food), spent(ALL.back), spent(ALL.uncategorised)],
    })
    await expect(table.locator('tbody tr').nth(3)).toContainText('$25.00 back')
    // The wages (Income), the loan and the Transfer are not Spending, and so are not here.
    await expect(report).not.toContainText(d.pay)
    await expect(report).not.toContainText(d.loan)
    await expect(report).not.toContainText('$200.00')
    await expect(report).not.toContainText('$2,500.00')
    await expect(report).not.toContainText('$500.00')
    // The line that says what a page is belongs to paper: it is in the table's heading, and not on screen.
    await expect(table.locator('thead tr')).toHaveCount(2)
    await expect(table.locator('thead tr').first()).toBeHidden()
  })

  test('totals only the Account chosen, and says which; an Account\'s Transfer is not its Spending', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId, savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.everyday.name} (${d.everyday.number})`)
    expect(await rowsOf(page)).toEqual({
      names: [d.rates, d.fuel, d.food, d.back, 'Uncategorised'],
      spent: [spent(EVERYDAY.rates), spent(EVERYDAY.fuel), spent(EVERYDAY.food), spent(EVERYDAY.back), spent(EVERYDAY.uncategorised)],
    })
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' }).locator('dl')).toContainText(spent(total(EVERYDAY)))

    await page.goto(address(savingsId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.savings.name} (${d.savings.number})`)
    expect(await rowsOf(page)).toEqual({ names: [d.food], spent: [spent(SAVINGS.food)] }) // the $200.00 that came in is a Transfer: no Uncategorised row
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' }).locator('dl')).toContainText(spent(SAVINGS.food))
  })

  test('adds up only the dates asked for, both ends included, across months', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    // January to March: everything but April's two Categories-less payments and its money back.
    await page.goto(address(null, `${d.year}-01-10`, `${d.year}-03-15`))
    expect(await rowsOf(page)).toEqual({ names: [d.rates, d.fuel, d.food], spent: [spent(ALL.rates), spent(ALL.fuel), spent(ALL.food)] })
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' }).locator('dl')).toContainText(spent(ALL.rates + ALL.fuel + ALL.food))

    // One day.
    await page.goto(address(null, `${d.year}-03-03`, `${d.year}-03-03`))
    expect(await rowsOf(page)).toEqual({ names: [d.fuel], spent: [spent(ALL.fuel)] })
    await expect(article(page).locator('header dl div').filter({ hasText: 'Dates:' })).toHaveText(`Dates: ${dateText(`${d.year}-03-03`)}`) // one date, not "… to …"
  })

  test('says "back" for a total that is less than nothing, as it does for a Category', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-04-01`, `${d.year}-04-30`)) // $25.00 back and $4.00 Uncategorised
    expect(await rowsOf(page)).toEqual({ names: [d.back, 'Uncategorised'], spent: ['$25.00 back', '$4.00'] })
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' }).locator('dl')).toContainText('$21.00 back')
  })

  test('says there is no Spending, and shows no table or total, for dates with none', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-06-01`, `${d.year}-06-30`))
    const section = article(page).getByRole('region', { name: 'Spending in each Category' })
    await expect(section).toContainText('No Spending in these dates.')
    await expect(section.getByRole('table')).toHaveCount(0)
    await expect(section.locator('dl')).toHaveCount(0)
    await expect(article(page).getByRole('region', { name: 'About these figures' })).toBeVisible()
  })

  test('says there is no Spending for an Account whose only Transaction is Income, and does not count its wages', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { incomeId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(incomeId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.income.name} (${d.income.number})`)
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' })).toContainText('No Spending in these dates.')
    await expect(article(page).getByRole('table')).toHaveCount(0)
    await expect(article(page)).not.toContainText('$1,000.00')
  })

  test('is titled for Save as PDF: the app, the Report, the Accounts and the dates', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    const range = `${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – Spending by Category – All Accounts – ${range}`)
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – Spending by Category – ${d.everyday.name} – ${range}`)
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}, with money back and Uncategorised to show`, async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, role)
      await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
      await expect(tableOf(page)).toBeVisible()
      await expect(tableOf(page)).toContainText('$25.00 back')
      await expect(tableOf(page)).toContainText('Uncategorised')
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    const cards = article(page).getByRole('list', { name: 'Spending in each Category' }).getByRole('listitem')
    await expect(cards).toHaveCount(5)
    await expect(cards.first()).toContainText(d.rates)
    await expect(cards.first()).toContainText(spent(EVERYDAY.rates))
    await expect(cards.first()).toContainText('Spent')
    await expect(cards.last()).toContainText('Uncategorised')
  })

  test('shows every Member the same Report as the Admin', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['member', 'admin'] as const) {
      await signInAs(context, role)
      await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
      await expect(tableOf(page)).toBeVisible()
      seen.push(JSON.stringify(await rowsOf(page)))
    }
    expect(seen[0]).toBe(seen[1])
  })

  test.describe('when the request fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: spending that was not read never looks like none', async ({ page, context, baseURL }, testInfo) => {
      const d = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'member')
      await page.route('**/api/reports/spending?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByText('No Spending in these dates.')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Printed

test.describe('printed', () => {
  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(tableOf(page)).toBeVisible()
  })

  const range = (year: number) => `${dateText(`${year}-01-01`)} to ${dateText(`${year}-12-31`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
    await expect(page.getByRole('link')).toHaveCount(0)
    await expect(page.getByText('In the print window')).toBeHidden()
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const header = article(page).locator('header')
    await expect(header).toBeVisible()
    await expect(header.getByText(TITLE, { exact: true })).toBeVisible() // the Admin's words, as typed
    await expect(header.getByRole('heading', { level: 1, name: 'Spending by Category' })).toBeVisible()
    await expect(header).toContainText(`Account: ${d.everyday.name} (${d.everyday.number})`)
    await expect(header).toContainText(`Dates: ${range(d.year)}`)
    await expect(header.getByText(GENERATED, { exact: true })).toBeVisible()
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const identity = page.locator('thead tr').first()
    await expect(identity).toBeVisible() // on screen it is not
    await expect(identity).toContainText(`${TITLE} – Spending by Category – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`)
    await expect(identity).toContainText(GENERATED)
    // It is one of the table's heading rows, with the column headings: that is what makes a browser repeat it.
    expect(await page.locator('thead').evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Spending by Category – ${d.everyday.name} – ${range(d.year)}`)
  })

  /** Every word of the Report is black, including the muted ones and the money, and the paper is white. */
  const blackOnWhite = (page: Page) =>
    page.evaluate(() => {
      const rgb = (css: string) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.fillStyle = '#fff'
        ctx.fillStyle = css
        ctx.fillRect(0, 0, 1, 1)
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
      }
      const walker = document.createTreeWalker(document.querySelector('.report-frame')!, NodeFilter.SHOW_TEXT)
      const unreadable: string[] = []
      let texts = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        texts += 1
        const [r, g, b] = rgb(getComputedStyle(node.parentElement!).color)
        if (Math.max(r!, g!, b!) > 40) unreadable.push(`${node.textContent.trim().slice(0, 30)}: rgb(${r}, ${g}, ${b})`)
      }
      return { unreadable, paper: rgb(getComputedStyle(document.body).backgroundColor), texts }
    })

  test('is black text on white paper, even from the dark theme', async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    const found = await blackOnWhite(page)
    expect(found.texts).toBeGreaterThan(20)
    expect(found.unreadable).toEqual([]) // every word, including the money and "back", is black
    expect(Math.min(...found.paper)).toBeGreaterThan(240)
  })

  test('has no text under 12pt', async ({ page }) => {
    const small = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.report-frame')!, NodeFilter.SHOW_TEXT)
      const found: string[] = []
      let texts = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        texts += 1
        const size = parseFloat(getComputedStyle(node.parentElement!).fontSize)
        if (size < 16) found.push(`${size}px: ${node.textContent.trim().slice(0, 30)}`)
      }
      return { found, texts }
    })
    expect(small.texts).toBeGreaterThan(20)
    expect(small.found).toEqual([]) // 12pt is 16px
    // The table's own text is set to 12pt, not left to the 15px it has on screen.
    const cell = await article(page).locator('tbody td').first().evaluate((el) => getComputedStyle(el).fontSize)
    expect(parseFloat(cell)).toBeGreaterThanOrEqual(16)
  })

  test('is its own page with its own margins, repeats the table heading and keeps a row whole', async ({ page }) => {
    const styles = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
      return { page: style('.report-frame').page, thead: style('thead').display, row: style('tbody tr').breakInside, main: style('main').paddingLeft }
    })
    expect(styles).toEqual({ page: 'report', thead: 'table-header-group', row: 'avoid', main: '0px' })
  })

  test('prints on one A4 page with the Categories, the total and the page number, every figure in at least 12pt type', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages).toHaveLength(1)
    const text = textOf(pages[0]!)
    for (const [name, cents] of [[d.rates, EVERYDAY.rates], [d.fuel, EVERYDAY.fuel], [d.food, EVERYDAY.food], [d.back, EVERYDAY.back], ['Uncategorised', EVERYDAY.uncategorised]] as const) {
      expect(text, name).toContain(`${name} ${spent(cents)}`)
    }
    expect(text).toContain(`Total spending ${spent(total(EVERYDAY))}`)
    expect(text).toContain('Page 1 of 1')
    expect(pages.flatMap((p, index) => p.text.filter((t) => t.size < 11.95).map((t) => `page ${index + 1}: ${t.size}pt "${t.str}"`))).toEqual([])
  })

  test('prints the same from a phone-width window: still a table', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(tableOf(page)).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })
})

// A Report with more Categories than a page holds. The data is stubbed so the test adds no Categories for the other specs to find.
test.describe('printed over several pages', () => {
  const CATEGORIES = 80
  const name = (i: number) => `Stub category ${String(i + 1).padStart(2, '0')}`
  /** Every Category's figure is different, so a row can be told from the others in a PDF; they are given largest first. */
  const cents = (i: number) => 100_000 - i * 137

  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { everydayId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.route('**/api/reports/spending?**', (route) =>
      route.fulfill({
        json: {
          accountId: everydayId,
          ...wholeYear(d.year),
          categories: Array.from({ length: CATEGORIES }, (_, i) => ({ categoryId: i + 1, categoryName: name(i), cents: cents(i) })),
          uncategorisedCents: 12_345,
          totalCents: Array.from({ length: CATEGORIES }, (_, i) => cents(i)).reduce((sum, c) => sum + c, 0) + 12_345,
        },
      }),
    )
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(everydayId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(tableOf(page)).toBeVisible()
  })

  test('is several A4 pages with the table headings on every one, no Category lost, repeated or cut across pages', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const withRows = pages.filter((p) => textOf(p).includes('Stub category'))
    expect(withRows.length).toBeGreaterThanOrEqual(2)
    // Headings come back on every page the table runs onto, not only the first.
    for (const p of withRows) for (const heading of ['Category', 'Spent']) expect(p.text.map((t) => t.str), `${heading} on page ${pages.indexOf(p) + 1}`).toContain(heading)

    // Every Category is on exactly one page, as one row: its name and what it spent.
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    for (let i = 0; i < CATEGORIES; i++) {
      const row = `${name(i)} ${spent(cents(i))}`
      expect(all.split(row).length - 1, row).toBe(1)
    }
    expect(all.split('Uncategorised $123.45').length - 1).toBe(1)
  })

  test('says what the Report is, which Account and dates, and who generated it and when, at the top of every page the table runs onto', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const withRows = pages.filter((p) => textOf(p).includes('Stub category'))
    expect(withRows.length).toBeGreaterThanOrEqual(2)
    // In each page's own body, not its margins, so every browser prints it. The Admin's title comes through as typed, quote and backslash too.
    // (The line may wrap, even inside the Account's number at a hyphen, so the comparison ignores where it broke.)
    const squash = (text: string) => text.replace(/\s+/g, '')
    for (const p of withRows) {
      const text = squash(textOf(p))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(`${TITLE} – Spending by Category – ${d.everyday.name} (${d.everyday.number}) – ${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(GENERATED))
    }
  })

  test('numbers every page "Page 2 of 5" in the bottom margin, and has nothing else in the margins', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const margin = (20 / 25.4) * 72 // the bottom margin, 20mm, in points
    for (const [index, p] of pages.entries()) {
      const numbered = p.text.filter((t) => t.str === `Page ${index + 1} of ${pages.length}`)
      expect(numbered, `page ${index + 1}`).toHaveLength(1)
      expect(numbered[0]!.y).toBeLessThan(margin)
      expect(p.text.filter((t) => t.y > p.height - (18 / 25.4) * 72), `top margin of page ${index + 1}`).toEqual([])
      expect(p.text.filter((t) => t.y < margin).map((t) => t.str), `bottom margin of page ${index + 1}`).toEqual([`Page ${index + 1} of ${pages.length}`])
    }
  })

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.flatMap((p, index) => p.text.filter((t) => t.size < 11.95).map((t) => `page ${index + 1}: ${t.size}pt "${t.str}"`))).toEqual([])
    expect(pages.flatMap((p) => p.text).length).toBeGreaterThan(150) // 80 rows of two, and the rest
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Around the Report

test.describe('around the Report', () => {
  test('is titled for Save as PDF while it is open, and goes back to the app title when it is left', async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – Spending by Category – All Accounts – ${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })
})
