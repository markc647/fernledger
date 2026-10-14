import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { textOf, type PdfPage } from './pdf-text'

// What every Report's browser tests share (reports.spec.ts, report-balances.spec.ts, report-spending.spec.ts): the title block and print layout of ticket 18's Report
// frame, which a Report must keep (README: Reports). A spec checks what is its own (the figures, its Accounts, its dates) and calls these for the rest, so a change to
// the frame is one change here and a new Report adds no fourth copy.

export const MEMBER_EMAIL = 'dev.member@example.com'
/** An app title with a quote, an apostrophe and a backslash in it: the Admin can type any of them. */
export const TITLE = `Mum's "family" finances \\ Report`
/** 3:42 pm in NZ, the moment a test fixes the browser's clock at (`context.clock.setFixedTime`). */
export const NOW = new Date('2026-10-08T02:42:00.000Z')
export const GENERATED = `Generated Thu 8 Oct 2026 at 3:42 pm by ${MEMBER_EMAIL}`

// Dates and money, written the way the app writes them.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
/** An NZ calendar date as the app writes it: "Tue 8 Oct 2026". */
export const dateText = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** An amount of money as the app writes it: "$1,234.56", or "−$12.00" below zero. */
export const money = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}`
/** What a Spent cell says: no sign, and "back" after an amount that is less than nothing. */
export const spent = (cents: number) => `${money(Math.abs(cents))}${cents < 0 ? ' back' : ''}`
/** A change in money as the app writes it: the sign is always written ("+$12.00", "−$12.00"), and nothing is "$0.00". */
export const signedMoney = (cents: number) => `${cents > 0 ? '+' : ''}${money(cents)}`

/** What the Dashboard calls Uncategorised in a table, which is what a row of a Report of Spending says too. */
export const UNCATEGORISED = 'Uncategorised (includes money in not yet given a Category)'
/** What a Report of Spending says is not counted, in the Dashboard's words; the table's heading repeats it on every printed page. */
export const NOT_COUNTED = "Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted."
/** What a Report of Spending and Income together says is not counted: the same, except that Income is what it is about. */
export const NOT_COUNTED_AS_SPENDING_OR_INCOME = "Transfers between your own Accounts, Pending Transactions and Loans aren't counted."

/** A line of a PDF's text with every space taken out, for "contains" checks that must not care where a long line wrapped (even inside an Account's number at a hyphen). */
export const squash = (text: string) => text.replace(/\s+/g, '')

/** The Settings are shared by every test and both themes, so a spec that changes the app title calls this once, at the top of the file, to leave the default behind. */
export function restoreAppTitleAfterEach() {
  test.afterEach(async ({ request, baseURL }) => {
    const reset = await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title: 'Fernledger' } })
    expect(reset.ok()).toBe(true)
  })
}
export const setTitle = async (request: APIRequestContext, baseURL: string | undefined, app_title: string) =>
  expect((await request.patch('/api/settings', { headers: { Origin: baseURL! }, data: { app_title } })).ok()).toBe(true)

// ---------------------------------------------------------------------------------------------------------------
// Seeding: Categories, Imports and Overrides through the API, as the Admin makes them. The caller has signed in as the Admin (`signInAs(context, 'admin')`).
// Every one is safe to repeat, so a run against a database an earlier run left behind finds what it made.

/** A Category of the spec's own: the one already there with that name, else a new one of that kind. Its ID. */
export async function ensureCategory(context: BrowserContext, baseURL: string, name: string, kind: 'spending' | 'income' | 'loans'): Promise<number> {
  const existing = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  const found = existing.find((c) => c.name === name)
  if (found) return found.id
  const res = await context.request.post('/api/categories', { headers: { Origin: baseURL }, data: { name, kind } })
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { id: number }).id
}

/**
 * A Transaction to import: its date, what the bank calls it (unique among a spec's rows, so it can be found again), its amount in cents (money out is negative), the name
 * of the Category to Override it into, its own unique ID (else `importRows` makes one) and the cheque number an Import has for it.
 */
export type SeedRow = { date: string; payee: string; amountCents: number; category?: string; uniqueId?: string; chequeNumber?: string }

/**
 * The dates of an Import's file: the whole of `year`, with either end moved by `from` or `to`, or both ends and no year. One of the two is required, so a file can't be
 * dated "undefined-01-01" (the compiler refuses it: report-helpers.type-check.ts).
 */
export type FileDates = { year: number; from?: string; to?: string } | { year?: undefined; from: string; to: string }
const fileDates = (dates: FileDates) => ({ from: dates.from ?? `${dates.year}-01-01`, to: dates.to ?? `${dates.year}-12-31` })

/**
 * Imports `rows` into `account` as one file dated by `FileDates`, with a bank balance of nothing on the last day unless `ledger` says otherwise. A row has the unique ID it
 * gives, else `${idPrefix}${index}`. An Import recognises rows it already holds.
 */
export async function importRows(
  context: BrowserContext,
  baseURL: string,
  { account, rows, idPrefix = '', ledger, ...dates }: { account: { number: string; name: string }; rows: SeedRow[]; idPrefix?: string; ledger?: { date: string; cents: number } } & FileDates,
) {
  const { from, to } = fileDates(dates)
  const bankBalance = ledger ?? { date: to, cents: 0 }
  const res = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL },
    data: {
      account,
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from, to, ledgerBalance: { cents: bankBalance.cents, date: bankBalance.date } },
      rows: rows.map((r, i) => ({ date: r.date, uniqueId: r.uniqueId ?? `${idPrefix}${i}`, tranType: 'EFTPOS', chequeNumber: r.chequeNumber ?? null, payee: r.payee, bankMemo: 'EFTPOS', amountCents: r.amountCents })),
    },
  })
  expect(res.ok()).toBe(true)
}

/** Overrides each of `rows` that names a Category into it (`categories` gives the IDs by name), finding its Transaction in the Account by its payee. */
export async function overrideCategories(context: BrowserContext, baseURL: string, { accountId, year, rows, categories }: { accountId: number; year: number; rows: SeedRow[]; categories: Record<string, number> }) {
  const { transactions } = (await (await context.request.get(`/api/transactions?accountId=${accountId}&from=${year}-01-01&to=${year}-12-31&limit=200&count=false`)).json()) as { transactions: { id: number; description: string }[] }
  expect(transactions).toHaveLength(rows.length)
  for (const row of rows) {
    if (!row.category) continue
    const found = transactions.find((t) => t.description === row.payee)
    expect(found, row.payee).toBeDefined()
    expect((await context.request.put(`/api/transactions/${found!.id}/override`, { headers: { Origin: baseURL }, data: { categoryId: categories[row.category] } })).ok()).toBe(true)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The page under print media

/** Every word of the Report, and the colour it is written in, and the paper. Run with print media emulated. */
export const blackOnWhite = (page: Page) =>
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

/** The Report is black on white, from either theme: the page's words (more than `atLeast` of them, so the check read something), and the paper. */
export async function expectBlackOnWhite(page: Page, atLeast: number) {
  const { unreadable, paper, texts } = await blackOnWhite(page)
  expect(texts).toBeGreaterThan(atLeast)
  expect(unreadable).toEqual([]) // every word, including the muted ones and the money, is black
  expect(Math.min(...paper)).toBeGreaterThan(240)
}

/** No word of the Report is under 12pt (16px), and the table's own text is set to it, not left to the 15px it has on screen. */
export async function expectNoTextUnder12pt(page: Page, article: Locator, atLeast: number) {
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
  expect(small.texts).toBeGreaterThan(atLeast)
  expect(small.found).toEqual([]) // 12pt is 16px
  const cell = await article.locator('tbody td').first().evaluate((el) => getComputedStyle(el).fontSize)
  expect(parseFloat(cell)).toBeGreaterThanOrEqual(16)
}

/**
 * Printed, a Report is just the Report: no app header, navigation, buttons or links, and none of the page above it, which is for the screen (its heading, what the Report holds and
 * its form). The Report's own title is then the page's one h1; on screen the page's heading is.
 */
export async function expectJustTheReport(page: Page) {
  await expect(page.getByRole('banner')).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
  await expect(page.getByRole('link')).toHaveCount(0)
  await expect(page.getByRole('form')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('article').getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByText('In the print window')).toBeHidden()
}

/** A Report is its own named page with its own margins, repeats a table's headings and keeps a row whole. */
export async function expectOwnPage(page: Page) {
  const styles = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
    return { page: style('.report-frame').page, thead: style('thead').display, row: style('tbody tr').breakInside, main: style('main').paddingLeft }
  })
  expect(styles).toEqual({ page: 'report', thead: 'table-header-group', row: 'avoid', main: '0px' })
}

/** The Report writes its own title block: the app title as typed (`TITLE`), its name, the Account(s), the dates, and who generated it and when. */
export async function expectTitleBlock(article: Locator, { name, account, dates }: { name: string; account: string; dates: string }) {
  const header = article.locator('header')
  await expect(header).toBeVisible()
  await expect(header.getByText(TITLE, { exact: true })).toBeVisible() // the Admin's words, as typed
  await expect(header.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(header).toContainText(`Account: ${account}`)
  await expect(header).toContainText(`Dates: ${dates}`)
  await expect(header.getByText(GENERATED, { exact: true })).toBeVisible()
}

/** The table's heading carries the same identifying lines, which a browser repeats on every page; it is one of the heading rows, with the column headings. */
export async function expectIdentityRow(page: Page, identity: string) {
  const row = page.locator('thead tr').first()
  await expect(row).toBeVisible() // on screen it is not
  await expect(row).toContainText(identity)
  await expect(row).toContainText(GENERATED)
  expect(await page.locator('thead').first().evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
}

// ---------------------------------------------------------------------------------------------------------------
// The PDF the page makes (`readPdf(await page.pdf({ format: 'A4' }))`)

const MM = 72 / 25.4 // points in a millimetre

/** Every page says "Page 2 of 5" once, in the bottom margin (20mm). */
export function expectPageNumbers(pages: PdfPage[]) {
  pages.forEach((p, index) => {
    const numbered = p.text.filter((t) => t.str === `Page ${index + 1} of ${pages.length}`)
    expect(numbered, `page ${index + 1}`).toHaveLength(1)
    expect(numbered[0]!.y).toBeLessThan(20 * MM)
  })
}

/** Nothing in the top margin, and only the page number in the bottom one. */
export function expectBareMargins(pages: PdfPage[]) {
  for (const [index, p] of pages.entries()) {
    expect(p.text.filter((t) => t.y > p.height - 18 * MM), `top margin of page ${index + 1}`).toEqual([])
    expect(p.text.filter((t) => t.y < 20 * MM).map((t) => t.str), `bottom margin of page ${index + 1}`).toEqual([`Page ${index + 1} of ${pages.length}`])
  }
}

/** Every word of the PDF, the page numbers included, is set in at least 12pt type, and there is more than `atLeast` of it, so the check read something. */
export function expectNoTypeUnder12pt(pages: PdfPage[], atLeast: number) {
  expect(pages.flatMap((p, index) => p.text.filter((t) => t.size < 11.95).map((t) => `page ${index + 1}: ${t.size}pt "${t.str}"`))).toEqual([])
  expect(pages.flatMap((p) => p.text).length).toBeGreaterThan(atLeast)
}

/**
 * The lines that say what a Report is, which Account and dates, and who generated it and when, are at the top of every page that has some of its table (the pages
 * with `marker` in them, at least `atLeast` of them). They are in each page's own body, not its margins, so every browser prints them.
 */
export function expectIdentityOnEveryPage(pages: PdfPage[], marker: string | RegExp, identity: string, atLeast: number) {
  const withRows = pages.filter((p) => (typeof marker === 'string' ? textOf(p).includes(marker) : marker.test(textOf(p))))
  expect(withRows.length).toBeGreaterThanOrEqual(atLeast)
  for (const p of withRows) {
    const text = squash(textOf(p))
    expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(identity))
    expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(GENERATED))
  }
  return withRows
}
