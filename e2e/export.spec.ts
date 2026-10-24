import { readFileSync } from 'node:fs'
import type { Locator } from '@playwright/test'
import { pickDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { importRows } from './report-helpers'
import { accessRedirect } from './session-helpers'

// The Export page (src/routes/export.tsx): the Transactions page's filters, and Download CSV for the Transactions that match them. The light and dark projects share one local database,
// so each has an Account of its own. Dated in 2008, a year no other spec's Transactions are in, and found by a stamp in their descriptions.
const accountFor = (project: string) => ({ number: project === 'dark' ? '99-9999-9999999-24' : '99-9999-9999999-25', name: `Export savings ${project}` })

const EXPLANATION =
  "Download CSV saves the Transactions that match the filters you last searched with, oldest first, to open in a spreadsheet. Once saved, a file is outside Fernledger's sign-in: see what it can't protect against."
const WARNING = 'Only the oldest up to 5,000 will be saved (fewer if Notes are long). Set From and To to one year at a time to save the rest.'

test('a Member searches for Transactions and downloads them as a CSV file, with formulas defused, once Search has been pressed', async ({ page, context, baseURL }, testInfo) => {
  const account = accountFor(testInfo.project.name)
  const stamp = `csv${testInfo.project.name}${Date.now()}`
  await signInAs(context, 'admin')
  await importRows(context, baseURL!, {
    account,
    year: 2008,
    idPrefix: stamp,
    rows: [
      { date: '2008-06-02', payee: `=EXAMPLE ${stamp} FORMULA`, amountCents: -1234 },
      { date: '2008-06-01', payee: `EXAMPLE ${stamp} PLAIN`, amountCents: 5000 },
      { date: '2008-07-01', payee: `EXAMPLE ${stamp} OUTSIDE`, amountCents: -100 },
    ],
  })
  await signInAs(context, 'member')
  await page.goto('/export')
  await expect(page.getByRole('heading', { level: 1, name: 'Export', exact: true })).toBeVisible()
  const matches = page.locator('#filter-download-count')
  await expect(matches).toContainText('Transaction') // the count has arrived
  const link = page.getByRole('link', { name: 'Download CSV' })
  await expect(link).toHaveAttribute('href', '/api/transactions/export.csv') // nothing searched for yet: every Transaction

  // The fields are not applied until Search is pressed, and the file waits for them.
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill(stamp)
  await pickDate(page, 'From', '2008-06-01')
  await pickDate(page, 'To', '2008-06-30')
  await expect(page.getByText('Press Search to apply these filters.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled()
  await expect(link).toHaveCount(0)
  await page.getByRole('button', { name: 'Search', exact: true }).click()

  // They are in the address, and the file is of what was searched for.
  await expect(page).toHaveURL(new RegExp(`/export\\?.*q=${stamp}`))
  await expect(page).toHaveURL(/from=2008-06-01/)
  await expect(page).toHaveURL(/to=2008-06-30/)
  await expect(matches).toHaveText('2 Transactions match')
  await expect(link).toBeVisible()
  await expect(page.getByText('Press Search to apply these filters.')).toHaveCount(0)
  // The page is the form and the file, and not a list of the Transactions that match: two do, and neither is on it.
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0)
  await expect(page.getByText(`EXAMPLE ${stamp} PLAIN`)).toHaveCount(0)
  await noAxeViolations(page)

  const [file] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(file.suggestedFilename()).toBe('fernledger-transactions-2008-06-01-to-2008-06-30.csv')
  const text = readFileSync(await file.path(), 'utf8')
  const byteOrderMark = String.fromCharCode(0xfeff) // so Excel reads the file as UTF-8
  expect(text).toBe(
    [
      `${byteOrderMark}Date,Account,Description,Category,Note,Amount,Bank type,Bank memo,Bank reference,Bank counterparty account,Bank particulars,Bank payment code,Bank card suffix`,
      // A bank file gives a type and a memo and none of the rest, which are empty cells all the same.
      `2008-06-01,${account.name},EXAMPLE ${stamp} PLAIN,Uncategorised,,50.00,EFTPOS,EFTPOS,,,,,`,
      `2008-06-02,${account.name},'=EXAMPLE ${stamp} FORMULA,Uncategorised,,-12.34,EFTPOS,EFTPOS,,,,,`,
      '',
      'Totals',
      'Money in,50.00',
      'Money out,-12.34',
      'Net,37.66',
      'Transactions,2',
      '',
    ].join('\r\n'),
  )

  // Typing over a field takes the file away again until Search is pressed, and typing it back gives the file back.
  const searchbox = page.getByRole('searchbox', { name: 'Search', exact: true })
  await searchbox.fill('something else')
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled()
  await expect(link).toHaveCount(0)
  await searchbox.fill(stamp)
  await expect(link).toBeVisible()

  // Clear filters starts again, and the address with it.
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page).not.toHaveURL(/q=/)
  await expect(link).toHaveAttribute('href', '/api/transactions/export.csv')
})

test('says what a saved file leaves unprotected, always, and warns of the cap only when more match than a file holds', async ({ page, context }) => {
  await signInAs(context, 'member')
  let total = 5001
  await page.route(/\/api\/transactions\?/, (route) => route.fulfill({ json: { total, transactions: [] } }))
  const matches = page.locator('#filter-download-count')
  const explanation = page.getByText(EXPLANATION, { exact: true })
  const warning = page.getByText(WARNING, { exact: true })
  const top = async (locator: Locator) => (await locator.boundingBox())!.y
  const colourOf = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color)

  await page.goto('/export')
  await expect(matches).toHaveText('5,001 Transactions match')
  await expect(warning).toBeVisible()
  // The warning is in a status region, which the page always has, so that a screen reader announces it when it comes; and both are under the heading and above the form.
  await expect(page.getByRole('status').filter({ has: warning })).toBeVisible()
  await expect(page.getByRole('status').filter({ has: matches })).toBeVisible() // and the count is announced when a search changes it
  expect(await top(page.getByRole('heading', { level: 1, name: 'Export', exact: true }))).toBeLessThan(await top(explanation))
  expect(await top(explanation)).toBeLessThan(await top(warning))
  expect(await top(warning)).toBeLessThan(await top(page.getByRole('search', { name: 'Search Transactions' })))
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAccessibleDescription(/5,001 Transactions match.*Only the oldest up to 5,000 will be saved.*Download CSV saves the Transactions/)
  // The explanation is the same lighter grey as a field's hint; the warning is not.
  expect(await colourOf(explanation)).toBe(await colourOf(page.locator('#filter-q-hint')))
  expect(await colourOf(warning)).not.toBe(await colourOf(explanation))
  await noAxeViolations(page)

  // Exactly the most is not too many, and one is "matches". The explanation is there either way.
  total = 5000
  await page.reload()
  await expect(matches).toHaveText('5,000 Transactions match')
  await expect(warning).toHaveCount(0)
  await expect(explanation).toBeVisible()
  total = 1
  await page.reload()
  await expect(matches).toHaveText('1 Transaction matches')
  await expect(explanation).toBeVisible()

  // What leaves Fernledger's protection is explained in the README, and the explanation links to that section.
  await expect(explanation.getByRole('link', { name: "what it can't protect against" })).toHaveAttribute('href', 'https://github.com/markc647/fernledger#what-it-cant-protect-against')
})

