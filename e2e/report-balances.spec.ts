import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'

// Ticket 23: the balances-over-time Report (spec story 96). It uses the Report frame of ticket 18, so it opens in a new window,
// says on its face what it is, and prints with its table headings on every page. The Report's numbers are held to the balance
// history in worker/report-balances.test.ts; this file checks what a reader sees and what comes out of the printer: the page under
// print media, and the PDF it makes (page count, the text on each page, the margins and the size of the type).

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const MEMBER_EMAIL = 'dev.member@example.com'
const TITLE = `Mum's "family" finances \\ Report` // quote, apostrophe and backslash: the Admin can type any of them
const NOW = new Date('2026-10-08T02:42:00.000Z') // 3:42 pm in NZ
const GENERATED = `Generated Thu 8 Oct 2026 at 3:42 pm by ${MEMBER_EMAIL}`

test.describe.configure({ mode: 'serial' })

// The light and dark projects share one local database, so each has Accounts of its own, and years of its own (2005 to 2010 and
// 2015 to 2020). A Report of one Account lists only that Account; a Report of all Accounts also lists those other specs made.
const YEARS = 6
const MONTHS_HELD = YEARS * 12
const OPENING = 500_000 // $5,000.00 before the first Transaction
const dataFor = (project: string) => {
  const light = project !== 'dark'
  const start = light ? 2005 : 2015
  return {
    start,
    end: start + YEARS - 1,
    savings: { number: light ? '99-9999-9999999-51' : '99-9999-9999999-54', name: `Balances savings ${project}` },
    cheque: { number: light ? '99-9999-9999999-52' : '99-9999-9999999-55', name: `Balances cheque ${project}` },
    nothing: { number: light ? '99-9999-9999999-53' : '99-9999-9999999-56', name: `Balances empty ${project}` },
  }
}

