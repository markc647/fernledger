import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

const noAxeViolations = async (page: Page) => {
  // A button that has just been enabled is still fading in, and axe reads the colour it has at that moment, which is not its colour:
  // a transition runs in real time (the page's fake clock does not move it), and waiting for running ones misses one React has yet to
  // start. Reduced motion (src/index.css) makes every transition near-instant, so none can be mid-fade when axe looks.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  // Which element, not only how many, because a CI run keeps no trace to look at afterwards.
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
}

// The light and dark projects share one local database, so each test uses text and an Account of its own, no earlier run used
// and no other spec uses: the Summary spec has 86 and 87, Categories 88 and 89, the Change Log 90 and 91, Cutover 92 and 93
// (a Cutover Date drops rows dated after it), Import 94 to 97.
const accountFor = (projectName: string) => (projectName === 'dark' ? '99-9999-9999999-84' : '99-9999-9999999-85')

async function importTransaction(context: BrowserContext, baseURL: string, projectName: string, description: string, uniqueId: string) {
  const res = await context.request.post('/api/imports/chunks', {
    headers: { Origin: baseURL },
    data: {
      account: { number: accountFor(projectName) },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-09', to: '2026-10-09', ledgerBalance: { cents: 0, date: '2026-10-09' } },
      rows: [{ date: '2026-10-09', uniqueId, tranType: 'EFTPOS', chequeNumber: null, payee: description, bankMemo: 'EFTPOS', amountCents: -4321 }],
    },
  })
  expect(res.ok()).toBe(true)
}

async function categoryId(context: BrowserContext, name: string) {
  const categories = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  return categories.find((c) => c.name === name)!.id
}

async function addRule(context: BrowserContext, baseURL: string, body: Record<string, unknown>) {
  const res = await context.request.post('/api/rules', { headers: { Origin: baseURL }, data: body })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { id: number }).id
}

const removeRule = async (context: BrowserContext, baseURL: string, id: number) =>
  expect((await context.request.delete(`/api/rules/${id}`, { headers: { Origin: baseURL }, data: {} })).ok()).toBe(true)

const ruleIds = async (context: BrowserContext) => ((await (await context.request.get('/api/rules')).json()) as { id: number }[]).map((r) => r.id)

const rowFor = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(text) })

test.describe.configure({ mode: 'serial' })

test('the Admin checks how many Transactions a Rule matches, saves it, and new Transactions are put in its Category', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const shop = `EXAMPLE RULESHOP ${stamp}`
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} OLD`, `RA${stamp}`)

  await page.goto('/rules')
  await expect(page.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible()
  await expect(page.getByText('The Transactions you already have change only when you choose Apply the Rules to all Transactions')).toBeVisible()
  await page.getByRole('button', { name: 'Add a Rule' }).click()
  await expect(page.getByLabel('Text contains')).toBeFocused()

  // The Rule can't be saved before the Admin has seen what it matches.
  await page.getByLabel('Text contains').fill(shop.toLowerCase())
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
  await page.getByRole('button', { name: 'Check how many match' }).click()
  const result = page.getByRole('status').filter({ hasText: 'you already have' })
  await expect(result).toContainText('1 Transaction you already have matches.')
  await expect(result).toContainText("Saving the Rule won't change it")
  await expect(result).toContainText(`${shop} OLD`)
  await expect(result).toContainText('type EFTPOS') // the bank's type, which a Rule can match on and the Transactions list does not show

  // Changing what it looks for takes the result away, and the Rule has to be checked again.
  await page.getByLabel('Text contains').fill(`${shop} OLD`)
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
  await expect(page.getByText('You have changed what the Rule looks for')).toBeVisible()
  await page.getByLabel('Text contains').fill(shop.toLowerCase())
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(result).toContainText('1 Transaction you already have matches.')

  await page.getByLabel('What the Rule does').selectOption({ label: 'Put in the Category Groceries' })
  await noAxeViolations(page)
  await page.getByRole('button', { name: 'Save Rule' }).click()

  const saved = page.getByRole('status').filter({ hasText: 'Added the Rule.' })
  await expect(saved).toContainText('used for new Transactions as they are imported')
  await expect(saved).toContainText('To use the change on the Transactions you already have, choose Apply the Rules to all Transactions')
  await expect(page.getByRole('button', { name: 'Add a Rule' })).toBeFocused()
  const row = rowFor(page, shop.toLowerCase())
  await expect(row).toContainText(`Text contains “${shop.toLowerCase()}”`)
  await expect(row).toContainText('Category: Groceries')
  await noAxeViolations(page)

  // A Transaction imported now is put in Groceries by the Rule; the one on file from before is not.
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} NEW`, `RB${stamp}`)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transactions' }).click()
  const added = rowFor(page, `${shop} NEW`)
  await expect(added).toContainText('Groceries')
  await expect(added).toContainText('Rule')
  await expect(rowFor(page, `${shop} OLD`)).toContainText('Uncategorised')

  await page.goto('/change-log')
  await expect(page.getByRole('listitem').filter({ hasText: 'Added a Rule: text contains' }).filter({ hasText: shop.toLowerCase() }).first()).toContainText('Rule change by admin@example.com')

  // Remove it again so that no other test is affected. The Transaction keeps the Category the Rule gave it.
  await page.goto('/rules')
  await page.getByRole('button', { name: /^Remove Rule \d+$/ }).last().click()
  await expect(page.getByRole('group', { name: /^Remove Rule/ })).toContainText('Transactions it already put in a Category keep that Category')
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused()
  await page.getByRole('button', { name: /^Yes, remove Rule/ }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Removed Rule/ })).toBeFocused()
  await expect(page.getByText(shop.toLowerCase())).toHaveCount(0)
})

