import type { Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'

// An Account whose bank prints no account number: the Admin adds it by name, Fernledger keys it, and an Import of the card's CSV
// asks which Account the file is for, because the file cannot say (#39, ADR 0017).
//
// The light and dark projects run side by side against one local database, so each uses its own made-up Account. No entry in
// e2e/account-numbers.json is needed: this Account has no bank number to claim, and the Worker allocates its key.
const cardName = (testInfo: { project: { name: string } }) => `Example card ${testInfo.project.name}`

/** A made-up Kiwibank credit card export: Date, Description, Card, Amount (docs/bank-formats/kiwibank.md). */
const cardFile = (rows: string[]) => ['Date,Description,Card,Amount', ...rows].join('\n')

const chooseFile = (page: Page, text: string) =>
  page.getByLabel('Bank export file').setInputFiles({ name: 'card.csv', mimeType: 'text/csv', buffer: Buffer.from(text) })

const summaryValue = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]')

test.describe.configure({ mode: 'serial' })

test('the Admin adds a credit card Account by name, and it shows no number from the bank', async ({ page, context }, testInfo) => {
  const name = cardName(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/accounts')

  await expect(page.getByRole('heading', { level: 2, name: 'Add a Credit Card Account' })).toBeVisible()
  await page.getByLabel('Credit card Account name').fill(name)
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Add the Account' }).click()

  await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()
  // The key Fernledger gave it is never shown as the bank's number; the name is what identifies the Account. The Account's own
  // row is the first that carries its name: what Akahu says sits in a row of its own under it, which names it too.
  const row = () => page.getByRole('row').filter({ hasText: name }).first()
  await expect(row()).toContainText('None from the bank')
  await expect(row()).not.toContainText('card-')
  await page.reload()
  await expect(row()).toContainText('None from the bank')
})

test('the Import asks which Account a file with no account number is for, and imports into the one chosen', async ({ page, context }, testInfo) => {
  const name = cardName(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, cardFile(['2026-09-02,EXAMPLE CAFE TOWN,9999,-4.50', '2026-09-02,EXAMPLE CAFE TOWN,9999,-4.50', '2026-09-03,EXAMPLE HARDWARE,9999,-129.95']))

  await expect(page.getByText('Kiwibank credit card', { exact: true })).toBeVisible()
  // What the file does not have, said rather than left blank.
  await expect(page.getByText('None in this file', { exact: true })).toBeVisible()
  await expect(page.getByText('None in this file, so this Import has no Balance Check')).toBeVisible()

  // Nothing is matched, so the Import cannot start until the Admin says which Account the file is for.
  await expect(page.getByRole('button', { name: 'Import 3 transactions' })).toBeDisabled()
  await page.getByLabel('Which Account is this file for?').selectOption({ label: name })
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Import 3 transactions' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(summaryValue(page, 'Added')).toHaveText('3')
  // A card export states no balance, so this Import has nothing to check and says nothing about one.
  await expect(page.getByText('Balance not checked')).toHaveCount(0)
  await expect(page.getByText('Balance matches the bank')).toHaveCount(0)

  // A day's two identical purchases are both there, and the card each was spent on is kept.
  await page.getByRole('link', { name: 'See the transactions' }).click()
  await expect(page.getByRole('row').filter({ hasText: name }).filter({ hasText: 'EXAMPLE CAFE TOWN' })).toHaveCount(2)
})

test('importing the same card file again adds nothing twice', async ({ page, context }, testInfo) => {
  const name = cardName(testInfo)
  await signInAs(context, 'admin')
  await page.goto('/import')
  await chooseFile(page, cardFile(['2026-09-02,EXAMPLE CAFE TOWN,9999,-4.50', '2026-09-02,EXAMPLE CAFE TOWN,9999,-4.50', '2026-09-03,EXAMPLE HARDWARE,9999,-129.95']))
  await page.getByLabel('Which Account is this file for?').selectOption({ label: name })
  await page.getByRole('button', { name: 'Import 3 transactions' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(summaryValue(page, 'Added')).toHaveText('0')
  await expect(summaryValue(page, 'Already held (skipped)')).toHaveText('3')
})

test('a Member can neither add an Account nor see the form', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/accounts')

  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Add a Credit Card Account' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add the Account' })).toHaveCount(0)
  // The page's only text to read once is about adding one, so a Member has no "?" either.
  await expect(page.getByRole('button', { name: 'About this page' })).toHaveCount(0)
})