// Dates and money, written the way the app writes them.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const dateText = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
const money = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}`
const two = (n: number) => String(n).padStart(2, '0')

/** Month `i` (0 is January of the first year): one Transaction on the 15th, money out of $10.00 and `i` cents, so every balance is different. */
const spend = (i: number) => 1000 + i
const balanceAfter = (i: number) => OPENING - 1000 * (i + 1) - (i * (i + 1)) / 2
const monthEnd = (start: number, i: number) => {
  const year = start + Math.floor(i / 12)
  const month = (i % 12) + 1
  return `${year}-${two(month)}-${two(new Date(Date.UTC(year, month, 0)).getUTCDate())}`
}
const transactionDate = (start: number, i: number) => `${start + Math.floor(i / 12)}-${two((i % 12) + 1)}-15`

type Seeded = { savingsId: number; chequeId: number; nothingId: number }
const seeded = new Map<string, Seeded>()

/** The project's three Accounts: 72 months of Transactions in one, two Imports in the second that disagree by $3.00, and a third with a bank balance that cannot be counted. Safe to repeat. */
async function seed(context: BrowserContext, baseURL: string, project: string): Promise<Seeded> {
  const known = seeded.get(project)
  if (known) return known
  const { start, end, savings, cheque, nothing } = dataFor(project)
  await signInAs(context, 'admin')
  const importRows = async (account: { number: string; name: string }, from: string, to: string, ledger: [string, number], rows: { date: string; uniqueId: string; payee: string; amountCents: number }[]) => {
    const res = await context.request.post('/api/imports/chunks', {
      headers: { Origin: baseURL },
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from, to, ledgerBalance: { date: ledger[0], cents: ledger[1] } },
        rows: rows.map((r) => ({ ...r, tranType: 'EFTPOS', chequeNumber: null, bankMemo: 'EFTPOS' })),
      },
    })
    expect(res.ok()).toBe(true)
  }
  await importRows(
    savings,
    `${start}-01-01`,
    `${end}-12-31`,
    [`${end}-12-31`, balanceAfter(MONTHS_HELD - 1)],
    Array.from({ length: MONTHS_HELD }, (_, i) => ({ date: transactionDate(start, i), uniqueId: `BAL${start}S${i}`, payee: `EXAMPLE SHOP ${i + 1}`, amountCents: -spend(i) })),
  )
  // $1,000.00 before the first. The second file's balance is $3.00 less than its Transactions add up to: a Transaction is missing.
  await importRows(cheque, `${start}-01-01`, `${start}-01-31`, [`${start}-01-31`, 98_500], [{ date: `${start}-01-10`, uniqueId: `BAL${start}C1`, payee: 'EXAMPLE RATES', amountCents: -1500 }])
  await importRows(cheque, `${start}-02-01`, `${start}-02-28`, [`${start}-02-28`, 95_700], [{ date: `${start}-02-10`, uniqueId: `BAL${start}C2`, payee: 'EXAMPLE POWER', amountCents: -2500 }])
  // The file ends on 31 January but its balance is dated 28 February, so the balance cannot be counted.
  await importRows(nothing, `${start}-01-01`, `${start}-01-31`, [`${start}-02-28`, 5000], [{ date: `${start}-01-20`, uniqueId: `BAL${start}N1`, payee: 'EXAMPLE CAFE', amountCents: -500 }])

  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const idOf = (name: string) => accounts.find((a) => a.name === name)!.id
  const result = { savingsId: idOf(savings.name), chequeId: idOf(cheque.name), nothingId: idOf(nothing.name) }
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

const address = (id: number, from: string, to: string) => `/reports/balances?account=${id}&from=${from}&to=${to}`
const article = (page: Page) => page.getByRole('article', { name: 'Balances over time' })
const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a Report

test.describe('opening the Report', () => {
  test('the Reports page offers it beside the Transaction listing, each with a form of its own, and opens it in a new window', async ({ page, context, baseURL }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Balances over time' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Transaction listing' })).toBeVisible()

    const form = page.getByRole('form', { name: 'Balances over time' })
    await form.getByLabel('Account').selectOption({ label: savings.name })
    await form.getByLabel('From').fill(`${start}-01-01`)
    await form.getByLabel('To').fill(`${end}-12-31`)
    const [popup] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Open Report in a new window' }).click()])
    await expect(popup.getByRole('heading', { level: 1, name: 'Balances over time' })).toBeVisible()
    expect(new URL(popup.url()).pathname).toBe('/reports/balances')
    expect(Object.fromEntries(new URL(popup.url()).searchParams)).toEqual({ account: String(savingsId), from: `${start}-01-01`, to: `${end}-12-31` })
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible() // the Reports page is still where it was
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
    const form = page.getByRole('form', { name: 'Balances over time' })
    const open = form.getByRole('button', { name: 'Open Report in a new window' })

    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a From date.')
    await form.getByLabel('From').fill('2010-12-31')
    await open.click()
    await expect(form.getByRole('alert')).toHaveText('Choose a To date.')
    await form.getByLabel('To').fill('2010-01-01')
    await open.click()
    await expect(form.getByRole('alert')).toContainText('before the “From” date')
    await expect(form.getByLabel('To')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('form', { name: 'Transaction listing' }).getByRole('alert')).toHaveCount(0) // the other form is untouched
    expect(context.pages()).toHaveLength(1)
  })

  test('an address without dates, with dates the wrong way round, or with no such Account explains itself and offers the form', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const [path, words, alert] of [
      ['/reports/balances', 'Choose the first and last dates', false],
      ['/reports/balances?from=2010-12-31&to=2010-01-01', 'before the “From” date', true],
      ['/reports/balances?account=999999999&from=2010-01-01&to=2010-12-31', 'There is no such Account', true],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: 'Balances over time' })).toBeVisible()
      await expect(page.getByRole(alert ? 'alert' : 'status')).toContainText(words)
      await expect(page.getByRole('button', { name: 'Open Report in a new window' })).toBeVisible()
      await expect(article(page)).toHaveCount(0) // no Report is made without an Account and dates
    }
  })

  test('the Print button opens the print window', async ({ page, context, baseURL }, testInfo) => {
    const { start } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.addInitScript(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => void ((window as unknown as { printed: number }).printed += 1)
    })
    await page.goto(address(savingsId, `${start}-01-01`, `${start}-12-31`))
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

  test('has the title block, what the balances are worked out from, the opening and closing balance, and a row for each month', async ({ page, context, request, baseURL }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(savingsId, `${start}-01-01`, `${end}-12-31`))

    const report = article(page)
    await expect(report.getByRole('heading', { level: 1, name: 'Balances over time' })).toBeVisible()
    const header = report.locator('header')
    await expect(header).toContainText("Mum's finances")
    await expect(header).toContainText(`Account: ${savings.name} (${savings.number})`) // the bank's number is beside the name
    await expect(header).toContainText(`Dates: ${dateText(`${start}-01-01`)} to ${dateText(`${end}-12-31`)}`)
    await expect(header).toContainText(GENERATED)

    // Said before the figures: one balance a month, and that they are calculated.
    const about = report.getByRole('region', { name: 'About these balances' })
    await expect(about).toContainText('a row for every month in these dates')
    await expect(about).toContainText('calculated figures, not balances the bank gave for each month-end')
    await expect(about).toContainText('A date is held when Fernledger has a Transaction or a bank balance for the Account on it')

    const account = report.getByRole('region', { name: `${savings.name} (${savings.number})` })
    await expect(account).toContainText(`Worked out from the bank's balance of ${money(balanceAfter(MONTHS_HELD - 1))} on ${dateText(`${end}-12-31`)}.`)
    const summary = account.locator('dl')
    await expect(summary).toContainText(`Before the first date held, ${dateText(transactionDate(start, 0))}`)
    await expect(summary).toContainText(money(OPENING))
    await expect(summary).toContainText(`At the end of ${dateText(`${end}-12-31`)}`)
    await expect(summary).toContainText(money(balanceAfter(MONTHS_HELD - 1)))
    await expect(summary).toContainText(money(balanceAfter(MONTHS_HELD - 1) - OPENING))
    await expect(account).toContainText(`The first date held for this Account is ${dateText(transactionDate(start, 0))}, so there are no balances before it.`) // the dates begin on 1 January

    const table = account.getByRole('table', { name: `Balances in ${savings.name}` })
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Balance', 'Change', 'Source'])
    await expect(table.locator('tbody tr')).toHaveCount(MONTHS_HELD)
    // The line that says what a page is belongs to paper: it is in the table's heading, and not on screen.
    await expect(table.locator('thead tr')).toHaveCount(2)
    await expect(table.locator('thead tr').first()).toBeHidden()
    const first = table.locator('tbody tr').first()
    await expect(first).toContainText(dateText(monthEnd(start, 0)))
    await expect(first).toContainText(money(balanceAfter(0)))
    await expect(first).toContainText(money(-spend(0))) // a month of money out is a negative change
    await expect(first).toContainText('Calculated from the Transactions')
    const lastRow = table.locator('tbody tr').last()
    await expect(lastRow).toContainText(dateText(`${end}-12-31`))
    await expect(lastRow).toContainText(money(balanceAfter(MONTHS_HELD - 1)))
    await expect(lastRow).toContainText('Bank balance') // the bank gave this one
    await expect(table.getByText('Bank balance')).toHaveCount(1)

    // Every month's balance, in order, is what the history says it is.
    const balances = await table.locator('tbody tr td:nth-child(2)').allTextContents()
    expect(balances).toEqual(Array.from({ length: MONTHS_HELD }, (_, i) => money(balanceAfter(i))))

    await expect(account.getByRole('heading', { level: 3, name: 'Balance Check differences' })).toBeVisible()
    await expect(account).toContainText('No Balance Check covers these dates, so none could find a difference.') // one bank balance has nothing to be checked against
  })

  test('lists the Balance Check differences in the dates, in the Balance Check’s own words, and shows both figures where the bank and the Transactions disagree', async ({ page, context, baseURL }, testInfo) => {
    const { start, cheque } = dataFor(testInfo.project.name)
    const { chequeId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(chequeId, `${start}-01-01`, `${start}-12-31`))

    const account = article(page).getByRole('region', { name: `${cheque.name} (${cheque.number})` })
    await expect(account.getByRole('heading', { level: 3, name: 'Balance Check differences' })).toBeVisible()
    await expect(account).toContainText(`Balance differs from bank by $3.00 since ${dateText(`${start}-01-31`)}`)
    await expect(account).toContainText(`Found in the bank balance of ${dateText(`${start}-02-28`)}.`)
    await expect(account).toContainText("The bank's balance is lower than the Transactions add up to.")
    // What it means for the rows above: every balance is worked back from the latest bank balance, so January's carries it (see its Source).
    await expect(account).toContainText(`Balances before ${dateText(`${start}-02-28`)} are worked back from the latest bank balance, so they carry this difference.`)
    await expect(account).not.toContainText('agrees with the bank')

    // The balances are the history's, worked back from the latest bank balance, so January is $3.00 out of line with what the bank said that day.
    const table = account.getByRole('table', { name: `Balances in ${cheque.name}` })
    await expect(table.locator('tbody tr')).toHaveCount(2)
    await expect(table.locator('tbody tr').nth(0)).toContainText(`${dateText(`${start}-01-31`)}`)
    await expect(table.locator('tbody tr').nth(0)).toContainText(money(98_200))
    await expect(table.locator('tbody tr').nth(0)).toContainText(`Calculated from the Transactions, $3.00 less than the bank's ${money(98_500)}`)
    await expect(table.locator('tbody tr').nth(1)).toContainText(money(95_700))
    await expect(table.locator('tbody tr').nth(1)).toContainText('Bank balance')
    await expect(account).toContainText(`The last date held for this Account is ${dateText(`${start}-02-28`)}, so the Report stops there.`)
  })

  test('explains a balance that is off the bank’s figure by a difference found after the dates, and never says the bank agrees', async ({ page, context, baseURL }, testInfo) => {
    const { start, cheque } = dataFor(testInfo.project.name)
    const { chequeId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    // The Balance Check that found the $3.00 begins on 31 January, the last of these dates, so it is not listed: the Transaction missing from it is dated after.
    await page.goto(address(chequeId, `${start}-01-01`, `${start}-01-31`))

    const account = article(page).getByRole('region', { name: `${cheque.name} (${cheque.number})` })
    const row = account.getByRole('table').locator('tbody tr')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(`Calculated from the Transactions, $3.00 less than the bank's ${money(98_500)}`)
    await expect(account).toContainText('No Balance Check covers these dates, so none could find a difference.')
    await expect(account).toContainText("Where a balance above differs from the bank's own figure, it is because every balance is worked back from the latest bank balance")
    await expect(account).not.toContainText('Balance differs from bank by') // no difference is listed
    await expect(account).not.toContainText('agree')
  })

  test('starts a Report that begins part way through the history from the balance the day before, and ends it on the last date asked for', async ({ page, context, baseURL }, testInfo) => {
    const { start, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    // From 10 June of the third year to 20 February of the fourth. The last Transaction before it is May's, month 28.
    const from = `${start + 2}-06-10`
    const to = `${start + 3}-02-20`
    await page.goto(address(savingsId, from, to))

    const account = article(page).getByRole('region', { name: `${savings.name} (${savings.number})` })
    await expect(account.locator('dl')).toContainText(`At the start of ${dateText(from)}`)
    await expect(account.locator('dl')).toContainText(money(balanceAfter(28)))
    await expect(account.locator('dl')).toContainText(`At the end of ${dateText(to)}`)
    await expect(account.locator('dl')).toContainText(money(balanceAfter(37))) // February of the fourth year is month 37 (its Transaction is on the 15th)
    const rows = account.getByRole('table').locator('tbody tr')
    await expect(rows).toHaveCount(9) // June to February
    await expect(rows.first()).toContainText(dateText(monthEnd(start, 29))) // June's balance, after June's Transaction
    await expect(rows.first()).toContainText(money(balanceAfter(29)))
    await expect(rows.last()).toContainText(dateText(to)) // not the end of the month
    await expect(account).not.toContainText('date held for this Account')
  })

  test('stops at the last date held, however far the dates run, and says so', async ({ page, context, baseURL }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(savingsId, `${start}-01-01`, `${end + 1}-06-30`))

    const account = article(page).getByRole('region', { name: `${savings.name} (${savings.number})` })
    await expect(account.getByRole('table').locator('tbody tr')).toHaveCount(MONTHS_HELD) // no rows for the months after
    await expect(account).toContainText(`The last date held for this Account is ${dateText(`${end}-12-31`)}, so the Report stops there.`)
    await expect(account.locator('dl')).toContainText(`At the end of ${dateText(`${end}-12-31`)}`)
  })

  test('says what is held, and shows no table, for dates that begin after it or end before it', async ({ page, context, baseURL }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')

    await page.goto(address(savingsId, `${end + 1}-01-01`, `${end + 1}-12-31`))
    const account = article(page).getByRole('region', { name: `${savings.name} (${savings.number})` })
    await expect(account).toContainText(`The last date held for this Account is ${dateText(`${end}-12-31`)}.`)
    await expect(account.getByRole('table')).toHaveCount(0)

    await page.goto(address(savingsId, `${start - 3}-01-01`, `${start - 1}-12-31`))
    await expect(article(page).getByRole('region', { name: `${savings.name} (${savings.number})` })).toContainText(`The first date held for this Account is ${dateText(transactionDate(start, 0))}.`)
  })

  test('says why an Account with no bank balance it can count has no balances, and never gives it figures', async ({ page, context, baseURL }, testInfo) => {
    const { start, nothing } = dataFor(testInfo.project.name)
    const { nothingId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(address(nothingId, `${start}-01-01`, `${start}-12-31`))

    const account = article(page).getByRole('region', { name: `${nothing.name} (${nothing.number})` })
    await expect(account).toContainText('No balances can be worked out for this Account. The file ended before its bank balance date.')
    await expect(account.getByRole('table')).toHaveCount(0)
    await expect(account.locator('dl')).toHaveCount(0)
  })

  test('lists every Account on its own when none is chosen', async ({ page, context, baseURL }, testInfo) => {
    const { start, end, savings, cheque, nothing } = dataFor(testInfo.project.name)
    await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.goto(`/reports/balances?from=${start}-01-01&to=${end}-12-31`)

    const report = article(page)
    await expect(report.locator('header')).toContainText('Account: All Accounts: ')
    for (const account of [savings, cheque, nothing]) {
      await expect(report.getByRole('heading', { level: 2, name: `${account.name} (${account.number})` })).toBeVisible()
      await expect(report.locator('header')).toContainText(`${account.name} (${account.number})`) // each Account with its bank number
    }
    await expect(page).toHaveTitle(`Fernledger – Balances over time – All Accounts – ${dateText(`${start}-01-01`)} to ${dateText(`${end}-12-31`)}`)
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}, with a difference to list`, async ({ page, context, baseURL }, testInfo) => {
      const { start, end, cheque } = dataFor(testInfo.project.name)
      await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, role)
      await page.goto(`/reports/balances?from=${start}-01-01&to=${end}-12-31`)
      await expect(article(page).getByRole('table').first()).toBeVisible()
      await expect(article(page).getByRole('region', { name: `${cheque.name} (${cheque.number})` }).getByText('Balance differs from bank by $3.00')).toBeVisible()
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      await noAxeViolations(page)
    })
  }

  test('is cards on a phone, with the same facts', async ({ page, context, baseURL }, testInfo) => {
    const { start, end } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, 'member')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(address(savingsId, `${start}-01-01`, `${end}-12-31`))
    const cards = article(page).getByRole('list', { name: /^Balances in / }).getByRole('listitem')
    await expect(cards).toHaveCount(MONTHS_HELD)
    await expect(cards.first()).toContainText(dateText(monthEnd(start, 0)))
    await expect(cards.first()).toContainText(money(balanceAfter(0)))
    await expect(cards.first()).toContainText('Source')
  })

  test.describe('when a request for an Account fails', () => {
    test.use({ expectedStatuses: [500] })

    test('there is no Report: an Account that was not read never looks like one with no balances', async ({ page, context, baseURL }, testInfo) => {
      const { start, end } = dataFor(testInfo.project.name)
      const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
      await signInAs(context, 'member')
      await page.route('**/api/reports/balances?**', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(address(savingsId, `${start}-01-01`, `${end}-12-31`))
      await expect(page.getByRole('alert')).toContainText("couldn't load this Report", { timeout: 20_000 })
      await expect(page.getByRole('table')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Printed

test.describe('printed', () => {
  test.beforeEach(async ({ page, context, request, baseURL }, testInfo) => {
    const { start, end } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, TITLE)
    await signInAs(context, 'member')
    await context.clock.setFixedTime(NOW)
    await page.emulateMedia({ media: 'print' })
    await page.goto(address(savingsId, `${start}-01-01`, `${end}-12-31`))
    await expect(article(page).getByRole('table')).toBeVisible()
  })

  const range = (start: number, end: number) => `${dateText(`${start}-01-01`)} to ${dateText(`${end}-12-31`)}`

  test('is just the Report: no app header, navigation or buttons', async ({ page }) => {
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
    await expect(page.getByRole('link')).toHaveCount(0)
    await expect(page.getByText('In the print window')).toBeHidden()
  })

  test('writes its own title block: the app title, the Report, the Account, the dates, and who generated it and when', async ({ page }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const header = article(page).locator('header')
    await expect(header).toBeVisible()
    await expect(header.getByText(TITLE, { exact: true })).toBeVisible() // the Admin's words, as typed
    await expect(header.getByRole('heading', { level: 1, name: 'Balances over time' })).toBeVisible()
    await expect(header).toContainText(`Account: ${savings.name} (${savings.number})`)
    await expect(header).toContainText(`Dates: ${range(start, end)}`)
    await expect(header.getByText(GENERATED, { exact: true })).toBeVisible()
  })

  test('puts the same identifying lines in the table heading, which a browser repeats on every page', async ({ page }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const identity = page.locator('thead tr').first()
    await expect(identity).toBeVisible() // on screen it is not
    await expect(identity).toContainText(`${TITLE} – Balances over time – ${savings.name} (${savings.number}) – ${range(start, end)}`)
    await expect(identity).toContainText(GENERATED)
    // It is one of the table's heading rows, with the column headings: that is what makes a browser repeat it.
    expect(await page.locator('thead').evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
  })

  test('names the page for Save as PDF: the app, the Report, the Account and the dates', async ({ page }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    await expect(page).toHaveTitle(`${TITLE} – Balances over time – ${savings.name} – ${range(start, end)}`)
  })

  /** Every word of the Report is black, including the muted ones, the money and a warning, and the paper is white. */
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

  test('is black text on white paper, even from the dark theme, and a warning is black too', async ({ page, context, baseURL }, testInfo) => {
    const { start, end } = dataFor(testInfo.project.name)
    const { chequeId } = await seed(context, baseURL!, testInfo.project.name)
    // In the dark project the page is the dark theme on screen, and must still print like this.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
    const savings = await blackOnWhite(page)
    expect(savings.texts).toBeGreaterThan(100)
    expect(savings.unreadable).toEqual([]) // every word, including the muted ones and the money, is black
    expect(Math.min(...savings.paper)).toBeGreaterThan(240)

    // The Balance Check difference is a warning on screen, in a colour; on paper it is black, and the icon and the box carry it.
    await page.goto(address(chequeId, `${start}-01-01`, `${end}-12-31`))
    await expect(article(page).getByText('Balance differs from bank by $3.00')).toBeVisible()
    const cheque = await blackOnWhite(page)
    expect(cheque.texts).toBeGreaterThan(20)
    expect(cheque.unreadable).toEqual([])
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
    expect(small.texts).toBeGreaterThan(100)
    expect(small.found).toEqual([]) // 12pt is 16px
    // The table's own text is set to 12pt, not left to the 15px it has on screen.
    const cell = await article(page).locator('tbody td').first().evaluate((el) => getComputedStyle(el).fontSize)
    expect(parseFloat(cell)).toBeGreaterThanOrEqual(16)
  })

  test('is its own page with its own margins, repeats table headings and keeps a row whole', async ({ page }) => {
    const styles = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
      return { page: style('.report-frame').page, thead: style('thead').display, row: style('tbody tr').breakInside, main: style('main').paddingLeft }
    })
    expect(styles).toEqual({ page: 'report', thead: 'table-header-group', row: 'avoid', main: '0px' })
  })

  test('is several A4 pages with the table headings on every one, no month lost, repeated or cut across pages', async ({ page }, testInfo) => {
    const { start } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    expect(pages.length).toBeGreaterThanOrEqual(3)
    const withRows = pages.filter((p) => textOf(p).includes('Calculated from the Transactions'))
    expect(withRows.length).toBeGreaterThanOrEqual(3)

    // Headings come back on every page the table runs onto, not only the first.
    for (const p of withRows) for (const heading of ['Date', 'Balance', 'Change', 'Source']) expect(p.text.map((t) => t.str), `${heading} on page ${pages.indexOf(p) + 1}`).toContain(heading)

    // Every month is on exactly one page, as one row: its date, its balance and its change.
    const all = textOf({ width: 0, height: 0, text: pages.flatMap((p) => p.text) })
    for (let i = 0; i < MONTHS_HELD; i++) {
      const row = `${dateText(monthEnd(start, i))} ${money(balanceAfter(i))} ${money(-spend(i))}`
      expect(all.split(row).length - 1, row).toBe(1)
      const where = pages.find((p) => textOf(p).includes(row))
      expect(where, `${row} is on a page`).toBeDefined()
    }
  })

  test('numbers every page "Page 2 of 5" in the bottom margin', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const margin = (20 / 25.4) * 72 // the bottom margin, 20mm, in points
    pages.forEach((p, index) => {
      const numbered = p.text.filter((t) => t.str === `Page ${index + 1} of ${pages.length}`)
      expect(numbered, `page ${index + 1}`).toHaveLength(1)
      expect(numbered[0]!.y).toBeLessThan(margin)
    })
  })

  test('says what the Report is, which Account and dates, and who generated it and when, at the top of every page the table runs onto', async ({ page }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    const withRows = pages.filter((p) => textOf(p).includes('Calculated from the Transactions'))
    expect(withRows.length).toBeGreaterThanOrEqual(3)
    // In each page's own body, not its margins, so every browser prints it. The Admin's title comes through as typed, quote and backslash too.
    // (The line may wrap, even inside the Account's number at a hyphen, so the comparison ignores where it broke.)
    const squash = (text: string) => text.replace(/\s+/g, '')
    for (const p of withRows) {
      const text = squash(textOf(p))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(`${TITLE} – Balances over time – ${savings.name} (${savings.number}) – ${range(start, end)}`))
      expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(GENERATED))
    }
  })

  test('has nothing in the top margin and only the page number in the bottom one', async ({ page }) => {
    const pages = await readPdf(await page.pdf({ format: 'A4' }))
    for (const [index, p] of pages.entries()) {
      expect(p.text.filter((t) => t.y > p.height - (18 / 25.4) * 72), `top margin of page ${index + 1}`).toEqual([])
      expect(p.text.filter((t) => t.y < (20 / 25.4) * 72).map((t) => t.str), `bottom margin of page ${index + 1}`).toEqual([`Page ${index + 1} of ${pages.length}`])
    }
  })

  test('sets every word of it, the page numbers and a Balance Check difference included, in at least 12pt type', async ({ page, context, baseURL }, testInfo) => {
    const { start, end } = dataFor(testInfo.project.name)
    const { chequeId } = await seed(context, baseURL!, testInfo.project.name)
    const small = (pages: Awaited<ReturnType<typeof readPdf>>) => pages.flatMap((p, index) => p.text.filter((t) => t.size < 11.95).map((t) => `page ${index + 1}: ${t.size}pt "${t.str}"`))

    const savings = await readPdf(await page.pdf({ format: 'A4' }))
    expect(small(savings)).toEqual([])
    expect(savings.flatMap((p) => p.text).length).toBeGreaterThan(300)

    await page.goto(address(chequeId, `${start}-01-01`, `${end}-12-31`))
    await expect(article(page).getByText('Balance differs from bank by $3.00')).toBeVisible()
    const cheque = await readPdf(await page.pdf({ format: 'A4' }))
    expect(small(cheque)).toEqual([])
    expect(textOf({ width: 0, height: 0, text: cheque.flatMap((p) => p.text) })).toContain('Balance differs from bank by $3.00') // on whichever page it fell
  })

  test('prints the same from a phone-width window: still a table', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(article(page).getByRole('table')).toBeVisible()
    await expect(article(page).getByRole('list')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Around the Report

test.describe('around the Report', () => {
  test('is titled for Save as PDF while it is open, and goes back to the app title when it is left', async ({ page, context, request, baseURL }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    await setTitle(request, baseURL, "Mum's finances")
    await signInAs(context, 'member')
    await page.goto(address(savingsId, `${start}-01-01`, `${end}-12-31`))
    await expect(page).toHaveTitle(`Mum's finances – Balances over time – ${savings.name} – ${dateText(`${start}-01-01`)} to ${dateText(`${end}-12-31`)}`)
    await page.getByRole('link', { name: 'Back to Reports' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })

  test('shows every Member the same Report as the Admin', async ({ page, context, baseURL }, testInfo) => {
    const { start, end, savings } = dataFor(testInfo.project.name)
    const { savingsId } = await seed(context, baseURL!, testInfo.project.name)
    const seen: string[] = []
    for (const role of ['member', 'admin'] as const) {
      await signInAs(context, role)
      await page.goto(address(savingsId, `${start}-01-01`, `${end}-12-31`))
      await expect(article(page).getByRole('region', { name: `${savings.name} (${savings.number})` }).getByRole('table')).toBeVisible()
      seen.push((await article(page).getByRole('table').locator('tbody tr td:nth-child(2)').allTextContents()).join())
    }
    expect(seen[0]).toBe(seen[1])
  })
})
