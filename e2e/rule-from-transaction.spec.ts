import type { BrowserContext, Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { dateText } from './report-helpers'
import { categoryId, removeRule } from './rule-helpers'
import { rowButton } from './row-actions-helpers'

// Create Rule, in a Transaction's Edit panel: the Admin makes a Rule from an Uncategorised Transaction and gives its Category to the others like it, in one press (README, Rules). The Worker's
// answers are held by worker/rule-from-transaction.test.ts, and the suggested text by src/lib/rule-text.test.ts; this is the page: the panel, the live count, the line it says, and where focus goes.
//
// The light and dark projects share one local database, so each has an Account of its own (26 and 27) and a year of its own (2006 and 2007, which no other spec uses), and a stamp of letters in
// the words it looks for: no earlier run has them, and a stamp in digits would be taken for a receipt number and left out of the suggestion. The Transactions are the biggest money out there is, so
// the Uncategorised list, newest amount first (?sort=amount), has them at the top whatever other specs left in it.
const account = (project: string) => `99-9999-9999999-${project === 'dark' ? '27' : '26'}`
const year = (project: string) => (project === 'dark' ? '2007' : '2006')
const letters = (n: number) => [...String(n)].map((digit) => 'ABCDEFGHIJ'[Number(digit)]).join('')

type Seed = { date: string; description: string; amountCents: number }

async function importRows(context: BrowserContext, baseURL: string, project: string, rows: Seed[]) {
  const res = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL },
    data: {
      account: { number: account(project) },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: `${year(project)}-10-01`, to: `${year(project)}-10-31`, ledgerBalance: { cents: 0, date: `${year(project)}-10-31` } },
      rows: rows.map((row, i) => ({ date: row.date, uniqueId: `RFT${letters(Date.now())}${i}`, tranType: 'EFTPOS', chequeNumber: null, payee: row.description, bankMemo: 'EFTPOS', amountCents: row.amountCents })),
    },
  })
  expect(res.ok()).toBe(true)
}

/** The ID of the Transaction with this description, found by its text. */
async function idOf(context: BrowserContext, text: string, description: string) {
  const { transactions } = (await (await context.request.get(`/api/transactions?text=${encodeURIComponent(text)}&limit=50`)).json()) as { transactions: { id: number; description: string }[] }
  return transactions.find((t) => t.description === description)!.id
}

/** Takes away every Rule that looks for exactly `text`, so that no other spec has it. */
async function removeRulesFor(context: BrowserContext, baseURL: string, text: string) {
  const rules = (await (await context.request.get('/api/rules')).json()) as { id: number; textContains: string | null }[]
  for (const rule of rules.filter((r) => r.textContains === text)) await removeRule(context, baseURL, rule.id)
}

const editButton = (page: Page, description: string, date: string) => rowButton(page, 'Edit', `${description}, ${dateText(date)}`)
const panelOf = (page: Page, description: string, date: string) => page.getByRole('region', { name: `Edit Category and Note, ${description}, ${dateText(date)}` })
const textBox = (page: Page) => page.getByLabel('Text contains', { exact: true })

/** The requests the page makes to count what the text matches, with what each asked. */
const watchCounts = (page: Page) => {
  const asked: { textContains: string; direction: string | null }[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/rules/preview')) asked.push(request.postDataJSON())
  })
  return asked
}

test.describe.configure({ mode: 'serial' })

