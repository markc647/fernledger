import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { textOf, type PdfPage } from './pdf-text'

// What every Report's browser tests share (reports.spec.ts, report-balances.spec.ts, report-spending.spec.ts): the title block and print layout of ticket 18's Report
// frame, which a Report must keep (README: Reports). A spec checks what is its own (the figures, its Accounts, its dates) and calls these for the rest, so a change to
// the frame is one change here and a new Report adds no fourth copy.

export const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
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

/** A line of a PDF's text with every space taken out, for "contains" checks that must not care where a long line wrapped (even inside an Account's number at a hyphen). */
export const squash = (text: string) => text.replace(/\s+/g, '')

export const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

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

/** Printed, a Report is just the Report: no app header, navigation, buttons or links. */
export async function expectJustTheReport(page: Page) {
  await expect(page.getByRole('banner')).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
  await expect(page.getByRole('link')).toHaveCount(0)
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
  expect(await page.locator('thead').evaluate((el) => [getComputedStyle(el).display, el.querySelectorAll('tr').length])).toEqual(['table-header-group', 2])
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
export function expectIdentityOnEveryPage(pages: PdfPage[], marker: string, identity: string, atLeast: number) {
  const withRows = pages.filter((p) => textOf(p).includes(marker))
  expect(withRows.length).toBeGreaterThanOrEqual(atLeast)
  for (const p of withRows) {
    const text = squash(textOf(p))
    expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(identity))
    expect(text, `page ${pages.indexOf(p) + 1}`).toContain(squash(GENERATED))
  }
  return withRows
}
