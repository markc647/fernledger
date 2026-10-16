import type { Locator, Page } from '@playwright/test'
import { BALANCES, CHECKS, difference, FEATURES, latestCheck, stubBalances } from './balances-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { chooseTextSize, navLink, openNavGroup } from './shell-helpers'

// The Summary is where every Member lands. These tests give an Account a Balance Check mismatch (one file imported by
// the API, a second through the Import screen) and then read the Summary as a Member. The light and dark projects share
// one local database, so each has an Account of its own. Dates are in 2031 so these are the newest Transactions.

const suffix = (testInfo: { project: { name: string } }) => (testInfo.project.name === 'dark' ? '86' : '87')
const accountNumber = (testInfo: { project: { name: string } }) => `99-9999-9999999-${suffix(testInfo)}`
const accountName = (testInfo: { project: { name: string } }) => `Summary Example ${testInfo.project.name}`

const row = (id: string, date: string, amountCents: number) => ({ date, uniqueId: id, tranType: 'EFTPOS', chequeNumber: null, payee: `EXAMPLE SHOP ${id}`, bankMemo: 'EFTPOS', amountCents })

// The second file: two October Transactions that add $3.00 to the account, and a bank balance $5.00 higher than that.
const octoberFile = (suffix: string) =>
  [
    'Created date / time : 8 October 2031 / 09:00:00',
    `Bank 99; Branch 9999; Account 9999999-${suffix} (Summary Example)`,
    'From date 20311001',
    'To date 20311007',
    'Avail Bal : 113.00 as of 20311007',
    'Ledger Balance : 113.00 as of 20311007',
    'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
    '',
    '2031/10/05,2031100501,EFTPOS,,"EXAMPLE SHOP O1","EFTPOS",-1.00',
    '2031/10/06,2031100601,D/C,,"EXAMPLE EMPLOYER O2","WAGES",4.00',
  ].join('\n')

test.describe.configure({ mode: 'serial' })

test('the Admin imports a second file and is told the balance differs from the bank', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  // September: $100.00 before the first Transaction, then +$10.00, -$2.00, -$3.00, leaves $105.00 on 30 September.
  const first = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL! },
    data: {
      account: { number: accountNumber(testInfo), name: accountName(testInfo) },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 3, skipped: 0, from: '2031-09-01', to: '2031-09-30', ledgerBalance: { cents: 10_500, date: '2031-09-30' } },
      rows: [row('S1', '2031-09-10', 1000), row('S2', '2031-09-12', -200), row('S3', '2031-09-20', -300)],
    },
  })
  expect(first.ok()).toBe(true)
  await page.goto('/import')

  await page.getByLabel('Bank export file').setInputFiles({ name: 'october.csv', mimeType: 'text/csv', buffer: Buffer.from(octoberFile(suffix(testInfo))) })
  await expect(page.getByText('as of Tue 7 Oct 2031')).toBeVisible() // the preview shows the bank balance in the file
  await page.getByRole('button', { name: 'Import 2 transactions' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  const result = page.getByRole('status').filter({ hasText: 'Balance differs from bank' })
  await expect(result).toContainText('Balance differs from bank by $5.00 since Tue 30 Sept 2031')
  await expect(result).toContainText("The bank's balance is higher than the Transactions add up to")
  await expect(result.locator('svg[aria-hidden="true"]')).toHaveCount(1) // an icon as well as the words and the colour
  await noAxeViolations(page)
})

test("a Member lands on a Summary with balances, the Balance Check warning in the Account's Checked column, and recent Transactions", async ({ page, context }, testInfo) => {
  await signInAs(context, 'member')
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible()
  const name = accountName(testInfo)

  const balances = page.getByRole('region', { name: 'Balances' })
  const account = balances.getByRole('row', { name: new RegExp(name) })
  await expect(account).toContainText('$113.00') // the bank's own balance on 7 October, which the Summary starts from
  await expect(account).toContainText('Tue 7 Oct 2031')

  // The Balance Check warning is in the Account's own row, in the Checked column after As of: Check, with an icon as well as the word, and by how much. There is no card of Balance checks,
  // and no Sync column: Akahu Sync is not set up (and not built), so no Account could be called Synced.
  const checked = account.getByRole('cell').nth(3)
  await expect(checked).toHaveText('Check: balance differs from the bank by $5.00')
  await expect(checked.locator('svg[aria-hidden="true"]')).toHaveCount(1)
  await expect(balances.getByRole('columnheader')).toHaveText(['Account', 'Balance', 'As of', 'Checked'])
  await expect(page.getByRole('region', { name: 'Balance checks' })).toHaveCount(0)

  const recent = page.getByRole('region', { name: 'Recent transactions' })
  const newest = recent.getByRole('row', { name: new RegExp(`${name} EXAMPLE EMPLOYER O2`) })
  await expect(newest).toContainText('Mon 6 Oct 2031')
  await expect(newest).toContainText('+$4.00')
  await expect(newest).toContainText(name)
  await expect(recent.getByRole('link', { name: 'See all transactions' })).toBeVisible()

  // A Member sees none of the Admin's controls.
  await openNavGroup(page, 'Transactions') // so that what is missing from it is missing from a group that is open
  await expect(navLink(page, 'All Transactions')).toBeVisible()
  await expect(navLink(page, 'Import')).toHaveCount(0)
  await expect(navLink(page, 'Uncategorised')).toHaveCount(0)
})