test('the Admin changes a Rule and moves it in the order with the keyboard', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const fuel = await categoryId(context, 'Fuel')
  const first = await addRule(context, baseURL!, { textContains: `EXAMPLE ONE ${stamp}`, categoryId: fuel })
  const second = await addRule(context, baseURL!, { textContains: `EXAMPLE TWO ${stamp}`, bankType: 'EFTPOS', direction: 'out', minCents: 1000, maxCents: 25000, categoryId: fuel })

  try {
    await page.goto('/rules')
    await expect(rowFor(page, `EXAMPLE TWO ${stamp}`)).toContainText(`Text contains “EXAMPLE TWO ${stamp}” and type is EFTPOS and money out and amount from $10.00 to $250.00`)

    // WCAG 2.5.3: each button's accessible name contains the text it shows, so voice control can say what it sees.
    for (const action of ['up', 'down', 'edit', 'remove']) {
      const button = page.locator(`#rule-${second}-${action}`)
      expect(await button.getAttribute('aria-label')).toContain((await button.innerText()).trim())
    }

    // Move the first Rule down: it lands after the second, so Move down is no longer possible and focus stays on its other button.
    const moveDown = page.locator(`#rule-${first}-down`)
    await moveDown.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: /^Moved Rule \d+ down/ })).toBeVisible()
    await expect(page.locator(`#rule-${first}-up`)).toBeFocused()
    expect((await ruleIds(context)).filter((id) => id === first || id === second)).toEqual([second, first])

    // Edit the second: the amount range changes, and it needs no new check while the text, type and amounts are as they were.
    await page.locator(`#rule-${second}-edit`).click()
    await expect(page.getByLabel('Text contains')).toHaveValue(`EXAMPLE TWO ${stamp}`)
    await expect(page.getByLabel('Amount from ($)')).toHaveValue('10.00')
    await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
    await expect(page.getByText('is a Transfer even if no matching Transaction is found in another Account')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save Rule' })).toBeEnabled()
    await noAxeViolations(page)
    await page.getByRole('button', { name: 'Save Rule' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved the changes to the Rule.' })).toBeVisible()
    await expect(page.locator(`#rule-${second}-edit`)).toBeFocused()
    await expect(rowFor(page, `EXAMPLE TWO ${stamp}`)).toContainText('Mark as a Transfer')
    await noAxeViolations(page)
  } finally {
    await removeRule(context, baseURL!, first)
    await removeRule(context, baseURL!, second)
  }
})

