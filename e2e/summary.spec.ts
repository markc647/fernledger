import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

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

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

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

test('a Member lands on a Summary with balances, recent Transactions and the Balance Check warning', async ({ page, context }, testInfo) => {
  await signInAs(context, 'member')
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible()
  const name = accountName(testInfo)

  const balances = page.getByRole('region', { name: 'Balances' })
  const account = balances.getByRole('row', { name: new RegExp(name) })
  await expect(account).toContainText('$113.00') // the bank's own balance on 7 October, which the Summary starts from
  await expect(account).toContainText('Tue 7 Oct 2031')

  const warnings = page.getByRole('region', { name: 'Balance checks' })
  const warning = warnings.getByRole('listitem').filter({ hasText: name })
  await expect(warning).toContainText('Balance differs from bank by $5.00 since Tue 30 Sept 2031')
  await expect(warning.locator('svg[aria-hidden="true"]')).toHaveCount(1)

  const recent = page.getByRole('region', { name: 'Recent transactions' })
  const newest = recent.getByRole('row', { name: new RegExp(`${name} EXAMPLE EMPLOYER O2`) })
  await expect(newest).toContainText('Mon 6 Oct 2031')
  await expect(newest).toContainText('+$4.00')
  await expect(newest).toContainText(name)
  await expect(recent.getByRole('link', { name: /See all [\d,]+ transactions/ })).toBeVisible()

  // A Member sees none of the Admin's controls.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Import' })).toHaveCount(0)
})

test('the Summary has no WCAG 2.2 AA violations at the largest text size, on a phone as well', async ({ page, context }) => {
  await signInAs(context, 'member')
  for (const viewport of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.getByRole('group', { name: 'Text size' }).getByRole('button', { name: 'A++', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Balance checks' }).getByRole('listitem').first()).toBeVisible()
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
