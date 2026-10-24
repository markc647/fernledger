import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'
import { helpButton } from './help-helpers'
import {
  BALANCES_NOTES_TITLE,
  closeNotes,
  ensureCategory,
  forgetKeptReportsAfterEach,
  importRows,
  NOTES_TITLE,
  notesButton,
  notesSheet,
  openNotes,
  signInToOpen,
} from './report-helpers'

// A Report's notes (`ReportNotes`, src/components/report-frame.tsx, CODING_STANDARDS.md#ui): what a reader reads once about its figures is not on the screen under the Report's title, where it
// would push the figures down. It is in a sheet, the same HelpSheet as the page's "?", behind a "?" beside the Report's own title, and on paper it stays a section before the figures. The
// sheet is the page's component, tested once in help-sheet.spec.ts; here the Spending by Category Report is tested for where its "?" is and that Esc gives focus back to it, and each of the
// five for what they share. What each says, and the paper layout it takes part in, are in the Reports' own specs.

forgetKeptReportsAfterEach() // the Admin showing a Report keeps it on the Reports page's list, which every spec shares

const YEAR = 2009
const FROM = `${YEAR}-01-01`
const TO = `${YEAR}-03-31`
const ACCOUNT = { number: '99-9999-9999999-35', name: 'Notes spending' }

/** An Account with one Transaction, and a Loans Category, so that every Report has something to be opened on. The caller has signed in as the Admin. Returns the Account's ID. */
async function seed(context: BrowserContext, baseURL: string) {
  await importRows(context, baseURL, { account: ACCOUNT, year: YEAR, rows: [{ date: `${YEAR}-01-10`, payee: 'REPORTNOTES shop', amountCents: -1234 }], idPrefix: `RN${YEAR}` })
  await ensureCategory(context, baseURL, 'Notes loan', 'loans')
  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  return accounts.find((a) => a.name === ACCOUNT.name)!.id
}

type Case = {
  /** The Report's name, and the last part of its address. */
  name: string
  path: string
  /** Its address takes the Account (the Budget vs actual and Loans Reports are of all of them). */
  account: boolean
  /** What its "?" is called and its sheet titled. */
  title: string
  /** A sentence of the notes, to find them by. */
  says: string
}
const SPENDING: Case = { name: 'Spending by Category', path: 'spending', account: true, title: NOTES_TITLE, says: 'Uncategorised counts as spending, so money in that has no Category yet comes off it.' }
const OTHERS: Case[] = [
  { name: 'Income vs spending by month', path: 'income-vs-spending', account: true, title: NOTES_TITLE, says: 'Income is what the Income Categories brought in each month' },
  { name: 'Loans', path: 'loans', account: false, title: NOTES_TITLE, says: 'Each loan is a Loans Category, one for each person' },
  { name: 'Balances over time', path: 'balances', account: true, title: BALANCES_NOTES_TITLE, says: 'a row for every month in these dates' },
  { name: 'Budget vs actual', path: 'budget-vs-actual', account: false, title: NOTES_TITLE, says: 'Each month is compared with the Budget in effect for it.' },
]

const address = (c: Case, accountId: number) => `/reports/${c.path}?${c.account ? `account=${accountId}&` : ''}from=${FROM}&to=${TO}`
const articleOf = (page: Page, c: Case) => page.getByRole('article', { name: c.name, exact: true })

