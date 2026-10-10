import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

// The light and dark projects share one local database, so each has Accounts of its own, and the Transactions are dated
// in 2011 and use amounts no other spec does, so nothing from another spec can pair with them (Transfers pair on date and amount).
const accountsFor = (project: string) => ({
  everyday: { number: project === 'dark' ? '99-9999-9999999-62' : '99-9999-9999999-60', name: `Household everyday ${project}` },
  savings: { number: project === 'dark' ? '99-9999-9999999-63' : '99-9999-9999999-61', name: `Household savings ${project}` },
})

type Seed = { account: { number: string; name: string }; rows: { description: string; amountCents: number }[] }

async function seed(context: BrowserContext, baseURL: string, batches: Seed[]) {
  await signInAs(context, 'admin')
  for (const { account, rows } of batches) {
    const res = await context.request.post('/api/imports/chunks', {
      headers: { Origin: baseURL },
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2011-06-01', to: '2011-06-30', ledgerBalance: { cents: 0, date: '2011-06-30' } },
        rows: rows.map((r, i) => ({ date: '2011-06-15', uniqueId: `${r.description.replaceAll(' ', '')}${i}`, tranType: 'TFR', chequeNumber: null, payee: r.description, bankMemo: '', amountCents: r.amountCents })),
      },
    })
    expect(res.ok()).toBe(true)
  }
}

const dataRows = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('cell') })

test('a Transfer between two Accounts is named as one, in the list and in its details, and a payment to someone else is not', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  const out = `TFR TO SAVINGS ${stamp}`
  const into = `TFR FROM EVERYDAY ${stamp}`
  const friend = `PAYMENT TO A FRIEND ${stamp}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: out, amountCents: -7319 }, { description: friend, amountCents: -2111 }] },
    { account: savings, rows: [{ description: into, amountCents: 7319 }] },
  ])
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}`)
  await expect(dataRows(page)).toHaveCount(3)

  // The list says where the money went and where it came from; the friend's payment is spending, so it has no Transfer.
  await expect(dataRows(page).filter({ hasText: out })).toContainText(`Transfer to ${savings.name}`)
  await expect(dataRows(page).filter({ hasText: into })).toContainText(`Transfer from ${everyday.name}`)
  await expect(dataRows(page).filter({ hasText: friend })).toContainText('Uncategorised')
  await expect(dataRows(page).filter({ hasText: friend })).not.toContainText('Transfer')
  await noAxeViolations(page)

  // Its details explain, and lead to the other half.
  await page.getByRole('link', { name: out }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Transaction' })).toBeVisible()
  await expect(page.getByText(`Money moved to ${savings.name}. It is not counted as spending.`)).toBeVisible()
  await noAxeViolations(page)
  await page.getByRole('link', { name: 'See the matching Transaction' }).click()
  await expect(page.getByText(`Money moved from ${everyday.name}. It is not counted as spending.`)).toBeVisible()
  await expect(page.getByText(into).first()).toBeVisible()

  // A payment to someone else's account has nothing to say about Transfers.
  await page.goto(`/transactions?q=${stamp}`)
  await page.getByRole('link', { name: friend }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Transaction' })).toBeVisible()
  await expect(page.getByText('It is not counted as spending.')).toHaveCount(0)
})

test('Transfers are not Uncategorised: filtering by Uncategorised leaves them out', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: `TFR TO SAVINGS ${stamp}`, amountCents: -7320 }, { description: `PAYMENT TO A FRIEND ${stamp}`, amountCents: -2112 }] },
    { account: savings, rows: [{ description: `TFR FROM EVERYDAY ${stamp}`, amountCents: 7320 }] },
  ])
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}&category=uncategorised`)

  await expect(dataRows(page)).toHaveCount(1)
  await expect(page.getByRole('link', { name: `PAYMENT TO A FRIEND ${stamp}` })).toBeVisible()
})

test('the Admin can count one half of a Transfer as spending by choosing a Category for it', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  const out = `TFR TO SAVINGS ${stamp}`
  const into = `TFR FROM EVERYDAY ${stamp}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: out, amountCents: -7321 }] },
    { account: savings, rows: [{ description: into, amountCents: 7321 }] },
  ])
  await signInAs(context, 'admin')
  await page.goto(`/transactions?q=${stamp}`)
  const outRow = dataRows(page).filter({ hasText: out })
  await expect(outRow).toContainText(`Transfer to ${savings.name}`)

  await outRow.getByRole('button', { name: /^Edit Category and Note/ }).click()
  await expect(page.getByText('This Transaction is a Transfer, so choosing a Category also makes it count as spending.')).toBeVisible()
  await noAxeViolations(page)
  await page.locator('#edit-category').selectOption({ label: 'Gifts and donations' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // This half is spending in that Category now; the other half is still a Transfer.
  await expect(outRow).toContainText('Gifts and donations')
  await expect(outRow).not.toContainText('Transfer')
  await expect(dataRows(page).filter({ hasText: into })).toContainText(`Transfer from ${everyday.name}`)
})