test('boxes changed while a check is out do not take its result, so Save stays off until they are checked', async ({ page, context }) => {
  await signInAs(context, 'admin')
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/rules/preview', async (route) => {
    await held
    await route.fulfill({ json: { matches: 3, samples: [] } })
  })
  await page.goto('/rules')
  await page.getByRole('button', { name: 'Add a Rule' }).click()
  await page.getByLabel('Text contains').fill('first')
  await page.getByLabel('What the Rule does').selectOption({ label: 'Mark as a Transfer' })
  const check = page.getByRole('button', { name: 'Check how many match' })
  await check.click()
  await expect(check).toBeDisabled() // the check is out

  await page.getByLabel('Text contains').fill('second')
  release()

  // The answer was about "first". It is not an answer about "second", so nothing is shown and Save is still off.
  await expect(check).toBeEnabled()
  await expect(page.getByText('You have changed what the Rule looks for')).toBeVisible()
  await expect(page.getByText('3 Transactions you already have match.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save Rule' })).toBeDisabled()
})

test('the Admin is told what is wrong with a box, and taken to it', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/rules')
  await page.getByRole('button', { name: 'Add a Rule' }).click()

  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Fill in at least one of the boxes above' })).toBeVisible()
  await expect(page.getByLabel('Text contains')).toBeFocused()
  await expect(page.getByLabel('Text contains')).toHaveAttribute('aria-invalid', 'true')
  await noAxeViolations(page)

  await page.getByLabel('Text contains').fill('example')
  await page.getByLabel('Amount from ($)').fill('12.345')
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Enter an amount in dollars' })).toBeVisible()
  await expect(page.getByLabel('Amount from ($)')).toBeFocused()

  await page.getByLabel('Amount from ($)').fill('50')
  await page.getByLabel('Amount up to ($)').fill('20')
  await page.getByRole('button', { name: 'Check how many match' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'must not be less than the amount it starts from' })).toBeVisible()
  await expect(page.getByLabel('Amount up to ($)')).toBeFocused()
  await noAxeViolations(page)
})

const rerunButton = (page: Page) => page.getByRole('button', { name: 'Apply the Rules to all Transactions' })

