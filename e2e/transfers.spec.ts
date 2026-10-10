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
  everyday: { number: project === 'dark' ? '99-9999-9999999-42' : '99-9999-9999999-40', name: `Household everyday ${project}` },
  savings: { number: project === 'dark' ? '99-9999-9999999-43' : '99-9999-9999999-41', name: `Household savings ${project}` },
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

  // Its details explain, and lead to the matching Transaction.
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

test('the Transfers filter shows all, only Transfers, or everything but them, and the search is in the address', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: `TFR TO SAVINGS ${stamp}`, amountCents: -7324 }, { description: `PAYMENT TO A FRIEND ${stamp}`, amountCents: -2114 }] },
    { account: savings, rows: [{ description: `TFR FROM EVERYDAY ${stamp}`, amountCents: 7324 }] },
  ])
  await signInAs(context, 'member')
  await page.goto(`/transactions?q=${stamp}`)
  await expect(dataRows(page)).toHaveCount(3)
  const transfers = page.getByLabel('Transfers', { exact: true })
  await expect(transfers).toHaveValue('')

  await transfers.selectOption({ label: 'Only Transfers' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(2)
  await expect(page).toHaveURL(/transfers=only/)
  await expect(page.getByRole('link', { name: `PAYMENT TO A FRIEND ${stamp}` })).toHaveCount(0)
  await noAxeViolations(page)

  await transfers.selectOption({ label: 'Leave out Transfers' })
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dataRows(page)).toHaveCount(1)
  await expect(page.getByRole('link', { name: `PAYMENT TO A FRIEND ${stamp}` })).toBeVisible()

  // It survives a reload, and Clear filters puts everything back.
  await page.reload()
  await expect(page.getByLabel('Transfers', { exact: true })).toHaveValue('exclude')
  await expect(dataRows(page)).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByLabel('Transfers', { exact: true })).toHaveValue('')
  await expect(page).not.toHaveURL(/transfers=/)
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

  // This half is spending in that Category now; its matching Transaction is still a Transfer.
  await expect(outRow).toContainText('Gifts and donations')
  await expect(outRow).not.toContainText('Transfer')
  await expect(dataRows(page).filter({ hasText: into })).toContainText(`Transfer from ${everyday.name}`)

  // The details of the half that is still a Transfer say the other counts as spending, and the Admin can say Not a Transfer to undo the pairing.
  await page.getByRole('link', { name: into }).click()
  await expect(page.getByText('The matching Transaction counts as spending, because the Admin chose a Category for it.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Not a Transfer' })).toBeVisible()
  await noAxeViolations(page)
})

test('the Admin can say Not a Transfer to a wrong pairing from its details, and undo it', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  const out = `TFR TO SAVINGS ${stamp}`
  const into = `TFR FROM EVERYDAY ${stamp}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: out, amountCents: -7331 }] },
    { account: savings, rows: [{ description: into, amountCents: 7331 }] },
  ])
  await signInAs(context, 'admin')
  await page.goto(`/transactions?q=${stamp}`)
  await page.getByRole('link', { name: out }).click()
  await expect(page.getByText(`Money moved to ${savings.name}. It is not counted as spending.`)).toBeVisible()

  // Two questions can be open at once, the Edit panel's and the page's, and no id is used twice.
  await page.getByRole('button', { name: 'Edit Category and Note' }).click()
  await page.getByRole('button', { name: 'Not a Transfer', exact: true }).first().click()
  await page.getByRole('button', { name: 'Not a Transfer', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Mark as Not a Transfer?' })).toHaveCount(2)
  const repeated = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id)
    return ids.filter((id, index) => ids.indexOf(id) !== index)
  })
  expect(repeated).toEqual([])
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // It asks first, naming the matching Transaction, and keeping the Transfer changes nothing.
  await expect(page.getByRole('group', { name: 'Mark as Not a Transfer?' })).toContainText(`its matching Transaction in ${savings.name} will both stop being a Transfer`)
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Keep as a Transfer' }).click()
  await expect(page.getByRole('button', { name: 'Not a Transfer' })).toBeFocused()
  await expect(page.getByText(`Money moved to ${savings.name}.`)).toBeVisible()

  // Saying yes marks both halves, and says so.
  await page.getByRole('button', { name: 'Not a Transfer', exact: true }).click()
  await page.getByRole('button', { name: 'Yes, mark Not a Transfer' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Marked Not a Transfer.' })).toBeFocused()
  await expect(page.getByText('The Admin marked this Not a Transfer, so it counts as spending and is not paired with another Transaction.')).toBeVisible()
  await expect(page.getByText('None, as this is a Transfer')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'See the matching Transaction' })).toHaveCount(0)
  await noAxeViolations(page)
  await page.goto(`/transactions?q=${stamp}`)
  await expect(dataRows(page)).toHaveCount(2)
  await expect(dataRows(page).filter({ hasText: out })).toContainText('Uncategorised')
  await expect(dataRows(page).filter({ hasText: into })).toContainText('Uncategorised')
  await expect(dataRows(page).filter({ hasText: 'Transfer' })).toHaveCount(0)

  // A Member sees that it was marked, with no control to undo it.
  await signInAs(context, 'member')
  await page.reload()
  await page.getByRole('link', { name: into }).click()
  await expect(page.getByText('The Admin marked this Not a Transfer')).toBeVisible()
  await expect(page.getByRole('button', { name: /Transfer/ })).toHaveCount(0)

  // The Admin can undo it from either half, and they are paired again.
  await signInAs(context, 'admin')
  await page.reload()
  await page.getByRole('button', { name: 'Undo: treat as a Transfer again' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Treated as a Transfer again. It is paired with its matching Transaction.' })).toBeFocused()
  await expect(page.getByText(`Money moved from ${everyday.name}. It is not counted as spending.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Not a Transfer' })).toBeVisible()
  await noAxeViolations(page)
  await page.goto(`/transactions?q=${stamp}`)
  await expect(dataRows(page).filter({ hasText: out })).toContainText(`Transfer to ${savings.name}`)
  await expect(dataRows(page).filter({ hasText: into })).toContainText(`Transfer from ${everyday.name}`)
})