test('the Admin makes a Rule from an Uncategorised Transaction: the text is suggested, the count follows what they type, and saving gives the Category to the others', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const project = testInfo.project.name
  const word = `COUNTDOWN${letters(Date.now())}`
  const date = (day: string) => `${year(project)}-10-${day}`
  const rows = {
    here: { date: date('12'), description: `EFTPOS 1234 ${word} AUCKLAND 12/10`, amountCents: -8_765_432 },
    other: { date: date('11'), description: `POS W/D 12OCT ${word} ALBANY 4521`, amountCents: -8_765_431 },
    card: { date: date('10'), description: `VISA PURCHASE 4835-12XX-XXXX-1234 ${word} NEWMARKET`, amountCents: -8_765_430 },
    chosen: { date: date('09'), description: `${word} PETROL STATION`, amountCents: -8_765_429 }, // the Admin has chosen its Category already
    refund: { date: date('08'), description: `${word} REFUND`, amountCents: 5_000 }, // money in
    unrelated: { date: date('07'), description: `EFTPOS 5678 OTHERSHOP${letters(Date.now())} MANUKAU`, amountCents: -8_765_428 },
  }
  await importRows(context, baseURL!, project, Object.values(rows))
  const fuel = await categoryId(context, 'Fuel')
  const chosenId = await idOf(context, word, rows.chosen.description)
  expect((await context.request.put(`/api/transactions/${chosenId}/override`, { headers: { Origin: baseURL! }, data: { categoryId: fuel } })).ok()).toBe(true)

  try {
    const asked = watchCounts(page)
    await page.goto('/uncategorised?sort=amount')
    await editButton(page, rows.here.description, rows.here.date).click()
    const panel = panelOf(page, rows.here.description, rows.here.date)
    await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(panel.getByLabel('Text contains', { exact: true })).toHaveCount(0) // the Rule's fields are not there until they are asked for

    // Create Rule opens the Rule's fields below the Category, with focus in the text: the words that name the shop, without the how, the card, the date and the place.
    await panel.getByRole('button', { name: 'Create Rule' }).click()
    await expect(textBox(page)).toBeFocused()
    await expect(textBox(page)).toHaveValue(word)
    await expect(panel.getByLabel('Money in or out')).toHaveValue('out')
    await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Create Rule' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Cancel Rule' })).toBeVisible()
    // The Rule needs a Category, and says so.
    await expect(panel.getByRole('button', { name: 'Save Category and Rule' })).toBeDisabled()
    await expect(panel.getByText('Choose a Category above to save it with a Rule.')).toBeVisible()
    // Below the Category, above the Note.
    const order = await panel.locator('label[for="edit-category"], label[for="edit-rule-text"], label[for="edit-note"]').evaluateAll((labels) => labels.map((label) => label.getAttribute('for')))
    expect(order).toEqual(['edit-category', 'edit-rule-text', 'edit-note'])

    // The count is read as the Admin stops typing, and the line is a polite status.
    const count = panel.getByRole('status')
    await expect(count).toHaveAttribute('aria-live', 'polite')
    await expect(count).toContainText('4 Transactions match, 3 of them uncategorised.') // this one and the two like it, and the one that has its Category already
    expect(asked).toEqual([{ textContains: word, direction: 'out', uncategorised: true }])
    await panel.getByLabel('Money in or out').selectOption({ label: 'Either' })
    await expect(count).toContainText('5 Transactions match, 4 of them uncategorised.') // and the refund
    await panel.getByLabel('Money in or out').selectOption({ label: 'Money out only' })
    await expect(count).toContainText('4 Transactions match, 3 of them uncategorised.')
    const before = asked.length
    await textBox(page).press('End')
    await textBox(page).pressSequentially('ZZZ', { delay: 100 }) // three keys, each within the pause of the one before, ask once and not three times
    await expect(count).toContainText('No Transactions match.')
    expect(asked).toHaveLength(before + 1)
    expect(asked.at(-1)).toMatchObject({ textContains: `${word}ZZZ` })
    await textBox(page).fill(word)
    await expect(count).toContainText('4 Transactions match, 3 of them uncategorised.')
    expect(asked).toHaveLength(before + 2)

    await panel.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
    await expect(panel.getByText('Choose a Category above to save it with a Rule.')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Save Category and Rule' })).toBeEnabled()
    await noAxeViolations(page)

    // One press saves the Rule, gives the others the Category, and says what it did where the Transaction was, with focus there: the three leave the list.
    await panel.getByRole('button', { name: 'Save Category and Rule' }).click()
    const saved = page.getByRole('status').filter({ hasText: /^Saved Rule \d+ \(/ })
    await expect(saved).toHaveText(new RegExp(`^Saved Rule \\d+ \\(Text contains “${word}” and money out\\) and gave 3 Transactions the Category Groceries, this one included\\.$`))
    await expect(saved).toBeFocused()
    for (const row of [rows.here, rows.other, rows.card]) await expect(editButton(page, row.description, row.date)).toHaveCount(0)
    await expect(editButton(page, rows.unrelated.description, rows.unrelated.date)).toBeVisible()
    await noAxeViolations(page)

    // The Rule is the last of the Rules, as Add a Rule makes it.
    await page.goto('/rules')
    const lastRule = page.getByRole('row').last()
    await expect(lastRule).toContainText(`Text contains “${word}” and money out`)
    await expect(lastRule).toContainText('Category: Groceries')

    // Three have the Category from the Rule; the one the Admin had set is as they set it; the refund has none.
    await page.goto(`/transactions?q=${word}`)
    const row = (description: string) => page.getByRole('row', { name: new RegExp(description.replaceAll('/', '\\/')) })
    for (const { description } of [rows.here, rows.other, rows.card]) {
      await expect(row(description)).toContainText('Groceries')
      await expect(row(description)).toContainText('Rule')
    }
    await expect(row(rows.chosen.description)).toContainText('Fuel')
    await expect(row(rows.chosen.description)).toContainText('Override')
    await expect(row(rows.refund.description)).toContainText('Uncategorised')

    await page.goto('/change-log')
    await expect(page.getByRole('listitem').filter({ hasText: `Added a Rule: text contains "${word}" and money out, category Groceries` })).toHaveCount(1)
    await expect(page.getByRole('listitem').filter({ hasText: 'Gave 3 Transactions the Category Groceries with the new Rule' }).first()).toBeVisible()
  } finally {
    await removeRulesFor(context, baseURL!, word)
  }
})

