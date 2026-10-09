import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

// The light and dark projects run side by side against one local database, so each uses its own made-up Account.
const suffix = (testInfo: { project: { name: string } }) => (testInfo.project.name === 'dark' ? '92' : '93')
const accountName = (testInfo: { project: { name: string } }) => `Cutover example ${testInfo.project.name}`

/** An ASB export of made-up rows. Row dates are `YYYY/MM/DD`, unique IDs start with the date. */
function asbFile(suffix: string, dates: string[]) {
  return [
    'Created date / time : 2 October 2026 / 18:55:26',
    `Bank 99; Branch 9999; Account 9999999-${suffix} (Cutover Example)`,
    'From date 20260901',
    'To date 20261001',
    'Avail Bal : 10.00 as of 20260930',
    'Ledger Balance : 10.00 as of 20261002',
    'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
    '',
    ...dates.map((date, i) => `${date},${date.replaceAll('/', '')}0${i},EFTPOS,,"EXAMPLE SHOP ${date.slice(-2)}","EFTPOS",-1.00`),
  ].join('\n')
}

const chooseFile = (page: Page, text: string) =>
  page.getByLabel('Bank export file').setInputFiles({ name: 'cutover.csv', mimeType: 'text/csv', buffer: Buffer.from(text) })

const summaryValue = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]')

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('the Admin sets the Cutover Date from the file’s last date, and the Import drops rows on or after it', async ({ page, context }, testInfo) => {
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, asbFile(suffix(testInfo), ['2026/09/29', '2026/09/30', '2026/10/01']))
  await page.getByLabel('Account name').fill(accountName(testInfo))

  await page.getByLabel(/Set the Cutover Date to the last date in this file, Thu 1 Oct 2026/).check()
  await expect(page.getByText('1 row in this file is dated on or after Thu 1 Oct 2026 and will not be imported.')).toBeVisible()
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Import 3 transactions' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(summaryValue(page, 'Added')).toHaveText('2')
  await expect(summaryValue(page, 'On or after the Cutover Date (not imported)')).toHaveText('1')
})

test('the Admin changes and clears the Cutover Date in Settings, which explains what it does', async ({ page, context }, testInfo) => {
  const name = accountName(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 2, name: 'Cutover Dates' })).toBeVisible()
  await expect(page.getByText('Setting or clearing it deletes nothing already saved: imported rows already saved on or after the date stay')).toBeVisible()
  const field = page.getByLabel(`Cutover Date for ${name}`, { exact: true })
  await expect(field).toHaveValue('2026-10-01')
  await noAxeViolations(page)

  await field.fill('2026-09-30')
  await page.locator('form', { has: field }).getByRole('button', { name: 'Save Cutover Date' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Cutover Date saved.' })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel(`Cutover Date for ${name}`, { exact: true })).toHaveValue('2026-09-30')

  await page.getByRole('button', { name: `Clear the Cutover Date for ${name}` }).click()
  await expect(page.getByLabel(`Cutover Date for ${name}`, { exact: true })).toHaveValue('')
  await page.reload()
  await expect(page.getByLabel(`Cutover Date for ${name}`, { exact: true })).toHaveValue('')
})

test('the Admin replaces imported history after confirming, and the old rows go', async ({ page, context }, testInfo) => {
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, asbFile(suffix(testInfo), ['2026/09/10', '2026/09/11', '2026/09/12']))
  await expect(page.getByText(`Existing Account: ${accountName(testInfo)}`)).toBeVisible()

  const trigger = page.getByRole('button', { name: 'Replace imported history…' })
  const dialog = page.getByRole('alertdialog')
  await trigger.click()
  await expect(dialog).toContainText('removes the 2 Transactions that were imported into this Account')
  // The safe answer has focus, so Enter or a stray tap doesn't remove anything.
  await expect(page.getByRole('button', { name: 'No, keep what is there' })).toBeFocused()
  await noAxeViolations(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await page.getByRole('button', { name: 'No, keep what is there' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await page.getByRole('button', { name: 'Yes, replace imported history' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(summaryValue(page, 'Added')).toHaveText('3')
  await expect(summaryValue(page, 'Old imported Transactions removed')).toHaveText('2')

  await page.getByRole('link', { name: 'See the transactions' }).click()
  const name = accountName(testInfo)
  await expect(page.getByRole('row', { name: new RegExp(`Sat 12 Sept 2026 ${name} EXAMPLE SHOP 12`) })).toBeVisible()
  await expect(page.getByRole('row', { name: new RegExp(`${name} EXAMPLE SHOP 29`) })).toHaveCount(0)
})

test('the Cutover Date checkbox has a touch target of at least 44px', async ({ page, context }, testInfo) => {
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, asbFile(suffix(testInfo), ['2026/09/10']))

  const box = await page.locator('label[for="set-cutover"]').boundingBox()
  expect(box?.height).toBeGreaterThanOrEqual(44)
})

test('the Import refuses to offer a replace that would import nothing', async ({ page, context }, testInfo) => {
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, asbFile(suffix(testInfo), ['2026/10/01']))
  await page.getByLabel(/Set the Cutover Date to the last date in this file/).check() // the only row is dated on the file's last date

  await expect(page.getByRole('button', { name: 'Replace imported history…' })).toBeDisabled()
  await expect(page.getByText('there is nothing to replace the old history with')).toBeVisible()
})

test('a Member sees no Cutover Date controls', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/settings')

  await expect(page.getByText('Only the Admin can change settings.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Cutover Dates' })).toHaveCount(0)
})