test('the Admin can say Not a Transfer from the edit panel, and is told what an unsaved change costs', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  const out = `TFR TO SAVINGS ${stamp}`
  const into = `TFR FROM EVERYDAY ${stamp}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: out, amountCents: -7332 }] },
    { account: savings, rows: [{ description: into, amountCents: 7332 }] },
  ])
  await signInAs(context, 'admin')
  await page.goto(`/transactions?q=${stamp}`)
  const outRow = dataRows(page).filter({ hasText: out })
  await outRow.getByRole('button', { name: /^Edit Category and Note/ }).click()

  // The panel points to Not a Transfer rather than a Category on each half.
  await expect(page.getByText('If the pairing is wrong, use Not a Transfer instead.')).toBeVisible()
  await page.locator('#edit-note').fill('Typed but not saved')
  await page.getByRole('button', { name: 'Not a Transfer', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Mark as Not a Transfer?' })).toContainText("Changes in this panel that you haven't saved will be lost.")
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Yes, mark Not a Transfer' }).click()

  // The panel closes, the page says so, and neither half is a Transfer. The unsaved Note was not saved.
  await expect(page.getByRole('status').filter({ hasText: 'Marked Not a Transfer.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Edit Category and Note' })).toHaveCount(0)
  await expect(outRow).toContainText('Uncategorised')
  await expect(dataRows(page).filter({ hasText: into })).toContainText('Uncategorised')
  await expect(outRow).not.toContainText('Typed but not saved')

  // The list knows it is marked, so the panel offers the undo.
  await outRow.getByRole('button', { name: /^Edit Category and Note/ }).click()
  await expect(page.getByText('The Admin marked this Not a Transfer, so it counts as spending')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Not a Transfer', exact: true })).toHaveCount(0)
  await expect(page.getByText("Changes in this panel that you haven't saved will be lost.")).toHaveCount(0)
  // Undo closes the panel too, so it says what an unsaved change costs, as the question for Not a Transfer does.
  await page.locator('#edit-note').fill('Typed but not saved either')
  await expect(page.getByRole('button', { name: 'Undo: treat as a Transfer again' })).toHaveAccessibleDescription("Changes in this panel that you haven't saved will be lost.")
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Undo: treat as a Transfer again' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Treated as a Transfer again. It is paired with its matching Transaction.' })).toBeVisible()
  await expect(outRow).toContainText(`Transfer to ${savings.name}`)
  await expect(dataRows(page).filter({ hasText: into })).toContainText(`Transfer from ${everyday.name}`)
})

test('Not a Transfer comes back with its Transaction when the history is replaced, so the wrong pair does not return', async ({ page, context, baseURL }, testInfo) => {
  // Accounts of its own: replacing imported history removes every imported Transaction the Account has.
  const dark = testInfo.project.name === 'dark'
  const everyday = { number: `99-9999-9999999-${dark ? '52' : '50'}`, name: `Carry everyday ${testInfo.project.name}` }
  const savingsNumber = `9999999-${dark ? '53' : '51'}`
  const savingsName = `Carry savings ${testInfo.project.name}`
  const stamp = `${testInfo.project.name}${Date.now()}`
  const out = `TFR TO SAVINGS ${stamp}`
  const into = `TFR FROM EVERYDAY ${stamp}`
  const file = [
    'Created date / time : 2 October 2026 / 18:55:26',
    `Bank 99; Branch 9999; Account ${savingsNumber} (Example)`,
    'From date 20110601',
    'To date 20110630',
    'Avail Bal : 10.00 as of 20260930',
    'Ledger Balance : 10.00 as of 20261002',
    'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
    '',
    `2011/06/15,201106150001,TFR,,"${into}","TFR",73.40`,
  ].join('\n')
  const chooseFile = () => page.getByLabel('Bank export file').setInputFiles({ name: 'savings.csv', mimeType: 'text/csv', buffer: Buffer.from(file) })

  // The Savings side is imported from a bank file, as a replace needs, and pairs with the Everyday side when it arrives.
  await seed(context, baseURL!, [{ account: everyday, rows: [{ description: out, amountCents: -7340 }] }])
  await page.goto('/import')
  await chooseFile()
  await page.getByLabel('Account name').fill(savingsName)
  await page.getByRole('button', { name: /^Import 1 transactions?$/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  const listed = async () => ((await (await context.request.get(`/api/transactions?text=${stamp}&limit=200`)).json()) as { transactions: { id: number; description: string; transfer: string | null }[] }).transactions
  expect((await listed()).map((t) => t.transfer)).toEqual(['pair', 'pair'])

  // The Admin says it is wrong.
  const wrong = (await listed()).find((t) => t.description === out)!
  const marked = await context.request.post(`/api/transactions/${wrong.id}/not-transfer`, { headers: { Origin: baseURL! }, data: {} })
  expect(marked.ok()).toBe(true)

  // Replacing the Savings history with the same file counts the mark with the Overrides and Notes, and carries it.
  await page.goto('/import')
  await chooseFile()
  await page.getByRole('button', { name: 'Replace imported history…' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('1 Transaction has an Override (your own Category), a Note or a Not a Transfer mark. It carries over to this file.')
  await page.getByRole('button', { name: 'Yes, replace imported history' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(page.getByText('Transactions that kept their Override, Note or Not a Transfer mark', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('1')
  await expect(page.getByText('Transfers matched with other Accounts')).toHaveCount(0)

  // The Transaction that came back is marked, and the pair did not form again.
  expect((await listed()).map((t) => t.transfer)).toEqual([null, null])
  await page.goto(`/transactions?q=${stamp}`)
  await page.getByRole('link', { name: into }).click()
  await expect(page.getByText('The Admin marked this Not a Transfer, so it counts as spending')).toBeVisible()

  // Undoing it from the Transaction that came back clears the half that stayed too.
  await page.getByRole('button', { name: 'Undo: treat as a Transfer again' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Treated as a Transfer again. It is paired with its matching Transaction.' })).toBeVisible()
  expect((await listed()).map((t) => t.transfer)).toEqual(['pair', 'pair'])
})

test('the Import screen says how many Transfers it matched with other Accounts', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: `TFR TO SAVINGS ${stamp}`, amountCents: -7323 }] },
    { account: savings, rows: [{ description: `SEEDED ${stamp}`, amountCents: 100 }] },
  ])
  const csv = [
    'Created date / time : 2 October 2026 / 18:55:26',
    `Bank 99; Branch 9999; Account 9999999-${savings.number.slice(-2)} (Example)`,
    'From date 20110601',
    'To date 20110630',
    'Avail Bal : 10.00 as of 20260930',
    'Ledger Balance : 10.00 as of 20261002',
    'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
    '',
    `2011/06/15,201106150001,TFR,,"TFR FROM EVERYDAY ${stamp}","TFR",73.23`,
  ].join('\n')
  await page.goto('/import')
  await page.getByLabel('Bank export file').setInputFiles({ name: 'savings.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })

  await page.getByRole('button', { name: /^Import 1 transactions?$/ }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible()
  await expect(page.getByText('Transfers matched with other Accounts').locator('xpath=following-sibling::dd[1]')).toHaveText('1')
  await noAxeViolations(page)
})

test('the Report names a Transfer instead of a Category, and the CSV link carries the Transfers filter', async ({ page, context, baseURL }, testInfo) => {
  const { everyday, savings } = accountsFor(testInfo.project.name)
  const stamp = `${testInfo.project.name}${Date.now()}`
  const out = `TFR TO SAVINGS ${stamp}`
  const friend = `PAYMENT TO A FRIEND ${stamp}`
  await seed(context, baseURL!, [
    { account: everyday, rows: [{ description: out, amountCents: -7326 }, { description: friend, amountCents: -2116 }] },
    { account: savings, rows: [{ description: `TFR FROM EVERYDAY ${stamp}`, amountCents: 7326 }] },
  ])
  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  const everydayId = accounts.find((a) => a.name === everyday.name)!.id
  await signInAs(context, 'member')

  await page.goto(`/reports/transactions?account=${everydayId}&from=2011-01-01&to=2011-12-31`)
  const listing = page.getByRole('article', { name: 'Transaction listing' })
  await expect(listing.getByRole('row').filter({ hasText: out })).toContainText('Transfer')
  await expect(listing.getByRole('row').filter({ hasText: out })).not.toContainText('Uncategorised')
  await expect(listing.getByRole('row').filter({ hasText: friend })).toContainText('Uncategorised')

  await page.goto(`/transactions?q=${stamp}&transfers=exclude`)
  await expect(dataRows(page)).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', /transfers=exclude/)
})