test('Create Rule suggests the whole description when nothing of a shop is left, Cancel Rule goes back, and a text that does not match this Transaction gives it its Category as an Override', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const project = testInfo.project.name
  const stamp = Date.now()
  const shop = `BAKERY${letters(stamp)}`
  const rows = {
    noise: { date: `${year(project)}-10-20`, description: `POS W/D ${stamp}`, amountCents: -8_654_321 }, // how it was paid, and a number: nothing of a shop
    shop: { date: `${year(project)}-10-19`, description: `EFTPOS 4821 ${shop} PONSONBY 05/10`, amountCents: -8_654_320 },
  }
  await importRows(context, baseURL!, project, Object.values(rows))

  try {
    await page.goto('/uncategorised?sort=amount')
    await editButton(page, rows.noise.description, rows.noise.date).click()
    const panel = panelOf(page, rows.noise.description, rows.noise.date)
    await panel.getByRole('button', { name: 'Create Rule' }).click()
    await expect(textBox(page)).toHaveValue(rows.noise.description) // never empty: the whole description

    // Cancel Rule closes the fields and puts back Save, Create Rule and Cancel, with focus on Create Rule, which is where the Admin was.
    await panel.getByRole('button', { name: 'Cancel Rule' }).click()
    await expect(textBox(page)).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Create Rule' })).toBeFocused()
    await expect(panel.getByRole('button', { name: 'Save Category and Rule' })).toHaveCount(0)

    // A text that does not match this Transaction: the Rule is made for the others, and this one is given the Category as Save would give it, and the line says so.
    await panel.getByRole('button', { name: 'Create Rule' }).click()
    await expect(textBox(page)).toHaveValue(rows.noise.description)
    await textBox(page).fill(shop)
    await panel.getByLabel('Category', { exact: true }).selectOption({ label: 'Eating out' })
    await expect(panel.getByRole('status')).toContainText('1 Transaction matches, and it is uncategorised.')
    await panel.getByRole('button', { name: 'Save Category and Rule' }).click()
    const saved = page.getByRole('status').filter({ hasText: /^Saved Rule \d+ \(/ })
    await expect(saved).toHaveText(
      new RegExp(`^Saved Rule \\d+ \\(Text contains “${shop}” and money out\\) and gave 1 Transaction the Category Eating out\\. This Transaction does not match the text, so its Category is an Override on it instead\\.$`),
    )
    await expect(saved).toBeFocused()

    await page.goto(`/transactions?q=${stamp}`)
    await expect(page.getByRole('row', { name: new RegExp(rows.noise.description) })).toContainText('Override')
    await page.goto(`/transactions?q=${shop}`)
    await expect(page.getByRole('row', { name: new RegExp(shop) })).toContainText('Eating out')
    await expect(page.getByRole('row', { name: new RegExp(shop) })).toContainText('Rule')
  } finally {
    await removeRulesFor(context, baseURL!, shop)
  }
})

