import type { Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, signInAs, test } from './fixtures'

const fontSize = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

const sizeButton = (page: Page, name: 'A' | 'A+' | 'A++') =>
  page.getByRole('group', { name: 'Text size' }).getByRole('button', { name, exact: true })

// ---------------------------------------------------------------------------------------------------------------
// Text size (A / A+ / A++)

test.describe('text size', () => {
  test('starts at A with 16px body text, and each step is bigger', async ({ page }) => {
    await page.goto('/styleguide')
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBe(16)

    await sizeButton(page, 'A+').click()
    await expect(sizeButton(page, 'A+')).toHaveAttribute('aria-pressed', 'true')
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'false')
    const medium = await fontSize(page, 'body')
    expect(medium).toBeGreaterThan(16)

    await sizeButton(page, 'A++').click()
    await expect(sizeButton(page, 'A++')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBeGreaterThan(medium)
  })

  test('is remembered on this device, and applied before the app starts', async ({ page }) => {
    await page.goto('/styleguide')
    await sizeButton(page, 'A++').click()
    await page.reload()
    await expect(sizeButton(page, 'A++')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBeCloseTo(16 * 1.3, 1)
    // The CSP-safe external script has set it by the time the document has parsed, so the page never jumps.
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'a-plus-plus')
  })

  test('still works, without errors, when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError')
        },
      })
    })
    await page.goto('/styleguide') // the fixture fails the test on any console error, uncaught error or CSP violation
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'true')
    await sizeButton(page, 'A+').click()
    await expect(sizeButton(page, 'A+')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBeGreaterThan(16)
    // Other controls still work too.
    await page.getByRole('button', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('shrugs off a junk saved value', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fernledger-text-size', 'enormous'))
    await page.goto('/styleguide')
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBe(16)
  })

  test('has touch targets of at least 44px', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/styleguide')
    // The Admin-only links appear once the signed-in Member is known; `.all()` below doesn't wait for them.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' })).toBeVisible()
    const targets = [
      ...(['A', 'A+', 'A++'] as const).map((name) => sizeButton(page, name)),
      ...(await page.getByRole('navigation', { name: 'Main' }).getByRole('link').all()),
    ]
    expect(targets.length).toBeGreaterThan(3)
    for (const target of targets) {
      const box = await target.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
      expect(box?.width).toBeGreaterThanOrEqual(44)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Zoom: WCAG 1.4.4 (200%) and 1.4.10 reflow (400%, 320 CSS px). A browser at 200% zoom on a 1280px-wide window
// is a 640 CSS px viewport, which is how Playwright reproduces it.

test.describe('zoom', () => {
  const zoomLevels = [
    { name: '200% zoom', width: 640, height: 360 },
    { name: '400% zoom (320px wide)', width: 320, height: 256 },
    // Text can measure a pixel or two wider on another machine: a form that overflowed 320px by 1px on CI's Linux fitted
    // exactly on Windows. A viewport 4px narrower fails on any machine when something can't shrink to fit.
    { name: '400% zoom with 4px to spare (316px wide)', width: 316, height: 256 },
  ]
  const pages = ['/', '/settings', '/styleguide', '/transactions', '/import', '/categories', '/uncategorised', '/about-your-data', '/how-to-sign-in', '/rules', '/budgets', '/reports', '/reports/transactions', '/reports/balances']

  for (const { name, width, height } of zoomLevels) {
    for (const path of pages) {
      for (const size of ['A', 'A++'] as const) {
        test(`${path} at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
          await signInAs(context, 'admin')
          await page.setViewportSize({ width, height })
          await page.goto(path)
          await sizeButton(page, size).click()
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          // Measure only once the size is applied and the buttons have finished their width transition.
          await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
          await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
        })
      }
    }
  }

  // The Admin's full navigation is the widest header. The per-page test above covers it only incidentally,
  // so this one names the case: nothing in the header may push the page wider than the 320px viewport.
  for (const path of ['/', '/settings']) {
    test(`the header with the Admin's full navigation fits 320px at text size A++ on ${path}`, async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.setViewportSize({ width: 320, height: 256 })
      await page.goto(path)
      await sizeButton(page, 'A++').click()
      // Measure only once the larger size is applied and the buttons have finished their width transition.
      await expect(page.locator('html')).toHaveAttribute('data-text-size', 'a-plus-plus')
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
      const nav = page.getByRole('navigation', { name: 'Main' })
      await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Change Log' })).toBeVisible()
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
    })
  }

  // The Import screen with a file chosen and the "Replace imported history" question open: the longest text it shows.
  // The Account and its imported-row count are stubbed, so this needs no data in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/import with the replace question open at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example savings', accountNumber: '99-9999-9999999-97', cutoverDate: '2026-10-01' }] }))
        await page.route('**/api/imports/imported/1', (route) => route.fulfill({ json: { imported: 6000, withOverrideOrNote: 40, carryOverWaiting: 3 } }))
        await page.route('**/api/imports/carry-preview', (route) => route.fulfill({ json: { waiting: 43, carries: 38, differing: 2 } }))
        await page.setViewportSize({ width, height })
        await page.goto('/import')
        await sizeButton(page, size).click()
        const csv = [
          'Created date / time : 2 October 2026 / 18:55:26',
          'Bank 99; Branch 9999; Account 9999999-97 (Zoom Example)',
          'From date 20260901',
          'To date 20261001',
          'Avail Bal : 10.00 as of 20260930',
          'Ledger Balance : 10.00 as of 20261002',
          'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
          '',
          '2026/09/10,202609100,EFTPOS,,"EXAMPLE SHOP WITH A LONG ENOUGH NAME TO WRAP ON A NARROW SCREEN","EFTPOS",-1234567.00',
        ].join('\n')
        await page.getByLabel('Bank export file').setInputFiles({ name: 'zoom.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
        await page.getByRole('button', { name: 'Replace imported history…' }).click()
        await expect(page.getByRole('alertdialog')).toContainText('removed in steps of 5,000')
        await expect(page.getByRole('alertdialog')).toContainText("43 Transactions have an Override (your own Category) or a Note. 38 of them carry over to this file; 5 won't.")
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Rules page with a long Rule listed, the form open and a check result with a long example: the longest text it shows.
  // The Rules and the check are stubbed, so this needs no data in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/rules with the form open and a check result at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        const description = 'EXAMPLE SHOP WITH A LONG ENOUGH NAME TO WRAP ON A NARROW SCREEN'
        await page.route('**/api/rules', (route) =>
          route.request().method() === 'GET'
            ? route.fulfill({
                json: [{ id: 1, textContains: description, bankType: 'EFTPOS', direction: 'out', minCents: 1000, maxCents: 123456789, categoryId: 7, categoryName: 'Health and medical', categoryRemoved: true, transfer: false }],
              })
            : route.fallback(),
        )
        await page.route('**/api/rules/preview', (route) => route.fulfill({ json: { matches: 1234, samples: [{ id: 1, date: '2026-09-10', description, bankType: 'EFTPOS', amountCents: -123456789 }] } }))
        await page.setViewportSize({ width, height })
        await page.goto('/rules')
        await sizeButton(page, size).click()
        await page.getByRole('button', { name: 'Add a Rule' }).click()
        await page.getByLabel('Text contains').fill('example')
        await page.getByRole('button', { name: 'Check how many match' }).click()
        await expect(page.getByText('1,234 Transactions you already have match.')).toBeVisible()
        await expect(page.getByText(/Category: Health and medical \(removed/)).toBeVisible()
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Summary with its longest content: long Account names, big amounts, a warning with its explanation, and a
  // Transaction with a long description. The data is stubbed, so the test needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/ with a Balance Check warning at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        const longName = 'Example everyday account for the household bills and groceries'
        await page.route('**/api/balances', (route) =>
          route.fulfill({
            json: {
              accounts: [
                { accountId: 1, accountName: longName, balanceCents: -123456789, asOfDate: '2026-10-08' },
                { accountId: 2, accountName: 'Example savings', balanceCents: null, asOfDate: null },
              ],
            },
          }),
        )
        await page.route('**/api/balance-checks', (route) =>
          route.fulfill({
            json: {
              differences: [{ accountId: 1, accountName: longName, asOfDate: '2026-10-08', since: '2026-09-30', differenceCents: -123456789 }],
              accounts: [{ accountId: 1, accountName: longName, asOfDate: '2026-10-08', status: 'differs' }],
            },
          }),
        )
        await page.route(/\/api\/transactions\?/, (route) =>
          route.fulfill({
            json: {
              total: null,
              transactions: [{ id: 1, accountId: 1, accountName: longName, date: '2026-10-08', description: 'EXAMPLE SHOP WITH A LONG ENOUGH NAME TO WRAP ON A NARROW SCREEN', bankType: 'EFTPOS', amountCents: -123456789 }],
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/')
        await sizeButton(page, size).click()
        await expect(page.getByRole('region', { name: 'Balance checks' })).toContainText('Balance differs from bank by $1,234,567.89 since Wed 30 Sept 2026')
        await expect(page.getByRole('region', { name: 'Recent transactions' })).toContainText('EXAMPLE SHOP WITH A LONG ENOUGH NAME')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Budgets page with its longest content: a long Category name, big amounts, a long list of changes, and the Admin's form open
  // with every button it can have. The Budgets are stubbed, so this needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/budgets with long content and the form open at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        const longName = 'Health and medical costs for the household and the long-term care fees'
        await page.route(/\/api\/budgets(\?.*)?$/, (route) =>
          route.fulfill({
            json: {
              month: '2026-10',
              changeCount: 595,
              changeLimit: 600,
              budgets: [
                {
                  categoryId: 1,
                  categoryName: longName,
                  amountCents: 123456789,
                  effectiveFrom: '2026-08',
                  changes: [
                    { effectiveFrom: '2026-08', amountCents: 123456789 },
                    { effectiveFrom: '2026-12', amountCents: null },
                    { effectiveFrom: '2027-03', amountCents: 100000000000 },
                  ],
                },
                { categoryId: 2, categoryName: 'Groceries', amountCents: null, effectiveFrom: '2026-06', changes: [{ effectiveFrom: '2026-06', amountCents: null }] },
              ],
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/budgets')
        await sizeButton(page, size).click()
        await page.getByRole('button', { name: `Edit Budget for ${longName}` }).click()
        await expect(page.getByLabel('Monthly Budget in dollars')).toHaveValue('1234567.89')
        await expect(page.getByRole('button', { name: 'End Budget' })).toBeVisible()
        const panel = page.getByRole('region', { name: `Budget for ${longName}` })
        await expect(panel.getByText('This Category already has later changes')).toBeVisible()
        await expect(panel.getByText('From March 2027: $1,000,000,000.00 a month')).toBeVisible()
        await expect(page.getByText('595 are used')).toBeVisible()
        await page.getByLabel('Monthly Budget in dollars').fill('0')
        await page.getByRole('button', { name: 'Save Budget' }).click()
        await expect(page.getByRole('alert')).toContainText('more than $0')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Categories page with a long Category name and its Admin forms open: the kind form (with the Budgets it keeps), then the removal question for a
  // Spending Category with Budget changes and for an Income one. The Categories and Budgets are stubbed.
  const categoryForms = [
    { form: 'the kind form', button: 'Set kind of', category: 'long' },
    { form: 'the removal question', button: 'Remove', category: 'long' },
    { form: 'the removal question for an Income Category', button: 'Remove', category: 'Wages and salary' },
  ] as const
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      for (const { form, button, category } of categoryForms) {
        test(`/categories with ${form} open at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
          await signInAs(context, 'admin')
          const longName = 'Health and medical costs for the household and the long-term care fees'
          await page.route(/\/api\/categories$/, (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({ json: [{ id: 1, name: longName, kind: 'spending' }, { id: 2, name: 'Wages and salary', kind: 'income' }, { id: 3, name: 'Loans', kind: 'loans' }] })
              : route.fallback(),
          )
          await page.route(/\/api\/budgets(\?.*)?$/, (route) =>
            route.fulfill({
              json: {
                month: '2026-10',
                changeCount: 2,
                changeLimit: 600,
                budgets: [{ categoryId: 1, categoryName: longName, amountCents: 5000, effectiveFrom: '2026-08', changes: [{ effectiveFrom: '2026-08', amountCents: 5000 }, { effectiveFrom: '2026-12', amountCents: null }] }],
              },
            }),
          )
          await page.setViewportSize({ width, height })
          await page.goto('/categories')
          await sizeButton(page, size).click()
          const target = category === 'long' ? longName : category
          await page.getByRole('button', { name: `${button} ${target}` }).click()
          if (button === 'Set kind of') {
            await expect(page.locator('#kind-1')).toBeFocused()
            await page.locator('#kind-1').selectOption('loans')
            await expect(page.getByText('Its Budgets are kept but not used.')).toBeVisible()
          } else if (category === 'long') {
            await expect(page.getByText('Its Budget (2 changes) stops being used in every month, past ones too')).toBeVisible()
          } else {
            await expect(page.getByText('Wages and salary is an Income Category, so its Transactions stop counting as income. Those that end up Uncategorised count as Spending.')).toBeVisible()
            await expect(page.getByText('stops being used in every month')).toHaveCount(0)
          }
          // Measure only once the size is applied and the buttons have finished their width transition.
          await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
          await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
        })
      }
    }
  }

  // The Summary's Budget vs actual with its longest content: a long Category name, big amounts, and each Status. The data is stubbed.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/ with Budget vs actual at its longest at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        const longName = 'Health and medical costs for the household and the long-term care fees'
        await page.route(/\/api\/budgets\/vs-actual/, (route) =>
          route.fulfill({
            json: {
              month: '2026-10',
              rows: [
                { categoryId: 1, categoryName: longName, budgetCents: 123456789, spentCents: 234567890 },
                { categoryId: 2, categoryName: 'Groceries', budgetCents: 80000, spentCents: 80000 },
                { categoryId: 3, categoryName: 'Fuel', budgetCents: 100000000000, spentCents: -123456789 },
              ],
              otherCents: 123456789012,
              uncategorisedCents: -123456789012,
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/')
        await sizeButton(page, size).click()
        const widget = page.getByRole('region', { name: 'Budget vs actual' })
        await expect(widget).toContainText('Over Budget')
        await expect(widget).toContainText('On Budget')
        await expect(widget).toContainText('Under Budget')
        await expect(widget).toContainText('$1,234,567.89 back')
        await expect(widget).toContainText('Spending outside Budgets')
        await expect(widget).toContainText('$1,234,567,890.12')
        await expect(widget).toContainText('Uncategorised (includes money in not yet given a Category)')
        await expect(widget).toContainText('$1,234,567,890.12 back')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // A Transaction's details with every field filled in and long values, and the Admin's edit panel open: the longest text
  // that page shows. The Transaction is stubbed, so this needs no data in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/transactions/4242 with every detail filled and the edit panel open at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        const long = 'EXAMPLE'.padEnd(80, 'x')
        await page.route('**/api/transactions/4242', (route) =>
          route.fulfill({
            json: {
              id: 4242,
              accountId: 1,
              accountName: 'Example savings account with a long name',
              date: '2026-10-08',
              amountCents: -123456789,
              description: `${long} shop with a long enough name to wrap on a narrow screen`,
              bankMemo: long,
              bankType: 'EFTPOS',
              bankReference: long,
              bankCounterpartyAccount: '99-9999-9999999-97',
              bankCardSuffix: '1234',
              bankParticulars: long,
              bankPaymentCode: long,
              source: 'sync',
              categoryId: 3,
              categoryName: 'Eating out',
              categorySource: 'override',
              categoryKind: 'loans', // the longest kind note, so it is measured too
              note: `${long} note that goes on and on`,
              bankTime: '2026-10-07T20:15:00.000Z',
              firstSeenAt: '2026-10-08T06:30:00.000Z',
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/transactions/4242')
        await sizeButton(page, size).click()
        await page.getByRole('button', { name: 'Edit Category and Note' }).click()
        await expect(page.getByRole('region', { name: 'Edit Category and Note' })).toBeVisible()
        await expect(page.getByRole('region', { name: 'From the bank' })).toContainText('First seen by Akahu')
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Transaction listing Report with its longest content: a long app title and Account name, a long description and Note,
  // a huge amount and totals, on screen (cards on a narrow window). The data is stubbed, so the test needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/reports/transactions with long content at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        const long = 'EXAMPLE'.padEnd(80, 'x')
        await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(60, 'x'), about_contact: '', about_retention: '' } }))
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account with a long name'.padEnd(60, 'y'), accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
        await page.route('**/api/reports/transactions?**', (route) =>
          route.fulfill({
            json: {
              transactions: [{ id: 1, date: '2026-10-08', description: `${long} shop with a long enough name to wrap on a narrow screen`, amountCents: -123456789, categoryName: 'Category with a long name'.padEnd(40, 'z'), note: `${long} note that goes on and on`, source: 'sync', bankReference: long, bankCounterpartyAccount: '99-9999-9999999-97', bankCardSuffix: '1234', bankParticulars: long, bankPaymentCode: long }],
              next: null,
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/reports/transactions?account=1&from=2026-10-01&to=2026-10-31')
        await sizeButton(page, size).click()
        await expect(page.getByRole('article', { name: 'Transaction listing' })).toContainText('−$1,234,567.89')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The balances-over-time Report with its longest content: a long app title and Account name, the largest balances and a Balance Check
  // difference, on screen (cards on a narrow window). The data is stubbed, so the test needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['A', 'A++'] as const) {
      test(`/reports/balances with long content at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(60, 'x'), about_contact: '', about_retention: '' } }))
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account with a long name'.padEnd(60, 'y'), accountNumber: '99-9999-9999999-97', cutoverDate: '2026-11-01' }] }))
        await page.route('**/api/reports/balances?**', (route) =>
          route.fulfill({
            json: {
              accountId: 1,
              from: '2026-09-01',
              to: '2026-12-31',
              anchor: { asOfDate: '2026-10-31', balanceCents: 123456789 },
              latestStatus: 'differs',
              held: { from: '2026-09-02', to: '2026-10-31' },
              opening: { balanceCents: -123456789, beforeFirst: false },
              rows: [{ date: '2026-10-31', balanceCents: 123456789, changeCents: 246913578, bankCents: 99999999 }],
              closing: { date: '2026-10-31', balanceCents: 123456789 },
              changeCents: 246913578,
              checks: { count: 1, coversFrom: '2026-09-02', coversTo: '2026-10-31' },
              differences: [{ asOfDate: '2026-10-31', since: '2026-09-02', differenceCents: -123456789 }],
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/reports/balances?account=1&from=2026-09-01&to=2026-12-31')
        await sizeButton(page, size).click()
        await expect(page.getByRole('article', { name: 'Balances over time' })).toContainText('$1,234,567.89')
        await expect(page.getByRole('article', { name: 'Balances over time' })).toContainText('Balance differs from bank by $1,234,567.89')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expect(sizeButton(page, size)).toHaveAttribute('aria-pressed', 'true')
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  test('a very long app title wraps instead of scrolling sideways', async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(120, 'x'), about_contact: '', about_retention: '' } }))
    await page.setViewportSize({ width: 320, height: 256 })
    await page.goto('/')
    await expect(page.getByRole('banner')).toContainText('Thexxx')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Amounts, dates and the table that becomes cards

test.describe('responsive table', () => {
  test('is a table on a wide screen and cards on a narrow one', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    await expect(table).toBeVisible()
    await expect(page.getByRole('list', { name: 'Sample transactions' })).toBeHidden()
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Description', 'Amount'])
    await expect(table.getByRole('row')).toHaveCount(4) // header + 3 rows

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(table).toBeHidden()
    const cards = page.getByRole('list', { name: 'Sample transactions' }).getByRole('listitem')
    await expect(cards).toHaveCount(3)
    // Each card carries the same facts, each with its heading beside it.
    await expect(cards.first()).toContainText('Date')
    await expect(cards.first()).toContainText('Thu 8 Oct 2026')
    await expect(cards.first()).toContainText('Example Supermarket')
    await expect(cards.first()).toContainText('−$1,111.11')
  })

  test('sorts by a column heading on a wide screen and from a menu on cards', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    const amount = table.getByRole('columnheader', { name: 'Amount' })
    await expect(table.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'descending')

    await amount.getByRole('button').click()
    await expect(amount).toHaveAttribute('aria-sort', 'ascending')
    await expect(table.getByRole('row').nth(1)).toContainText('Example Power Company') // the largest money out
    await amount.getByRole('button').click()
    await expect(amount).toHaveAttribute('aria-sort', 'descending')
    await expect(table.getByRole('row').nth(1)).toContainText('Example Employer wages')

    await page.setViewportSize({ width: 390, height: 844 })
    const menu = page.getByLabel('Sort by')
    await expect(menu).toHaveValue('amount:descending')
    await menu.selectOption({ label: 'Description, A to Z' })
    await expect(page.getByRole('list', { name: 'Sample transactions' }).getByRole('listitem').first()).toContainText('Example Employer wages')
  })

  test('builds each cell once, so the page has no duplicate ids, at either width', async ({ page }) => {
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/styleguide')
      await expect(page.getByText('Example Supermarket')).toHaveCount(1)
      const duplicates = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
        return ids.filter((id, i) => ids.indexOf(id) !== i)
      })
      expect(duplicates).toEqual([])
    }
  })

  test('shows signed NZD amounts and NZ dates, with the direction in words', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    await expect(table.getByRole('row').nth(1)).toContainText('Thu 8 Oct 2026')
    await expect(table.getByText('−$1,111.11')).toBeVisible()
    await expect(table.getByText('+$1,234.56')).toBeVisible()
    await expect(table.getByText('Money out').first()).toBeVisible()
    await expect(table.getByText('Money in').first()).toBeVisible()
    expect(await table.innerText()).not.toMatch(/\d-\$|-\$/) // a real minus sign, never a hyphen
  })

  test('right-aligns amounts and gives digits a fixed width', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    await expect(page.getByRole('table')).toBeVisible()
    await page.evaluate(() => document.fonts.ready) // measure the real font, not the fallback it swaps from
    const wide = page.getByRole('table').getByText('−$1,111.11')
    const other = page.getByRole('table').getByText('−$8,888.88')
    const [a, b] = [await wide.boundingBox(), await other.boundingBox()]
    // Same number of characters, different digits: equal widths means tabular figures; equal right edges, right-aligned.
    expect(a!.width).toBeCloseTo(b!.width, 1)
    expect(a!.x + a!.width).toBeCloseTo(b!.x + b!.width, 1)
    const align = await wide.locator('xpath=ancestor::td').evaluate((el) => getComputedStyle(el).textAlign)
    expect(['right', 'end']).toContain(align)
  })

  test('keeps table text at 15px or more at every text size', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    for (const size of ['A', 'A+', 'A++'] as const) {
      await sizeButton(page, size).click()
      for (const selector of ['table', 'table th', 'table td']) {
        expect(await fontSize(page, selector)).toBeGreaterThanOrEqual(15)
      }
    }
  })

  test('keeps card text at 15px or more on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/styleguide')
    expect(await fontSize(page, 'ul[aria-label="Sample transactions"] li')).toBeGreaterThanOrEqual(15)
    expect(await fontSize(page, 'ul[aria-label="Sample transactions"] dt')).toBeGreaterThanOrEqual(15)
  })

  test('prints as a table even from a phone-width page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ media: 'print' })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    await expect(table).toBeVisible()
    await expect(table.getByRole('row')).toHaveCount(4) // header + 3 rows
    await expect(page.getByRole('list', { name: 'Sample transactions' })).toBeHidden()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Statuses

test('a status is an icon and words as well as a colour', async ({ page }) => {
  await page.goto('/styleguide')
  for (const words of ['Synced', 'Pending', 'Needs attention', 'Problem', 'Not set up']) {
    const status = page.getByText(words, { exact: true })
    await expect(status).toBeVisible()
    const icon = status.locator('xpath=..').locator('svg')
    await expect(icon).toHaveCount(1)
    await expect(icon).toHaveAttribute('aria-hidden', 'true') // the words carry the meaning for a screen reader
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Device settings

test.describe('reduced motion', () => {
  test('is respected: transitions and animations all but stop', async ({ page }) => {
    await page.goto('/styleguide')
    const duration = () =>
      page.getByRole('button', { name: 'Dark' }).evaluate((el) => {
        const s = getComputedStyle(el)
        return { transition: parseFloat(s.transitionDuration), scroll: s.scrollBehavior }
      })
    // Without the preference the button does animate (so the check below proves something).
    expect((await duration()).transition).toBeGreaterThan(0.05)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await duration()
    expect(reduced.transition).toBeLessThanOrEqual(0.001)
    expect(reduced.scroll).toBe('auto')
  })
})

test.describe('forced colours (Windows high contrast)', () => {
  test('keeps the chosen text size and theme visible, and focus drawn as an outline', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/styleguide')
    const pressed = sizeButton(page, 'A')
    const unpressed = sizeButton(page, 'A+')
    const background = (button: typeof pressed) => button.evaluate((el) => getComputedStyle(el).backgroundColor)
    // The pressed button is told apart by more than the fill the browser throws away.
    expect(await background(pressed)).not.toBe(await background(unpressed))

    await unpressed.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const outline = await unpressed.evaluate((el) => {
      const s = getComputedStyle(el)
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }
    })
    expect(outline.style).toBe('solid')
    expect(outline.width).toBeGreaterThanOrEqual(2)
  })

  test('still shows every status icon and word', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/styleguide')
    await expect(page.getByText('Needs attention', { exact: true })).toBeVisible()
    await expect(page.locator('svg[aria-hidden="true"]').first()).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Header

test.describe('header', () => {
  test('shows the app title from Settings, and uses it as the page title', async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: "Mum's finances", about_contact: '', about_retention: '' } }))
    await page.goto('/')
    await expect(page.getByRole('banner').getByText("Mum's finances")).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })

  test('says Fernledger until the Admin sets a title', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('banner').getByText('Fernledger', { exact: true })).toBeVisible()
    await expect(page).toHaveTitle('Fernledger')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Accessibility of the new building blocks at the largest text size

test('the examples page has no WCAG 2.2 AA violations at the largest text size', async ({ page }) => {
  await page.goto('/styleguide')
  await sizeButton(page, 'A++').click()
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
})