/** Waits until the Report is on the page, figures and all: the way back to the Reports is under them. So "the notes are not there" is not true only because nothing is yet. */
async function showing(page: Page, c: Case) {
  await expect(articleOf(page, c)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to Reports' })).toBeVisible()
  return articleOf(page, c)
}

test.describe('the Spending by Category Report', () => {
  test('has its notes behind a "?" beside its own title, not on the screen, and Esc gives focus back to the "?"', async ({ page, context, baseURL }) => {
    await signInAs(context, 'admin')
    const accountId = await seed(context, baseURL!)
    await page.goto(address(SPENDING, accountId))
    const report = await showing(page, SPENDING)

    // Beside the Report's own title, which is below the form, and not the page's "?": that is "About this page", beside the page's heading.
    const own = notesButton(report)
    await expect(own).toBeVisible()
    await expect(helpButton(page)).toBeVisible()
    await expect(page.getByRole('button', { name: NOTES_TITLE, exact: true })).toHaveCount(1)
    const title = report.getByText(SPENDING.name, { exact: true }).filter({ visible: true }) // the Report's name; on paper it is a heading, which is not drawn on the screen
    const titleBox = (await title.boundingBox())!
    const buttonBox = (await own.boundingBox())!
    const formBox = (await page.getByRole('form', { name: SPENDING.name }).boundingBox())!
    expect(buttonBox.x, 'after the title, not under it').toBeGreaterThanOrEqual(titleBox.x + titleBox.width - 1)
    const middle = buttonBox.y + buttonBox.height / 2
    expect(middle, 'level with the title').toBeGreaterThan(titleBox.y)
    expect(middle).toBeLessThan(titleBox.y + titleBox.height)
    expect(buttonBox.y, 'under the form').toBeGreaterThan(formBox.y + formBox.height)
    expect(buttonBox.width, 'a touch target, as every button is').toBeGreaterThanOrEqual(44)
    expect(buttonBox.height).toBeGreaterThanOrEqual(44)

    // The notes are in the page for paper, and not on the screen: nothing named for them, and none of their words showing.
    const says = report.getByText(SPENDING.says)
    await expect(says).toHaveCount(1)
    await expect(says).toBeHidden()
    await expect(report.getByRole('region', { name: NOTES_TITLE })).toHaveCount(0)
    await expect(notesSheet(page)).toHaveCount(0)

    // It opens with the notes, and Esc gives focus back to this "?" (the sheet itself, from the right with Close at its foot, is tested once, in e2e/help-sheet.spec.ts).
    const sheet = await openNotes(page, report)
    const text = sheet.getByRole('region', { name: NOTES_TITLE })
    await expect(text).toContainText('money out less money back, such as a refund.')
    await expect(text).toContainText(SPENDING.says)
    await expect(text).toContainText("Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted.")
    await closeNotes(page)
    await expect(own).toBeFocused()
  })
})

// The same of the other four: the "?" is called for their notes, they are not on the screen, the sheet has them, and the paper has the same words in a section named the same.
for (const c of [SPENDING, ...OTHERS]) {
  test(`${c.name}: its notes are in a sheet on the screen and a section on paper, the same paragraphs, and the "?" is not printed`, async ({ page, context, baseURL }) => {
    await signInAs(context, 'admin')
    const accountId = await seed(context, baseURL!)
    await page.goto(address(c, accountId))
    const report = await showing(page, c)

    await expect(notesButton(report, c.title)).toBeVisible()
    await expect(report.getByText(c.says)).toBeHidden() // not on the screen
    await expect(report.getByRole('region', { name: c.title })).toHaveCount(0)
    const sheet = await openNotes(page, report, c.title)
    await expect(sheet.getByRole('heading', { name: c.title })).toBeVisible()
    await expect(sheet.getByRole('region', { name: c.title })).toContainText(c.says)
    const onScreen = await sheet.getByRole('region', { name: c.title }).locator('p').allTextContents()
    expect(onScreen.length).toBeGreaterThan(1)
    await closeNotes(page, c.title)

    await page.emulateMedia({ media: 'print' })
    const printed = report.getByRole('region', { name: c.title })
    await expect(printed).toBeVisible()
    await expect(printed.getByRole('heading', { level: 2, name: c.title })).toBeVisible()
    expect(await printed.locator('p').allTextContents(), 'written once: the same on paper').toEqual(onScreen)
    await expect(notesButton(report, c.title)).toBeHidden()
  })
}

test.describe('the Transaction listing', () => {
  test('has no notes, so no "?" of its own', async ({ page, context, baseURL }) => {
    await signInAs(context, 'admin')
    const accountId = await seed(context, baseURL!)
    await page.goto(`/reports/transactions?account=${accountId}&from=${FROM}&to=${TO}`)
    const report = page.getByRole('article', { name: 'Transaction listing', exact: true })
    await expect(report).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to Reports' })).toBeVisible()
    await expect(report.getByRole('button')).toHaveCount(0)
    await expect(helpButton(page)).toBeVisible() // the page's own "?" is there
  })
})

test.describe('a Member', () => {
  test('opens a kept Report with its notes behind the same "?", and not on the screen', async ({ page, context, baseURL }) => {
    await signInAs(context, 'admin')
    const accountId = await seed(context, baseURL!)
    await signInToOpen(context, baseURL, 'member', { report: SPENDING.path, accountId, from: FROM, to: TO })
    await page.goto(address(SPENDING, accountId))
    const report = await showing(page, SPENDING)

    await expect(page.getByRole('form')).toHaveCount(0) // a Member has no form
    await expect(report.getByText(SPENDING.says)).toBeHidden()
    const sheet = await openNotes(page, report)
    await expect(sheet.getByRole('region', { name: NOTES_TITLE })).toContainText(SPENDING.says)
    await page.keyboard.press('Escape')
    await expect(notesButton(report)).toBeFocused()
  })
})
