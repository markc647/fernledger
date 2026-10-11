import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'
import {
  dateText,
  expectBareMargins,
  expectBlackOnWhite,
  expectIdentityOnEveryPage,
  expectIdentityRow,
  expectJustTheReport,
  expectNoTextUnder12pt,
  expectNoTypeUnder12pt,
  expectOwnPage,
  expectPageNumbers,
  expectTitleBlock,
  GENERATED,
  noAxeViolations,
  NOW,
  restoreAppTitleAfterEach,
  setTitle,
  squash,
  TITLE,
} from './report-helpers'

// Ticket 20: the spending-by-Category Report (spec story 93). It uses the Report frame of ticket 18, so it opens in a new window, says on its face
// what it is, and prints with its table heading on every page. The Report's numbers are held to the Worker's spending totals in
// worker/report-spending.test.ts; this file checks what a reader sees and what comes out of the printer: the page under print media, and the PDF it
// makes (page count, the text on each page, the margins and the size of the type).

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts, Categories and a year of its own (2002 and 2003), and a Report of that
// year lists only that project's Transactions even for every Account. No other spec uses these years, and they are older than every other spec's
// Transactions on purpose (as the Dashboard's 2004 is): the Summary's newest five and the first page of the Transactions list belong to the specs that
// look for theirs there. Payees avoid "EXAMPLE", which other specs' Rules look for.
const dataFor = (project: string) => {
  const light = project !== 'dark'
  return {
    project,
    year: light ? 2002 : 2003,
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

/** What the Dashboard calls Uncategorised in a table, which is what a row of the Report says too. */
const UNCATEGORISED = 'Uncategorised (includes money in not yet given a Category)'
/** What the Report says is not counted, in the Dashboard's words; the table's heading repeats it on every printed page. */
const NOT_COUNTED = "Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted."
/** What a Spent cell says: no sign, and "back" after an amount that is less than nothing. */
const spent = (cents: number) => `$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}${cents < 0 ? ' back' : ''}`

// What the year holds, by Account, in cents (money out is negative). The Transfer, the wages (Income) and the loan are not Spending. The Report puts the
// most spent first, so Uncategorised ($4.00) is above the Category that took money back, and a Category that took back more than it paid out is last.
const EVERYDAY = { rates: 30_000, fuel: 9000, food: 5550, uncategorised: 400, back: -2500 }
const SAVINGS = { food: 2000 }
const ALL = { rates: EVERYDAY.rates, fuel: EVERYDAY.fuel, food: EVERYDAY.food + SAVINGS.food, uncategorised: EVERYDAY.uncategorised, back: EVERYDAY.back }
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

restoreAppTitleAfterEach() // the Settings are shared by every test and both themes (as reports.spec.ts does)

/** The Report's address: `account` is left out for every Account. */
const address = (account: number | null, from: string, to: string) => `/reports/spending?${account === null ? '' : `account=${account}&`}from=${from}&to=${to}`
const wholeYear = (year: number) => ({ from: `${year}-01-01`, to: `${year}-12-31` })
const article = (page: Page) => page.getByRole('article', { name: 'Spending by Category' })
const tableOf = (page: Page) => article(page).getByRole('table', { name: 'Spending in each Category' })

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
    await expect(form).toContainText('the most spent first, and one for Uncategorised when there is any.')
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

  test('has the title block, what is counted, the total, and a row for each Category, the most spent first, with Uncategorised as its own row', async ({ page, context, request, baseURL }, testInfo) => {
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

    // Said before the figures, in the Dashboard's words: what is spending, that a "back" amount comes off, that Uncategorised counts, and what is left out.
    const about = report.getByRole('region', { name: 'About these figures' })
    await expect(about).toContainText('money out less money back, such as a refund. A “back” amount is taken off the total.')
    await expect(about).toContainText('Uncategorised counts as spending, so money in that has no Category yet comes off it.')
    await expect(about).toContainText(NOT_COUNTED)

    const section = report.getByRole('region', { name: 'Spending in each Category' })
    await expect(section.locator('dl')).toContainText('Total spending')
    await expect(section.locator('dl')).toContainText(spent(total(ALL)))
    const table = tableOf(page)
    await expect(table.getByRole('columnheader')).toHaveText(['Category', 'Spent'])
    // The most spent first, as the Dashboard has them. Uncategorised is a row of its own, where its amount puts it, named as the Summary names it, and what
    // came back is below the rest.
    expect(await rowsOf(page)).toEqual({
      names: [d.rates, d.fuel, d.food, UNCATEGORISED, d.back],
      spent: [spent(ALL.rates), spent(ALL.fuel), spent(ALL.food), spent(ALL.uncategorised), spent(ALL.back)],
    })
    await expect(table.locator('tbody tr').nth(4)).toContainText('$25.00 back')
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
      names: [d.rates, d.fuel, d.food, UNCATEGORISED, d.back],
      spent: [spent(EVERYDAY.rates), spent(EVERYDAY.fuel), spent(EVERYDAY.food), spent(EVERYDAY.uncategorised), spent(EVERYDAY.back)],
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

    // 10 January to 15 March: everything but April's two payments with no Category and its money back.
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
    await page.goto(address(null, `${d.year}-04-01`, `${d.year}-04-30`)) // $4.00 Uncategorised and $25.00 back
    expect(await rowsOf(page)).toEqual({ names: [UNCATEGORISED, d.back], spent: ['$4.00', '$25.00 back'] })
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' }).locator('dl')).toContainText('$21.00 back')
  })

  test('says nothing was spent, and shows no table or total, for dates with no spending', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(null, `${d.year}-06-01`, `${d.year}-06-30`))
    const section = article(page).getByRole('region', { name: 'Spending in each Category' })
    await expect(section).toContainText(`Nothing was spent in June ${d.year}.`) // a whole month by its name, as on the Dashboard
    await expect(section.getByRole('table')).toHaveCount(0)
    await expect(section.locator('dl')).toHaveCount(0)
    await expect(article(page).getByRole('region', { name: 'About these figures' })).toBeVisible()
  })

  test('says nothing was spent for an Account whose only Transaction is Income, and does not count its wages', async ({ page, context, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const { incomeId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(incomeId, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(article(page).locator('header')).toContainText(`Account: ${d.income.name} (${d.income.number})`)
    await expect(article(page).getByRole('region', { name: 'Spending in each Category' })).toContainText(`Nothing was spent in ${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}.`)
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
      await expect(tableOf(page)).toContainText(UNCATEGORISED)
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
    await expect(cards.nth(3)).toContainText(UNCATEGORISED)
    await expect(cards.last()).toContainText(`${d.back}`)
    await expect(cards.last()).toContainText('$25.00 back')
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
      await expect(page.getByText('Nothing was spent in')).toHaveCount(0)
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
    await expectJustTheReport(page)
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectTitleBlock(article(page), { name: 'Spending by Category', account: `${d.everyday.name} (${d.everyday.number})`, dates: range(d.year) })
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page, and says what is not counted', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expectIdentityRow(page, `${TITLE} – Spending by Category – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`)
    await expect(page.locator('thead tr').first()).toContainText(NOT_COUNTED) // so a loose page does not have to be read with the first
  })

  test('says "All Accounts" in the table heading when no Account was chosen, and leaves the title block to list them', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`))
    await expect(tableOf(page)).toBeVisible()
    await expectIdentityRow(page, `${TITLE} – Spending by Category – All Accounts – ${range(d.year)}`)
    await expect(article(page).locator('header')).toContainText(`${d.everyday.name} (${d.everyday.number})`)
    await expect(page.locator('thead tr').first()).not.toContainText(d.everyday.name) // not once for every Account on every page
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Spending by Category – ${d.everyday.name} – ${range(d.year)}`)
  })

  test('is black text on white paper, even from the dark theme', async ({ page }, testInfo) => {
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    await expectBlackOnWhite(page, 20) // every word, including the money and "back", is black
  })

  test('has no text under 12pt', async ({ page }) => {
    await expectNoTextUnder12pt(page, article(page), 20)
  })

  test('is its own page with its own margins, repeats the table heading and keeps a row whole', async ({ page }) => {
    await expectOwnPage(page)
  })

  test('prints on one A4 page with the Categories, the total and the page number, every figure in at least 12pt type', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages).toHaveLength(1)
    const text = textOf(pages[0]!)
    for (const [name, cents] of [[d.rates, EVERYDAY.rates], [d.fuel, EVERYDAY.fuel], [d.food, EVERYDAY.food], [d.back, EVERYDAY.back]] as const) {
      expect(text, name).toContain(`${name} ${spent(cents)}`)
    }
    // The Uncategorised row's name is long and may wrap, so its words and its amount are looked for apart.
    expect(squash(text)).toContain(squash(UNCATEGORISED))
    expect(text).toContain(spent(EVERYDAY.uncategorised))
    expect(text).toContain(`Total spending ${spent(total(EVERYDAY))}`)
    expect(text).toContain('Page 1 of 1')
    expectNoTypeUnder12pt(pages, 25)
    // The table's heading, with what the Report is, who generated it and what is not counted, is on the page that has the table.
    expectIdentityOnEveryPage(pages, 'Total spending', `${TITLE} – Spending by Category – ${d.everyday.name} (${d.everyday.number}) – ${range(d.year)}`, 1)
    expect(squash(text)).toContain(squash(NOT_COUNTED))
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
  /** Every Category's figure is different, so a row can be told from the others in a PDF; they are given most spent first, as the Worker gives them. */
  const cents = (i: number) => 100_000 - i * 137
  const UNCATEGORISED_CENTS = 12_345 // less than every Category's, so its row is the last of the table

  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.route('**/api/reports/spending?**', (route) =>
      route.fulfill({
        json: {
          ...wholeYear(d.year),
          totalCents: Array.from({ length: CATEGORIES }, (_, i) => cents(i)).reduce((sum, c) => sum + c, 0) + UNCATEGORISED_CENTS,
          categories: [
            ...Array.from({ length: CATEGORIES }, (_, i) => ({ categoryId: i + 1, name: name(i), cents: cents(i) })),
            { categoryId: null, name: 'Uncategorised', cents: UNCATEGORISED_CENTS },
          ],
        },
      }),
    )
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(null, `${d.year}-01-01`, `${d.year}-12-31`)) // every Account, so the heading says so
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
    // The Uncategorised row's name is long and may wrap, so its name and its amount are counted apart.
    expect(squash(all).split(squash(UNCATEGORISED)).length - 1).toBe(1)
    expect(all.split(spent(UNCATEGORISED_CENTS)).length - 1).toBe(1)
  })

  test('says what the Report is, which Accounts and dates, who generated it and when, and what is not counted, at the top of every page the table runs onto', async ({ page }, testInfo) => {
    const d = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    // The Admin's title comes through as typed, quote and backslash too; the heading says "All Accounts", not each of them on every page.
    const withRows = expectIdentityOnEveryPage(pages, 'Stub category', `${TITLE} – Spending by Category – All Accounts – ${dateText(`${d.year}-01-01`)} to ${dateText(`${d.year}-12-31`)}`, 2)
    for (const p of withRows) expect(squash(textOf(p)), `page ${pages.indexOf(p) + 1}`).toContain(squash(NOT_COUNTED))
  })

  test('numbers every page "Page 2 of 5" in the bottom margin, and has nothing else in the margins', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expectPageNumbers(pages)
    expectBareMargins(pages)
  })

  test('sets every word of it, the page numbers included, in at least 12pt type', async ({ page }) => {
    expectNoTypeUnder12pt(await readPdf(await page.pdf({ format: 'A4' })), 150) // 80 rows of two, and the rest
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