// The link is followed by the browser itself and not through the API client, so once Access's session has run out it would save Access's sign-in page as the CSV file. The sign-in is
// checked through the client first (src/components/transaction-export.tsx): the banner says so, and nothing is asked for or saved until the next press works.
test('Download CSV saves no file when the sign-in has expired, says so, and saves it once signed in again', async ({ page, context }) => {
  await signInAs(context, 'member')
  let expired = false
  await page.route('**/api/me', (route) => (expired ? accessRedirect(route) : route.fallback()))
  let saved = 0
  page.on('download', () => saved++)
  await page.goto('/export')
  const link = page.getByRole('link', { name: 'Download CSV' })
  await expect(link).toBeVisible()
  await expect(page.locator('#filter-download-count')).toContainText('Transaction')

  expired = true
  await link.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Your sign-in has expired' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(saved).toBe(0) // Access's sign-in page is not saved as the CSV

  expired = false
  const [file] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(file.suggestedFilename()).toMatch(/\.csv$/)
  expect(saved).toBe(1)
  await expect(page.getByRole('alert').filter({ hasText: 'sign-in' })).toHaveCount(0) // who is signed in worked, and the banner went
})

test('an address naming no such Account or Category, or a range that runs backwards, says so and has no file to download', async ({ page, context }) => {
  await signInAs(context, 'member')
  for (const [address, message] of [
    ['/export?account=abc', 'There is no such Account. Choose one in the form above.'],
    ['/export?account=0', 'There is no such Account. Choose one in the form above.'],
    ['/export?account=999999999', 'There is no such Account. Choose one in the form above.'],
    ['/export?category=abc', 'There is no such Category. Choose one in the form above.'],
    ['/export?category=999999999', 'There is no such Category. Choose one in the form above.'],
    ['/export?from=2008-10-09&to=2008-10-08', 'The “To” date is before the “From” date. Change one of them to save Transactions.'],
  ] as const) {
    await page.goto(address)
    await expect(page.getByRole('alert'), address).toHaveText(message)
    await expect(page.getByRole('button', { name: 'Download CSV' }), address).toBeDisabled()
    await expect(page.getByRole('link', { name: 'Download CSV' }), address).toHaveCount(0)
  }
  await noAxeViolations(page)

  // Back to no such Account from a search that matched keeps none of that search's count.
  await page.goto('/export?account=999999999')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByLabel('Account', { exact: true }).selectOption({ label: 'All Accounts' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText(/Transactions? match/)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('alert')).toHaveText('There is no such Account. Choose one in the form above.')
  await expect(page.getByText(/Transactions? match/)).toHaveCount(0)
})

test('says so when the Transactions that match cannot be counted', async ({ page, context }) => {
  await signInAs(context, 'member')
  // A body that isn't JSON fails the query without a failed request, which the fixture would report as a console error.
  await page.route(/\/api\/transactions\?/, (route) => route.fulfill({ contentType: 'application/json', body: 'not json' }))
  await page.goto('/export')
  // The query tries again a few times before it gives up.
  await expect(page.getByRole('alert')).toHaveText("Fernledger couldn't count the Transactions that match. Reload the page to try again.", { timeout: 15_000 })
  await expect(page.locator('#filter-download-count')).toHaveCount(0)
})
