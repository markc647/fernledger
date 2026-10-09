import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Role } from '../src/generated/api/auth'
import { expect, test } from './fixtures'

const signInAs = (context: BrowserContext, role: Role) =>
  context.addCookies([{ name: 'fernledger_dev_as', value: role, url: `http://localhost:${process.env.E2E_PORT ?? 5199}` }])

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/asb/${name}`, import.meta.url), 'utf8')

// The light and dark projects run side by side against one local database, so each uses its own made-up Accounts.
const isDark = (testInfo: { project: { name: string } }) => testInfo.project.name === 'dark'
const suffixes = (testInfo: { project: { name: string } }) => (isDark(testInfo) ? { small: '96', big: '94' } : { small: '97', big: '95' })
const numberWith = (suffix: string) => `99-9999-9999999-${suffix}`
const asbFile = (text: string, suffix: string) => text.replaceAll('Account 9999999-99', `Account 9999999-${suffix}`)

const chooseFile = (page: Page, name: string, text: string) =>
  page.getByLabel('Bank export file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })

/** An ASB export of `count` made-up rows, all in 2018 so they sort after every other fixture in the list. */
function bigFile(count: number, suffix: string) {
  const rows = Array.from({ length: count }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0')
    return `2018/05/${day},2018${String(i).padStart(7, '0')},EFTPOS,,"EXAMPLE SHOP ${i}","EFTPOS",-1.00`
  })
  return [
    'Created date / time : 2 October 2026 / 18:55:26',
    `Bank 99; Branch 9999; Account 9999999-${suffix} (Big Example)`,
    'From date 20180501',
    'To date 20181001',
    'Avail Bal : 10.00 as of 20260930',
    'Ledger Balance : 10.00 as of 20261002',
    'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
    '',
    ...rows,
  ].join('\n')
}

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('the Admin previews an ASB file, then imports it and sees the summary and the Transactions', async ({ page, context }, testInfo) => {
  const { small } = suffixes(testInfo)
  const name = `Mum savings ${testInfo.project.name}`
  await signInAs(context, 'admin')
  await page.goto('/import')
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible()
  await noAxeViolations(page)

  await chooseFile(page, 'savings.csv', asbFile(fixture('savings.csv'), small))

  await expect(page.getByRole('heading', { level: 2, name: 'Preview' })).toBeVisible()
  await expect(page.getByText(numberWith(small), { exact: true })).toBeVisible()
  await expect(page.getByText('New Account')).toBeVisible()
  await expect(page.getByText('8 transactions to import')).toBeVisible()
  await expect(page.getByText('Wed 2 Oct 2019 to Fri 2 Oct 2026')).toBeVisible()
  await page.getByLabel('Account name').fill(name)
  await noAxeViolations(page)

  await page.getByRole('button', { name: 'Import 8 transactions' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(page.getByText('Added', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('8')
  await expect(page.getByText('Already held (skipped)').locator('xpath=following-sibling::dd[1]')).toHaveText('0')
  await expect(page.getByText('Could not be read (skipped)').locator('xpath=following-sibling::dd[1]')).toHaveText('0')
  await noAxeViolations(page)

  await page.getByRole('link', { name: 'See the transactions' }).click()
  const interest = page.getByRole('row', { name: new RegExp(`Thu 31 Oct 2019 ${name} ASB BANK - INTEREST`) })
  await expect(interest).toContainText('+$1.20')
  await expect(page.getByRole('row', { name: new RegExp(`${name} EXAMPLE, SMITH & CO`) })).toContainText('-$1,234.50')
  await noAxeViolations(page)
})

test('importing the same file again adds nothing', async ({ page, context }, testInfo) => {
  const { small } = suffixes(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, 'savings.csv', asbFile(fixture('savings.csv'), small))
  await expect(page.getByText(`Existing Account: Mum savings ${testInfo.project.name}`)).toBeVisible()

  await page.getByRole('button', { name: 'Import 8 transactions' }).click()

  await expect(page.getByText('Added', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('0')
  await expect(page.getByText('Already held (skipped)').locator('xpath=following-sibling::dd[1]')).toHaveText('8')
})

test('rows that cannot be read are reported by line, without their values, and skipped', async ({ page, context }, testInfo) => {
  const { small } = suffixes(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/import')

  await chooseFile(page, 'malformed.csv', asbFile(fixture('malformed-rows.csv'), small))

  await expect(page.getByText('2 transactions to import')).toBeVisible()
  await expect(page.getByText('4 rows could not be read')).toBeVisible()
  await expect(page.getByText('Line 10: Invalid Date')).toBeVisible()
  await expect(page.getByText('BAD DATE')).toHaveCount(0)
  await noAxeViolations(page)

  await page.getByRole('button', { name: 'Import 2 transactions' }).click()
  await expect(page.getByText('Could not be read (skipped)').locator('xpath=following-sibling::dd[1]')).toHaveText('4')
})

test('a file over 500 rows is sent in chunks, one request each', async ({ page, context }, testInfo) => {
  const { big } = suffixes(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/import')
  const chunkRequests: number[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/imports/chunks')) chunkRequests.push((request.postDataJSON() as { rows: unknown[] }).rows.length)
  })

  await chooseFile(page, 'big.csv', bigFile(1200, big))
  await page.getByRole('button', { name: 'Import 1200 transactions' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(page.getByText('Added', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('1200')
  expect(chunkRequests).toEqual([500, 500, 200])
})

test('a file that is not a supported bank export is explained, not imported', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/import')

  await chooseFile(page, 'notes.csv', 'Date,Thing\n2026/10/01,Something\n')

  await expect(page.getByRole('alert')).toContainText('not a supported bank export')
  await expect(page.getByRole('button', { name: /^Import \d+ transactions$/ })).toHaveCount(0)
  await noAxeViolations(page)
})

test('the Admin renames an Account and the new name shows on its Transactions', async ({ page, context }, testInfo) => {
  const before = `Mum savings ${testInfo.project.name}`
  const after = `Mum's nest egg ${testInfo.project.name}`
  await signInAs(context, 'admin')
  await page.goto('/accounts')
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()

  await page.getByRole('button', { name: `Rename ${before}` }).click()
  await page.getByLabel('Account name').fill(after)
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save name' }).click()

  await expect(page.getByRole('cell', { name: after })).toBeVisible()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transactions' }).click()
  await expect(page.getByRole('row', { name: new RegExp(`${after} ASB BANK - INTEREST`) })).toBeVisible()
})

test('a Member sees Transactions and Accounts but no Import and no rename', async ({ page, context }, testInfo) => {
  await signInAs(context, 'member')
  await page.goto('/transactions')
  const nav = page.getByRole('navigation', { name: 'Main' })

  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
  await expect(page.getByRole('row', { name: /ASB BANK - INTEREST/ }).first()).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Import' })).toHaveCount(0)
  await noAxeViolations(page)

  await nav.getByRole('link', { name: 'Accounts' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
  await expect(page.getByRole('cell', { name: numberWith(suffixes(testInfo).small) })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Rename/ })).toHaveCount(0)
  await noAxeViolations(page)

  await page.goto('/import')
  await expect(page.getByText('Only the Admin can import files.')).toBeVisible()
  await expect(page.getByLabel('Bank export file')).toHaveCount(0)
  await noAxeViolations(page)
})