test('the Admin applies a Rule to the Transactions already on file, and one set by hand is left alone', async ({ page, context, baseURL }, testInfo) => {
  await signInAs(context, 'admin')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const shop = `EXAMPLE APPLYSHOP ${stamp}`
  // Two Transactions on file before there is a Rule. The Admin sets the Category of one by hand.
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} PLAIN`, `AP${stamp}`)
  await importTransaction(context, baseURL!, testInfo.project.name, `${shop} HAND`, `AH${stamp}`)
  const list = async (text: string) =>
    ((await (await context.request.get(`/api/transactions?text=${encodeURIComponent(text)}&count=false`)).json()) as { transactions: { id: number; description: string; categoryName: string | null; categorySource: string | null }[] }).transactions
  const found = () => list(shop)
  const handId = (await list(`${shop} HAND`))[0]!.id
  expect((await context.request.put(`/api/transactions/${handId}/override`, { headers: { Origin: baseURL! }, data: { categoryId: await categoryId(context, 'Travel') } })).ok()).toBe(true)
  const rule = await addRule(context, baseURL!, { textContains: shop.toLowerCase(), categoryId: await categoryId(context, 'Groceries') })

  try {
    await page.goto('/rules')
    await expect(page.getByRole('heading', { level: 2, name: 'Apply the Rules to all Transactions' })).toBeVisible()
    await expect(rerunButton(page)).toBeEnabled()
    await noAxeViolations(page)
    // Nothing has changed yet: a Rule is for new Transactions until it is applied.
    expect((await found()).map((t) => t.categoryName).sort()).toEqual(['Travel', null])

    // (The light and dark runs share a database, so the page may already show the other's finished run; the Transactions are what tell.)
    await rerunButton(page).click()
    await expect.poll(async () => (await found()).find((t) => t.description.endsWith('PLAIN'))?.categoryName).toBe('Groceries')
    await expect(page.getByRole('status').filter({ hasText: /Finished\. Looked at/ })).toContainText('and updated')
    await expect(page.getByText(/^Finished (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/)).toBeVisible()
    await expect(rerunButton(page)).toBeEnabled()
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await noAxeViolations(page)

    // The Transaction on file from before has the Rule's Category now. The one the Admin set by hand has the Category it was given.
    const applied = await found()
    expect(applied.find((t) => t.description.endsWith('PLAIN'))).toMatchObject({ categoryName: 'Groceries', categorySource: 'rule' })
    expect(applied.find((t) => t.description.endsWith('HAND'))).toMatchObject({ categoryName: 'Travel', categorySource: 'override' })

    await page.goto('/change-log')
    await expect(page.getByRole('listitem').filter({ hasText: 'Started applying the Rules to up to' }).first()).toContainText('Rule change by admin@example.com')
    await expect(page.getByRole('listitem').filter({ hasText: 'Finished applying the Rules to all Transactions' }).first()).toContainText('Rule change by admin@example.com')
  } finally {
    await removeRule(context, baseURL!, rule)
  }

  // With the Rule gone, applying the Rules again takes the Category it gave away. The Override stays.
  await page.goto('/rules')
  await rerunButton(page).click()
  await expect.poll(async () => (await found()).find((t) => t.description.endsWith('PLAIN'))?.categoryName).toBeNull()
  await expect(page.getByRole('status').filter({ hasText: /Finished\. Looked at/ })).toBeVisible()
  const cleared = await found()
  expect(cleared.find((t) => t.description.endsWith('PLAIN'))).toMatchObject({ categoryName: null, categorySource: null })
  expect(cleared.find((t) => t.description.endsWith('HAND'))).toMatchObject({ categoryName: 'Travel', categorySource: 'override' })
})

const runningJob = (over: Record<string, unknown> = {}) => ({
  id: 7,
  status: 'running',
  startedAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:30.000Z',
  finishedAt: null,
  totalRows: 20_000,
  doneRows: 4_000,
  changedRows: 12,
  percent: 20,
  restarts: 0,
  stepRows: 1_000,
  cronRowsPerDay: 6_000,
  paused: false,
  ...over,
})

test.describe('while the Rules are being applied', () => {
  // The 429 below is the free plan's daily allowance being used up, which the page has to explain; Chrome logs it as an error.
  test.use({ expectedStatuses: [429] })

  test('the page shows how far it has got, announces a few times, says a used-up day ends at midday NZ time, and carries on by itself then', async ({ page, context }) => {
    await signInAs(context, 'admin')
    // The page asks again when the day changes (00:00 UTC), so the clock is the test's to move.
    await page.clock.install({ time: new Date('2026-10-11T02:00:00Z') })
    let current = runningJob()
    const answers: (() => { status: number; json: unknown })[] = [
      () => ({ status: 200, json: { job: (current = runningJob({ doneRows: 10_000, changedRows: 400, percent: 50, updatedAt: '2026-10-11T02:01:00.000Z' })) } }),
      () => ({ status: 429, json: { error: 'Daily limit reached' } }),
      () => ({ status: 200, json: { job: (current = runningJob({ status: 'done', doneRows: 20_000, changedRows: 1_234, percent: 100, updatedAt: '2026-10-12T00:05:00.000Z', finishedAt: '2026-10-12T00:05:00.000Z' })) } }),
    ]
    // Each step waits to be let go, so the page can be looked at between them.
    const gates = answers.map(() => {
      let open = () => {}
      const opened = new Promise<void>((resolve) => (open = resolve))
      return { opened, open }
    })
    let steps = 0
    await page.route('**/api/rules/rerun/step', async (route) => {
      const n = steps++
      await gates[n]!.opened
      await route.fulfill(answers[n]!())
    })
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: current } }) : route.fallback()))

    await page.goto('/rules')
    // A run that was going when the page was opened is carried on, and shown.
    await expect(page.getByText('Looked at 4,000 of up to 20,000 Transactions (20%).')).toBeVisible()
    const bar = page.getByRole('progressbar', { name: 'Apply the Rules to all Transactions' })
    await expect(bar).toHaveAttribute('value', '20')
    await expect(page.getByRole('status').filter({ hasText: 'Started. Going through up to 20,000 Transactions.' })).toBeVisible()
    await expect(page.getByText('Last updated Sun 11 Oct 2026, 3:00 pm.')).toBeVisible()
    await expect(page.getByText('About 16 more steps if you keep this page open, or about 3 days if you close it. Keep this page open to finish sooner.')).toBeVisible()
    await expect(rerunButton(page)).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Stop applying the Rules' })).toBeEnabled()
    await noAxeViolations(page)

    gates[0]!.open()
    await expect(page.getByText('Looked at 10,000 of up to 20,000 Transactions (50%).')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: '50% done.' })).toBeVisible()
    await expect(bar).toHaveAttribute('value', '50')

    gates[1]!.open()
    const alert = page.getByRole('alert').filter({ hasText: 'used up the database allowance' })
    await expect(alert).toContainText('It carries on by itself after the daily allowance resets, around midday NZ time. Open this page then to finish sooner.')
    await expect(alert.getByRole('button')).toHaveCount(0) // trying again now would only be refused again
    await expect(page.getByText('Looked at 10,000 of up to 20,000 Transactions (50%).')).toBeVisible() // where it got to is still shown
    await noAxeViolations(page)

    // The day changes: the page asks again, with nobody pressing anything.
    gates[2]!.open()
    await page.clock.fastForward('23:00:00')
    await expect(page.getByRole('status').filter({ hasText: 'Finished. Looked at all 20,000 Transactions and updated 1,234 of them.' })).toBeVisible()
    await expect(page.getByText('Finished Mon 12 Oct 2026, 1:05 pm.')).toBeVisible()
    await expect(alert).toHaveCount(0)
    await expect(bar).toHaveCount(0)
    await expect(rerunButton(page)).toBeEnabled()
    await noAxeViolations(page)
  })

  test('a run that has used its share of the day is shown as paused, and the page does not ask for steps', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let steps = 0
    await page.route('**/api/rules/rerun/step', (route) => {
      steps++
      return route.fulfill({ json: { job: runningJob({ paused: true }) } })
    })
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ paused: true }) } }) : route.fallback()))
    await page.goto('/rules')

    await expect(page.getByText(/^Paused: it has used the share of today's free database allowance that it keeps for itself\./)).toContainText('Open this page then to finish sooner.')
    await expect(page.getByRole('status').filter({ hasText: 'Paused until the daily allowance resets, around midday NZ time.' })).toBeVisible()
    await expect(rerunButton(page)).toBeDisabled()
    await noAxeViolations(page)
    expect(steps).toBe(0)
  })

  test('a page whose clock is ahead of the Worker\'s asks again in a few minutes and not a day later', async ({ page, context }) => {
    await signInAs(context, 'admin')
    // By this page's clock it is ten minutes to midnight UTC. The Worker's day has not changed when the page first asks, and changes later.
    await page.clock.install({ time: new Date('2026-10-11T23:50:00Z') })
    let workersDayHasChanged = false
    let asked = 0
    let steps = 0
    let finished = false
    const current = () =>
      finished
        ? runningJob({ status: 'done', doneRows: 20_000, percent: 100, finishedAt: '2026-10-12T00:20:00.000Z', updatedAt: '2026-10-12T00:20:00.000Z' })
        : runningJob({ paused: !workersDayHasChanged })
    await page.route('**/api/rules/rerun/step', (route) => {
      steps++
      finished = true
      return route.fulfill({ json: { job: current() } })
    })
    await page.route('**/api/rules/rerun', (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      asked++
      return route.fulfill({ json: { job: current() } })
    })
    await page.goto('/rules')
    await expect(page.getByText(/^Paused: it has used the share/)).toBeVisible()
    expect(asked).toBe(1)

    await page.clock.fastForward('00:10:10') // the page's midnight: it asks, and is told to wait
    await expect.poll(() => asked).toBe(2)
    await expect(page.getByText(/^Paused: it has used the share/)).toBeVisible()
    expect(steps).toBe(0)

    workersDayHasChanged = true // the Worker's midnight comes a little later
    await page.clock.fastForward('00:05:10') // the page asks again five minutes after, and not a day after
    await expect(page.getByRole('status').filter({ hasText: 'Finished. Looked at all 20,000 Transactions' })).toBeVisible()
    expect(asked).toBe(3)
    expect(steps).toBe(1)
  })

  test('says the Rules changed while it ran, and that it started again', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun/step', () => new Promise(() => {})) // never answered: the page stays as the job was when it opened
    await page.route('**/api/rules/rerun', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ totalRows: 3_000, doneRows: 0, percent: 0, restarts: 2 }) } }) : route.fallback(),
    )
    await page.goto('/rules')

    await expect(page.getByText('The Rules changed 2 times while this was running, so it started again from the first Transaction each time.')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'The Rules changed again, so it started again (2 times). Going through up to 3,000 Transactions.' })).toBeVisible()
  })

  test('does not announce a run that finished before the page was opened', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ status: 'done', doneRows: 20_000, percent: 100, finishedAt: '2026-10-11T02:05:00.000Z' }) } }) : route.fallback(),
    )
    await page.goto('/rules')

    await expect(page.getByText('Finished. Looked at all 20,000 Transactions and updated 12 of them.')).toBeVisible() // shown...
    await expect(page.getByRole('status').filter({ hasText: 'Finished.' })).toHaveCount(0) // ...but not said again to a screen reader
  })

  test('the Admin stops a run, and is told what that leaves', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/rules/rerun/step', () => new Promise(() => {}))
    await page.route('**/api/rules/rerun/stop', (route) =>
      route.fulfill({ json: { job: runningJob({ status: 'stopped', doneRows: 7_000, changedRows: 300, percent: 35, finishedAt: '2026-10-11T02:07:00.000Z' }) } }),
    )
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
    await page.goto('/rules')

    await page.getByRole('button', { name: 'Stop applying the Rules' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Stopped. Looked at 7,000 Transactions and updated 300 of them. Those keep the result they were given and the rest are as they were.' })).toBeFocused()
    await expect(page.getByText('Stopped Sun 11 Oct 2026, 3:07 pm.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop applying the Rules' })).toHaveCount(0)
    await expect(rerunButton(page)).toBeEnabled()
    await noAxeViolations(page)
  })

  test('while a Rule is being changed the run waits, and the form, the Save message and the removal say that saving starts it again', async ({ page, context, baseURL }, testInfo) => {
    await signInAs(context, 'admin')
    const stamp = `${testInfo.project.name}${Date.now()}`
    const rule = await addRule(context, baseURL!, { textContains: `EXAMPLE RUNGOING ${stamp}`, categoryId: await categoryId(context, 'Fuel') })
    let steps = 0
    try {
      await page.route('**/api/rules/rerun/step', (route) => {
        steps++
        return route.fulfill({ json: { job: runningJob() } })
      })
      await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
      await page.goto('/rules')
      await expect.poll(() => steps).toBeGreaterThan(2) // asking for step after step...

      await page.getByRole('button', { name: 'Add a Rule' }).click()
      await expect(page.getByText('A run is going. Saving starts it again from the first Transaction.')).toBeVisible()
      await expect(page.getByText('Waiting while you change a Rule.')).toBeVisible()
      await noAxeViolations(page)
      const whenOpened = steps
      await page.waitForTimeout(600)
      expect(steps - whenOpened).toBeLessThanOrEqual(1) // ...until the form is open: at most the one already out
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect.poll(() => steps).toBeGreaterThan(whenOpened + 2) // and then on again

      await page.getByRole('button', { name: new RegExp(`^Remove Rule \\d+$`) }).last().click()
      await expect(page.getByRole('group', { name: /^Remove Rule/ })).toContainText('A run is going. Removing the Rule starts it again from the first Transaction.')
    } finally {
      await removeRule(context, baseURL!, rule)
    }
  })
})

test('a Member does not see the Rules page, and the API refuses their changes', async ({ page, context, baseURL }) => {
  await signInAs(context, 'member')
  await page.goto('/rules')
  await expect(page.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible()
  await expect(page.getByText('Only the Admin can use this page.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add a Rule' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transactions' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Rules' })).toHaveCount(0)
  await noAxeViolations(page)

  const refused = await context.request.post('/api/rules', { headers: { Origin: baseURL! }, data: { textContains: 'example', transfer: true } })
  expect(refused.status()).toBe(403)
})