test('the Summary has no WCAG 2.2 AA violations at the largest text size, on a phone as well', async ({ page, context }) => {
  await signInAs(context, 'member')
  for (const viewport of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await chooseTextSize(page, 'Large')
    await expect(page.getByRole('region', { name: 'Balances' }).getByText('Check', { exact: true }).first()).toBeVisible() // the warning is drawn before the scan
    await expect(page.getByRole('region', { name: 'Recent transactions' })).toContainText('EXAMPLE')
    await noAxeViolations(page)
  }
})

test('on a phone the balances and Transactions become cards, with the same facts', async ({ page, context }, testInfo) => {
  await signInAs(context, 'member')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const card = page.getByRole('list', { name: 'Balance of each Account' }).getByRole('listitem').filter({ hasText: accountName(testInfo) })
  await expect(card).toContainText('Balance')
  await expect(card).toContainText('$113.00')
  await expect(card).toContainText('As of')
})

// Balances, with the answers stubbed, so that what the Checked and Sync columns say is held to exactly the Accounts below whatever else the shared database holds. The Sync column is
// there only when Akahu Sync is set up; Sync is not built yet, so no Account has been synced and the real Worker says it is not set up.
test.describe('the Balances table: Checked and Sync', () => {
  // This file is serial (the first tests build on each other); these stub every answer and need nothing from one another.
  test.describe.configure({ mode: 'default' })

  const open = async (page: Page, options?: Parameters<typeof stubBalances>[1]) => {
    await stubBalances(page, options)
    await page.goto('/')
    const region = page.getByRole('region', { name: 'Balances' })
    await expect(region.getByRole('row', { name: /Example savings/ }).or(region.getByRole('listitem').filter({ hasText: 'Example savings' }))).toBeVisible()
    return region
  }
  const headers = (region: Locator) => region.getByRole('columnheader')
  const row = (region: Locator, name: string) => region.getByRole('row', { name: new RegExp(name) })
  const cell = (region: Locator, name: string, column: 'Checked' | 'Sync') => row(region, name).getByRole('cell').nth(column === 'Checked' ? 3 : 4)

  test('has a Checked column after As of: OK where the checks agree with the bank, Check and by how much where one disagrees, and a dash where nothing was compared', async ({ page, context }) => {
    await signInAs(context, 'member')
    const balances = await open(page)
    await expect(headers(balances)).toHaveText(['Account', 'Balance', 'As of', 'Checked'])

    const agrees = cell(balances, 'Example everyday', 'Checked')
    await expect(agrees).toHaveText('OK: agrees with the bank')
    await expect(agrees.getByText('OK', { exact: true })).toBeVisible()
    await expect(agrees.locator('svg[aria-hidden="true"]')).toHaveCount(1) // an icon as well as the word and the colour

    const differs = cell(balances, 'Example savings', 'Checked')
    await expect(differs).toHaveText('Check: balance differs from the bank by $12.34')
    await expect(differs.getByText('Check', { exact: true })).toBeVisible()
    await expect(differs.getByText('by $12.34')).toBeVisible() // the amount is on the screen too, not only for a screen reader
    await expect(differs.locator('svg[aria-hidden="true"]')).toHaveCount(1)
    await expect(row(balances, 'Example savings')).toContainText('$50,000.00') // its balance is as it was

    const none = cell(balances, 'Example card', 'Checked')
    await expect(none).toHaveAccessibleName('No Balance Check')
    await expect(none.locator('svg')).toHaveCount(0)
    await expect(none.getByText('—')).toBeVisible()
    // The old card of warnings, and the line above the table, are gone.
    await expect(page.getByRole('region', { name: 'Balance checks' })).toHaveCount(0)
    await expect(balances.getByText(/differs? from the bank\. /)).toHaveCount(0)
  })

  test('marks Check in red and OK in green with a different icon, so the meaning is not in the colour alone', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'member')
    const balances = await open(page)
    const [ok, check] = [cell(balances, 'Example everyday', 'Checked').locator('svg'), cell(balances, 'Example savings', 'Checked').locator('svg')]
    expect(await ok.innerHTML()).not.toBe(await check.innerHTML())
    const colour = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el.parentElement!).color)
    expect(await colour(ok)).not.toBe(await colour(check))
  })

  test('says how many earlier differences an Account has, after the newest', async ({ page, context }) => {
    await signInAs(context, 'member')
    const checks = { differences: [difference(2, 'Example savings', 500), difference(2, 'Example savings', -250, '2026-09-30')], accounts: [latestCheck(2, 'Example savings', 'differs')] }
    const balances = await open(page, { checks })
    await expect(cell(balances, 'Example savings', 'Checked')).toHaveText('Check: balance differs from the bank by $5.00 (and 1 earlier)')
  })

  test('shows a difference that an older span has though the latest balance matched the one before it', async ({ page, context }) => {
    await signInAs(context, 'member')
    const checks = { differences: [difference(2, 'Example savings', 500, '2026-09-30')], accounts: [latestCheck(2, 'Example savings', 'matched')] }
    const balances = await open(page, { checks })
    await expect(cell(balances, 'Example savings', 'Checked')).toContainText('Check')
  })

  test('has no Sync column when Akahu Sync is not set up, which is so until Sync is built, whatever an Account says', async ({ page, context }) => {
    await signInAs(context, 'member')
    const balances = await open(page, { syncSetUp: false })
    await expect(headers(balances)).toHaveText(['Account', 'Balance', 'As of', 'Checked'])
    await expect(balances.getByText('Synced')).toHaveCount(0) // the first Account says it was synced, and the column is still not there
  })

  test('has a Sync column after Checked when Akahu Sync is set up: Synced in green where it reached the Account in the last 24 hours, Not Synced in red where not', async ({ page, context }) => {
    await signInAs(context, 'admin')
    const balances = await open(page, { syncSetUp: true })
    await expect(headers(balances)).toHaveText(['Account', 'Balance', 'As of', 'Checked', 'Sync'])

    const synced = cell(balances, 'Example everyday', 'Sync')
    await expect(synced).toHaveText('Synced')
    await expect(synced.locator('svg[aria-hidden="true"]')).toHaveCount(1)
    for (const name of ['Example savings', 'Example card']) {
      const not = cell(balances, name, 'Sync')
      await expect(not).toHaveText('Not Synced')
      await expect(not.locator('svg[aria-hidden="true"]')).toHaveCount(1)
    }
    const [good, bad] = [cell(balances, 'Example everyday', 'Sync').locator('svg'), cell(balances, 'Example savings', 'Sync').locator('svg')]
    expect(await good.innerHTML()).not.toBe(await bad.innerHTML())
  })

  test('shows both as labelled rows of the Account\'s card on a phone', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.setViewportSize({ width: 390, height: 844 })
    const balances = await open(page, { syncSetUp: true })
    const card = balances.getByRole('list', { name: 'Balance of each Account' }).getByRole('listitem').filter({ hasText: 'Example savings' })
    await expect(card).toContainText('Checked')
    await expect(card).toContainText('Check: balance differs from the bank by $12.34')
    await expect(card).toContainText('Sync')
    await expect(card).toContainText('Not Synced')
    const everyday = balances.getByRole('list', { name: 'Balance of each Account' }).getByRole('listitem').filter({ hasText: 'Example everyday' })
    await expect(everyday).toContainText('OK')
    await expect(everyday).toContainText('Synced')
  })

  test('has no WCAG 2.2 AA violations with every state showing, at the largest text size, on a wide screen and on a phone', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const viewport of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      const balances = await open(page, { syncSetUp: true })
      await chooseTextSize(page, 'Large')
      await expect(balances.getByText('Not Synced').first()).toBeVisible()
      await noAxeViolations(page)
    }
  })

  test.describe('when the checks cannot be read', () => {
    test.use({ expectedStatuses: [500] })

    test('shows the balances without a Checked column and says the check could not be made, rather than showing a dash that would say nothing was compared', async ({ page, context }) => {
      await signInAs(context, 'member')
      await page.route('**/api/balances', (route) => route.fulfill({ json: { accounts: BALANCES } }))
      await page.route('**/api/features', (route) => route.fulfill({ json: FEATURES(false) }))
      await page.route('**/api/balance-checks', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto('/')
      const balances = page.getByRole('region', { name: 'Balances' })
      await expect(balances.getByRole('alert')).toHaveText("Fernledger couldn't check the balances against the bank. Reload the page to try again.")
      await expect(balances.getByRole('row', { name: /Example savings/ })).toBeVisible()
      await expect(headers(balances)).toHaveText(['Account', 'Balance', 'As of'])
    })
  })

  test.describe('when it cannot be read whether Sync is set up', () => {
    test.use({ expectedStatuses: [500] })

    test('leaves the Sync column out and shows everything else', async ({ page, context }) => {
      await signInAs(context, 'member')
      await page.route('**/api/balances', (route) => route.fulfill({ json: { accounts: BALANCES } }))
      await page.route('**/api/balance-checks', (route) => route.fulfill({ json: CHECKS }))
      await page.route('**/api/features', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto('/')
      const balances = page.getByRole('region', { name: 'Balances' })
      await expect(headers(balances)).toHaveText(['Account', 'Balance', 'As of', 'Checked'])
      await expect(balances.getByRole('alert')).toHaveCount(0)
    })
  })
})