// The next two stub the Worker's answers, so how many match, and what the Rule gave, is known.
const stubRow = (id: number, description: string) => ({
  id,
  accountId: 1,
  accountName: 'Example savings',
  date: '2026-10-08',
  description,
  bankType: 'EFTPOS',
  amountCents: -2345,
  categoryId: null,
  categoryName: null,
  categorySource: null,
  note: null,
  transfer: null,
  transferAccountName: null,
  canMarkNotTransfer: false,
  notTransfer: false,
})
const stubList = (page: Page, rows: ReturnType<typeof stubRow>[]) =>
  page.route(/\/api\/transactions\?/, (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get('count') === 'only' ? { total: rows.length, transactions: [] } : { total: null, transactions: rows } }))

test('what is typed in the Rule fields is kept when another Transaction\'s panel is opened, and Cancel Rule throws it away', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const rows = [stubRow(4241, 'EFTPOS 1234 EXAMPLE STUBONE AUCKLAND 12/10'), stubRow(4242, 'EFTPOS 5678 EXAMPLE STUBTWO WELLINGTON 12/10')]
  await stubList(page, rows)
  await page.route('**/api/rules/preview', (route) => route.fulfill({ json: { matches: 3, samples: [], uncategorised: 2 } }))
  await page.goto('/transactions')
  const edit = (row: (typeof rows)[number]) => rowButton(page, 'Edit', `${row.description}, ${dateText(row.date)}`)

  await edit(rows[0]!).click()
  const panel = page.getByRole('region', { name: /^Edit Category and Note/ })
  await panel.getByRole('button', { name: 'Create Rule' }).click()
  await expect(textBox(page)).toHaveValue('EXAMPLE STUBONE')
  await textBox(page).fill('MY OWN WORDS')
  await panel.getByLabel('Money in or out').selectOption({ label: 'Either' })

  await edit(rows[1]!).click()
  await expect(panel).toHaveAccessibleName(/STUBTWO/)
  await expect(textBox(page)).toHaveCount(0) // another Transaction's panel starts as every panel does
  await edit(rows[0]!).click()
  await expect(panel).toHaveAccessibleName(/STUBONE/)
  await expect(textBox(page)).toHaveValue('MY OWN WORDS')
  await expect(panel.getByLabel('Money in or out')).toHaveValue('')

  // Cancel Rule is a choice not to make the Rule: next time the text starts again as the suggestion.
  await panel.getByRole('button', { name: 'Cancel Rule' }).click()
  await panel.getByRole('button', { name: 'Create Rule' }).click()
  await expect(textBox(page)).toHaveValue('EXAMPLE STUBONE')
  await expect(panel.getByLabel('Money in or out')).toHaveValue('out')
})

test('with more Uncategorised Transactions than can be given the Category at once, the count says so before saving and the line says how many were left', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const groceries = await categoryId(context, 'Groceries')
  const row = stubRow(4241, 'EFTPOS 1234 EXAMPLE STUBSHOP AUCKLAND 12/10')
  await stubList(page, [row])
  await page.route('**/api/rules/preview', (route) => route.fulfill({ json: { matches: 912, samples: [], uncategorised: 887 } }))
  let sent: unknown = null
  await page.route('**/api/rules/from-transaction', (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill({ status: 201, json: { id: 41, number: 7, categorised: 1, thisBy: 'rule', overrideBecause: null, moreUncategorised: 886 } })
  })

  await page.goto('/transactions')
  await rowButton(page, 'Edit', `${row.description}, ${dateText(row.date)}`).click()
  const panel = page.getByRole('region', { name: /^Edit Category and Note/ })
  await panel.getByRole('button', { name: 'Create Rule' }).click()
  await expect(textBox(page)).toHaveValue('EXAMPLE STUBSHOP')
  await expect(panel.getByRole('status')).toContainText('912 Transactions match, 887 of them uncategorised.')
  await expect(panel.getByRole('status')).toContainText('That is more than 500, too many to give a Category at once.')
  await expect(panel.getByRole('status')).toContainText('Apply the Rules to all Transactions, on the Rules page')

  await panel.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
  await panel.getByRole('button', { name: 'Save Category and Rule' }).click()
  await expect(page.getByText(/^Saved Rule 7 \(/).first()).toHaveText(
    'Saved Rule 7 (Text contains “EXAMPLE STUBSHOP” and money out) and gave this Transaction the Category Groceries. 886 more Uncategorised Transactions match: that is too many to give the Category at once. Choose Apply the Rules to all Transactions, on the Rules page, to give them theirs.',
  )
  expect(sent).toEqual({ transactionId: 4241, textContains: 'EXAMPLE STUBSHOP', direction: 'out', categoryId: groceries })
})
