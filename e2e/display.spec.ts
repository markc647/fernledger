import type { Locator, Page } from '@playwright/test'
import { netWorth as netWorthRegion, spending as spendingRegion } from './chart-helpers'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import {
  chooseTextSize,
  closeHeaderControls,
  expectRailUnclipped,
  expectTextSize,
  mainNav,
  navLink,
  openHeaderControls,
  openNavGroup,
  showSidebar,
  siteHeader,
  sidebarTitle,
  signOutLink,
  textSizeButton,
  textSizeGroup,
  themeToggle,
} from './shell-helpers'

const fontSize = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

// ---------------------------------------------------------------------------------------------------------------
// Text size (Small / Medium / Large)

test.describe('text size', () => {
  test('starts at Medium with 16px body text; Small is 14px and Large is 20px', async ({ page }) => {
    await page.goto('/styleguide')
    await expect(textSizeButton(page, 'Medium')).toBeChecked()
    expect(await fontSize(page, 'body')).toBe(16)

    await textSizeButton(page, 'Small').click()
    await expect(textSizeButton(page, 'Small')).toBeChecked()
    await expect(textSizeButton(page, 'Medium')).not.toBeChecked()
    expect(await fontSize(page, 'body')).toBe(14)

    await textSizeButton(page, 'Large').click()
    await expect(textSizeButton(page, 'Large')).toBeChecked()
    expect(await fontSize(page, 'body')).toBe(20)
  })

  test('is remembered on this device, and applied before the app starts', async ({ page }) => {
    await page.goto('/styleguide')
    await textSizeButton(page, 'Large').click()
    await page.reload()
    await expect(textSizeButton(page, 'Large')).toBeChecked()
    expect(await fontSize(page, 'body')).toBe(20)
    // The CSP-safe external script has set it by the time the document has parsed, so the page never jumps.
    await expectTextSize(page, 'Large')
  })

  // The first control (A / A+ / A++) saved 'a-plus' or 'a-plus-plus' under the same key. Someone who chose A+ on it gets Large and not the default (src/lib/text-size.test.ts
  // and scripts/text-size-init.test.mjs hold the other values).
  test('reads a size the old A / A+ / A++ control saved: A+ is Large', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fernledger-text-size', 'a-plus'))
    await page.goto('/styleguide')
    await expectTextSize(page, 'Large')
    await expect(textSizeButton(page, 'Large')).toBeChecked()
  })

  test('shrugs off a junk saved value', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fernledger-text-size', 'enormous'))
    await page.goto('/styleguide')
    await expect(textSizeButton(page, 'Medium')).toBeChecked()
    expect(await fontSize(page, 'body')).toBe(16)
  })

  // README, Accessibility: a target is 44px on a touch screen, where it matters. With a mouse the shell's rows and header buttons are 32px (2rem), a deliberate exception, and
  // not under 24px at any text size (WCAG 2.5.8): Small makes every rem-sized thing 12.5% smaller, targets included.
  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true })
    test('the header controls and every row of the sidebar are at least 44px', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto('/styleguide')
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      for (const group of ['Transactions', 'Reports', 'Set up', 'Help']) await openNavGroup(page, group)
      const targets = [
        ...(['Small', 'Medium', 'Large'] as const).map((name) => textSizeButton(page, name)),
        themeToggle(page),
        signOutLink(page),
        page.getByRole('button', { name: 'Toggle sidebar' }),
        ...(await mainNav(page).getByRole('link').all()),
        ...(await mainNav(page).getByRole('button').all()),
      ]
      expect(targets.length).toBeGreaterThan(20)
      for (const target of targets) {
        const box = await target.boundingBox()
        expect(box?.height, await target.innerText().catch(() => 'a control')).toBeGreaterThanOrEqual(44)
        expect(box?.width).toBeGreaterThanOrEqual(44)
      }
    })

    test('the icons of the collapsed sidebar are at least 44px too', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.setViewportSize({ width: 900, height: 800 }) // narrower than 1100px, so the sidebar starts as the icon rail
      await page.goto('/styleguide')
      await expect(mainNav(page).getByRole('button', { name: 'Transactions' })).toBeVisible()
      for (const target of [...(await mainNav(page).getByRole('button').all()), ...(await mainNav(page).getByRole('link').all())]) {
        const box = await target.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(44)
        expect(box?.width).toBeGreaterThanOrEqual(44)
      }
      await expectRailUnclipped(page) // a 44px icon in a rail too narrow for it is cut off, and so is its outline
    })
  })

  test('with a mouse the shell is at least 32px at Medium and Large and never under 24px at Small', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/styleguide')
    for (const group of ['Transactions', 'Reports', 'Set up', 'Help']) await openNavGroup(page, group)
    for (const [size, least] of [['Medium', 32], ['Large', 32], ['Small', 24]] as const) {
      await chooseTextSize(page, size)
      await settle(page)
      const targets = [
        ...(['Small', 'Medium', 'Large'] as const).map((name) => textSizeButton(page, name)),
        themeToggle(page),
        signOutLink(page),
        ...(await mainNav(page).getByRole('link').all()),
        ...(await mainNav(page).getByRole('button').all()),
      ]
      for (const target of targets) {
        const box = await target.boundingBox()
        expect(box?.height, `${size}: ${await target.innerText().catch(() => 'a control')}`).toBeGreaterThanOrEqual(least)
        expect(box?.width).toBeGreaterThanOrEqual(least)
      }
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
  const pages = ['/', '/charts', '/settings', '/styleguide', '/transactions', '/change-log', '/import', '/categories', '/uncategorised', '/about-your-data', '/how-to-sign-in', '/rules', '/budgets', '/reports', '/reports/transactions', '/reports/balances', '/reports/spending', '/reports/budget-vs-actual', '/reports/income-vs-spending', '/reports/loans']

  for (const { name, width, height } of zoomLevels) {
    for (const path of pages) {
      for (const size of ['Medium', 'Large'] as const) {
        test(`${path} at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
          await signInAs(context, 'admin')
          await page.setViewportSize({ width, height })
          await page.goto(path)
          await chooseTextSize(page, size)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          // Measure only once the size is applied and the buttons have finished their width transition.
          await expectTextSize(page, size)
          await settle(page)
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
        })
      }
    }
  }

  // The header is one row on a phone (the sidebar toggle, where the page is, one menu button), and the menu and the sidebar's sheet, open, fit the window however short it is
  // and however large the text: at 400% zoom the window is 256px high, and what does not fit scrolls. (The Admin's sidebar is the longest.)
  test(`the header is one row at 320px and text size Large, and its menu and the sidebar's sheet fit`, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 320, height: 256 })
    await page.goto('/')
    await chooseTextSize(page, 'Large')
    await settle(page)
    const within = async (locator: Locator, where: { x?: number; y?: number; width: number; height: number }, what: string) => {
      const box = (await locator.boundingBox())!
      expect(box.x, `${what}: left`).toBeGreaterThanOrEqual((where.x ?? 0) - 0.5)
      expect(box.x + box.width, `${what}: right`).toBeLessThanOrEqual((where.x ?? 0) + where.width + 0.5)
      expect(box.y, `${what}: top`).toBeGreaterThanOrEqual((where.y ?? 0) - 0.5)
      expect(box.y + box.height, `${what}: bottom`).toBeLessThanOrEqual((where.y ?? 0) + where.height + 0.5)
    }
    const screen = { width: 320, height: 256 }

    // One row: the bar is 3rem tall (60px at Large), not two lines of controls, and none of it is wider than the screen.
    const header = siteHeader(page)
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(60.5)
    await within(header.getByRole('button', { name: 'Toggle sidebar' }), screen, 'the sidebar toggle')
    await within(header.getByRole('button', { name: 'Display settings and sign out' }), screen, 'the menu button')
    await expect(header.getByRole('button', { name: 'Display settings and sign out' })).toBeVisible()
    await expect(textSizeGroup(page)).toBeHidden() // all three of the controls are in the menu
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth)

    // The menu: all of it is on the screen, or can be scrolled to.
    await openHeaderControls(page)
    const menu = page.locator('[data-slot="popover-content"]')
    await within(menu, screen, 'the menu')
    await signOutLink(page).scrollIntoViewIfNeeded()
    await within(signOutLink(page), (await menu.boundingBox())!, 'Sign out, in the menu')
    await closeHeaderControls(page)

    // The sidebar's sheet, with the Admin's longest group open: it fits, and every link in it can be scrolled to.
    await openNavGroup(page, 'Set up')
    await settle(page) // the sheet has slid in
    const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]')
    await within(sheet, screen, 'the sheet')
    for (const label of ['Accounts', 'Categories', 'Rules', 'Budgets', 'Settings']) {
      await navLink(page, label).scrollIntoViewIfNeeded()
      await within(navLink(page, label), (await sheet.boundingBox())!, label)
    }
  })

  // The Import screen with a file chosen and the "Replace imported history" question open: the longest text it shows.
  // The Account and its imported-row count are stubbed, so this needs no data in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/import with the replace question open at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example savings', accountNumber: '99-9999-9999999-97', cutoverDate: '2026-10-01' }] }))
        await page.route('**/api/imports/imported/1', (route) => route.fulfill({ json: { imported: 6000, withOwnWork: 40, carryOverWaiting: 3 } }))
        await page.route('**/api/imports/carry-preview', (route) => route.fulfill({ json: { waiting: 43, carries: 38, differing: 2 } }))
        await page.setViewportSize({ width, height })
        await page.goto('/import')
        await chooseTextSize(page, size)
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
        await expect(page.getByRole('alertdialog')).toContainText("43 Transactions have an Override (your own Category), a Note or a Not a Transfer mark. 38 of them carry over to this file; 5 won't.")
        await expectTextSize(page, size)
        await settle(page)
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
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
        await page.getByRole('button', { name: 'Add a Rule' }).click()
        await page.getByLabel('Text contains').fill('example')
        await page.getByRole('button', { name: 'Check how many match' }).click()
        await expect(page.getByText('1,234 Transactions you already have match.')).toBeVisible()
        await expect(page.getByText(/Category: Health and medical \(removed/)).toBeVisible()
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Rules page with the D1 usage bar on and the day used up: the longest figures and badge it shows (the figures are stubbed, so this needs
  // no token). With it off, the page's own test above covers the longer Setup needed words.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/rules with the D1 usage bar showing the day used up at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        await page.route('**/api/features', (route) => route.fulfill({ json: { features: [{ id: 'd1-usage', name: 'D1 usage bar', enabled: true }] } }))
        await page.route('**/api/d1-usage', (route) =>
          route.fulfill({ json: { rowsRead: 5_100_000, rowsWritten: 100_000, readLimit: 5_000_000, writeLimit: 100_000, resetsAt: '2026-10-15T00:00:00.000Z' } }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/rules')
        await chooseTextSize(page, size)
        await expect(page.getByText('5,100,000 of 5,000,000 rows read · 102%')).toBeVisible()
        await expect(page.getByText('The allowance starts again on Thu 15 Oct 2026, 1:00 pm, New Zealand time.')).toBeVisible()
        await expectTextSize(page, size)
        await settle(page)
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
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
        await expect(page.getByRole('region', { name: 'Balance checks' })).toContainText('Balance differs from bank by $1,234,567.89 since Wed 30 Sept 2026')
        await expect(page.getByRole('region', { name: 'Recent transactions' })).toContainText('EXAMPLE SHOP WITH A LONG ENOUGH NAME')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
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
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
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
        await expectTextSize(page, size)
        await settle(page)
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
    { form: 'the kind form', button: 'Select kind of', category: 'long' },
    { form: 'the removal question', button: 'Remove', category: 'long' },
    { form: 'the removal question for an Income Category', button: 'Remove', category: 'Wages and salary' },
  ] as const
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
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
          await chooseTextSize(page, size)
          const target = category === 'long' ? longName : category
          await page.getByRole('button', { name: `${button} ${target}` }).click()
          if (button === 'Select kind of') {
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
          await expectTextSize(page, size)
          await settle(page)
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
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
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
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The charts with their longest content, on the Charts page (a Member's) and on the Dashboard (the Admin's): ten years of months, big amounts, Accounts
  // and Categories with long names, a Category below zero, and the figures open. The charts' data is stubbed, so this needs nothing in the database.
  const longChartName = 'Health and medical costs for the household and the long-term care fees'
  const stubCharts = async (page: Page) => {
    await page.route(/\/api\/charts\/net-worth/, (route) =>
      route.fulfill({
        json: {
          range: '24-months',
          counted: [{ accountId: 1, accountName: longChartName, lastDate: '2027-02-28' }, { accountId: 4, accountName: `${longChartName} term deposit`, lastDate: '2020-03-12' }],
          notCounted: [{ accountId: 2, accountName: `${longChartName} credit card`, latestStatus: 'after-cutover' }, { accountId: 3, accountName: 'Example savings', latestStatus: null }],
          points: Array.from({ length: 120 }, (_, i) => ({ date: new Date(Date.UTC(2017, i + 1, 0)).toISOString().slice(0, 10), cents: 123_456_789 - i * 2_000_000 })),
          tooManyAccounts: null,
        },
      }),
    )
    await page.route(/\/api\/charts\/spending\?/, (route) =>
      route.fulfill({
        json: {
          from: '2026-10-01',
          to: '2026-10-31',
          totalCents: 123_456_789_012,
          categories: [
            ...Array.from({ length: 13 }, (_, i) => ({ categoryId: i + 1, name: `${longChartName} ${i + 1}`, cents: 123_456_789_012 - i * 9_000_000_000 })),
            { categoryId: null, name: 'Uncategorised', cents: 5000 },
            { categoryId: 99, name: 'Fuel', cents: -123_456_789 },
          ],
        },
      }),
    )
  }
  for (const { path, role } of [{ path: '/charts', role: 'member' }, { path: '/', role: 'admin' }] as const) {
    for (const { name, width, height } of zoomLevels) {
      for (const size of ['Medium', 'Large'] as const) {
        test(`${path} with long charts (${role}) at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
          await signInAs(context, role)
          await stubCharts(page)
          await page.setViewportSize({ width, height })
          await page.goto(path)
          await chooseTextSize(page, size)
          const netWorth = netWorthRegion(page)
          const spending = spendingRegion(page)
          // The Dashboard draws net worth when it is asked to; the Charts page draws it at once.
          if (path === '/') await netWorth.getByRole('button', { name: 'Show net worth' }).click()
          await expect(netWorth.getByRole('img', { name: /^Line chart of net worth by month/ }).locator('svg.recharts-surface')).toBeVisible()
          await expect(spending.getByRole('img', { name: /^Bar chart of the 12 Categories/ }).locator('svg.recharts-surface')).toBeVisible()
          await expect(netWorth).toContainText('These Accounts are not in the total:')
          await expect(netWorth).toContainText('its balance stays the same after that')
          await netWorth.getByText('Show the figures').click()
          await expect(spending).toContainText('The chart shows the biggest 12 Categories. The table has the other 2 too.')
          await expect(spending).toContainText('$1,234,567.89 back')
          // Measure only once the size is applied and the buttons have finished their width transition.
          await expectTextSize(page, size)
          await settle(page)
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
          // The pictures fit the window too, and keep a size worth reading: no chart is squeezed to nothing.
          for (const svg of await page.locator('[data-slot="chart"] svg.recharts-surface').all()) {
            const box = await svg.boundingBox()
            expect(box!.width).toBeLessThanOrEqual(clientWidth)
            expect(box!.width).toBeGreaterThan(100)
          }
        })
      }
    }
  }

  // The Dashboard as the Admin lands on it, net worth not yet asked for: its explanation, its button (a touch target that may wrap) and its link to the Charts page, beside
  // spending drawn from long data. The charts' data is stubbed, so this needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/ with the Show net worth button at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        await stubCharts(page)
        await page.setViewportSize({ width, height })
        await page.goto('/')
        await chooseTextSize(page, size)
        const netWorth = netWorthRegion(page)
        const button = netWorth.getByRole('button', { name: 'Show net worth' })
        await expect(button).toBeVisible()
        await expect(netWorth).toContainText('Net worth is not drawn until you ask for it, because working it out reads every Transaction of every Account.')
        await expect(netWorth.getByRole('link', { name: 'Open the Charts page for longer ranges' })).toBeVisible()
        await expect(spendingRegion(page).getByRole('img', { name: /^Bar chart of the 12 Categories/ }).locator('svg.recharts-surface')).toBeVisible()
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
        const box = await button.boundingBox()
        expect(box!.width).toBeLessThanOrEqual(clientWidth)
        expect(box!.height).toBeGreaterThanOrEqual(44)
      })
    }
  }

  // A Transaction's details with every field filled in and long values, and the Admin's edit panel open: the longest text
  // that page shows. The Transaction is stubbed, so this needs no data in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
        await page.getByRole('button', { name: 'Edit Category and Note' }).click()
        await expect(page.getByRole('region', { name: 'Edit Category and Note' })).toBeVisible()
        await expect(page.getByRole('region', { name: 'From the bank' })).toContainText('First seen by Akahu')
        await expectTextSize(page, size)
        await settle(page)
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
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
        await expect(page.getByRole('article', { name: 'Transaction listing' })).toContainText('−$1,234,567.89')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
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
    for (const size of ['Medium', 'Large'] as const) {
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
        await chooseTextSize(page, size)
        await expect(page.getByRole('article', { name: 'Balances over time' })).toContainText('$1,234,567.89')
        await expect(page.getByRole('article', { name: 'Balances over time' })).toContainText('Balance differs from bank by $1,234,567.89')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The spending-by-Category Report with its longest content: a long app title and Account name, a Category name with no spaces, the largest amounts, money
  // back and a total that is less than nothing, on screen (cards on a narrow window). The data is stubbed, so the test needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/reports/spending with long content at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(60, 'x'), about_contact: '', about_retention: '' } }))
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account with a long name'.padEnd(60, 'y'), accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
        await page.route('**/api/reports/spending?**', (route) =>
          route.fulfill({
            json: {
              from: '2026-09-01',
              to: '2026-10-31',
              totalCents: -123456789,
              categories: [
                { categoryId: 1, name: 'Health and medical costs for the household and the long-term care fees'.padEnd(120, 'z'), cents: 123456789012 },
                { categoryId: 2, name: 'Groceries', cents: -123456789 },
                { categoryId: null, name: 'Uncategorised', cents: -123456789012 },
              ],
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/reports/spending?from=2026-09-01&to=2026-10-31')
        await chooseTextSize(page, size)
        const report = page.getByRole('article', { name: 'Spending by Category' })
        await expect(report).toContainText('$1,234,567,890.12')
        await expect(report).toContainText('$1,234,567.89 back')
        await expect(report).toContainText('Uncategorised (includes money in not yet given a Category)') // the longest row name
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Loans Report with its longest content: a long app title, Account, description, Note and Loans Category name (a person's name with no spaces), the largest amounts,
  // an opening balance, and a loan owed to the person as well as one owed by them, on screen (cards on a narrow window). The data is stubbed, so the test needs nothing in
  // the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/reports/loans with long content at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        const person = 'Alexandra'.padEnd(100, 'x')
        const long = 'EXAMPLE'.padEnd(80, 'x')
        await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(60, 'x'), about_contact: '', about_retention: '' } }))
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account with a long name'.padEnd(60, 'y'), accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
        await page.route('**/api/categories', (route) => route.fulfill({ json: [{ id: 1, name: `Loan – ${person}`, kind: 'loans' }, { id: 2, name: 'Loan – Ben', kind: 'loans' }] }))
        await page.route('**/api/reports/loans?**', (route) => {
          const category = Number(new URL(route.request().url()).searchParams.get('categoryId'))
          return route.fulfill({
            json: {
              category: { id: category, name: category === 1 ? `Loan – ${person}` : 'Loan – Ben' },
              opening: { cents: category === 1 ? -123456789 : 123456789, count: 1 },
              transactions: [
                { id: category, date: '2026-10-08', description: `${long} payment with a long enough name to wrap on a narrow screen`, amountCents: category === 1 ? -123456789 : 123456789, accountName: 'Example account with a long name'.padEnd(60, 'y'), note: `${long} note that goes on and on` },
              ],
              next: null,
            },
          })
        })
        await page.setViewportSize({ width, height })
        await page.goto('/reports/loans?from=2026-09-01&to=2026-10-31')
        await chooseTextSize(page, size)
        const report = page.getByRole('article', { name: 'Loans', exact: true })
        await expect(report).toContainText('$2,469,135.78') // the opening balance and the loan together, the largest amount owed
        await expect(report).toContainText(`${person} owes`)
        await expect(report).toContainText('Ben is owed')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The Budget vs actual Report with its longest content: a long app title, Account and Category name, the largest amounts, a notice that the dates were part of a
  // month, a Budget that changed, a month that is not over and the months together, on screen (cards on a narrow window). The data is stubbed, so the test needs
  // nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/reports/budget-vs-actual with long content at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        const long = 'Category with a long name'.padEnd(60, 'z')
        const month = (m: string, state: string, budgetCents: number, spentCents: number, changed: boolean) => ({
          month: m,
          state,
          rows: [{ categoryId: 1, categoryName: long, budgetCents, spentCents, effectiveFrom: m, changed }],
          otherCents: 123456789,
          uncategorisedCents: -123456789,
          budgetCents,
          budgetedSpentCents: spentCents,
          spentCents,
        })
        await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(60, 'x'), about_contact: '', about_retention: '' } }))
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account with a long name'.padEnd(60, 'y'), accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
        await page.route('**/api/reports/budget-vs-actual?**', (route) =>
          route.fulfill({
            json: {
              from: '2026-08-15',
              to: '2026-10-31',
              covers: { from: '2026-08-01', to: '2026-10-31' },
              months: [month('2026-08', 'ended', 123456789, 123456790, false), month('2026-09', 'ended', 123456789, -123456789, true), month('2026-10', 'under-way', 123456789, 5, false)],
              together: { first: '2026-08', last: '2026-09', months: 2 },
              total: { budgetCents: 246913578, budgetedSpentCents: 1, spentCents: 1, otherCents: 246913578, uncategorisedCents: -246913578, budgetMonths: 2, overMonths: 1 },
              categories: [{ categoryId: 1, categoryName: long, months: 2, overMonths: 1, budgetCents: 246913578, spentCents: 1 }],
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/reports/budget-vs-actual?from=2026-08-15&to=2026-10-31')
        await chooseTextSize(page, size)
        const report = page.getByRole('article', { name: 'Budget vs actual' })
        await expect(report).toContainText('$1,234,567.89')
        await expect(report).toContainText('You chose')
        await expect(report).toContainText('$1,234,567.89 back')
        await expect(report).toContainText('Budget changed from September 2026')
        await expect(report).toContainText('August 2026 to September 2026, the 2 months that have ended')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The income-vs-spending-by-month Report with its longest content: a long app title and Account name, the largest amounts, Spending back, Income and a Difference
  // below zero, the notice about money in with no Category with a large amount in it, and months with sentences under their names (the dates cover only part of the
  // first, the second is not over, the third has not begun), on screen (cards on a narrow window). The data is stubbed, so the test needs nothing in the database.
  for (const { name, width, height } of zoomLevels) {
    for (const size of ['Medium', 'Large'] as const) {
      test(`/reports/income-vs-spending with long content at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
        await signInAs(context, 'member')
        await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(60, 'x'), about_contact: '', about_retention: '' } }))
        await page.route('**/api/accounts', (route) => route.fulfill({ json: [{ id: 1, name: 'Example account with a long name'.padEnd(60, 'y'), accountNumber: '99-9999-9999999-97', cutoverDate: null }] }))
        await page.route('**/api/reports/income-vs-spending?**', (route) =>
          route.fulfill({
            json: {
              from: '2026-09-15',
              to: '2026-11-10',
              months: [
                { month: '2026-09', state: 'ended', incomeCents: 123456789012, spendingCents: -123456789, differenceCents: 123580245801, uncategorisedInCents: 123456789012, counted: 3 },
                { month: '2026-10', state: 'under-way', incomeCents: -123456789012, spendingCents: 123456789012, differenceCents: -246913578024, uncategorisedInCents: 0, counted: 2 },
                { month: '2026-11', state: 'not-begun', incomeCents: 0, spendingCents: 0, differenceCents: 0, uncategorisedInCents: 0, counted: 0 },
              ],
              totals: { incomeCents: 0, spendingCents: 123333332223, differenceCents: -123333332223, uncategorisedInCents: 123456789012, counted: 5 },
            },
          }),
        )
        await page.setViewportSize({ width, height })
        await page.goto('/reports/income-vs-spending?from=2026-09-15&to=2026-11-10')
        await chooseTextSize(page, size)
        const report = page.getByRole('article', { name: 'Income vs spending by month' })
        await expect(report).toContainText('$1,234,567,890.12')
        await expect(report).toContainText('−$1,234,567,890.12')
        await expect(report).toContainText('$1,234,567.89 back')
        await expect(report).toContainText('−$2,469,135,780.24')
        await expect(report).toContainText('Difference (income less spending)') // the longest label
        await expect(report).toContainText('$1,234,567,890.12 of money in has no Category')
        await expect(report).toContainText('Counts only Tue 15 Sept 2026 to Wed 30 Sept 2026') // the longest sentence about a part month
        await expect(report).toContainText('This month is not over yet, so these are the figures so far.')
        await expect(report).toContainText('This month has not begun, so there is nothing to show yet.')
        // Measure only once the size is applied and the buttons have finished their width transition.
        await expectTextSize(page, size)
        await settle(page)
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
      })
    }
  }

  // The app title is at the top of the sidebar: on a phone, in its sheet. It wraps over as many lines as it needs rather than being cut short or scrolling sideways.
  for (const { name, width, height } of zoomLevels.slice(0, 2)) {
    test(`a very long app title wraps in the sidebar's sheet instead of scrolling sideways, at ${name}`, async ({ page }) => {
      await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(120, 'x'), about_contact: '', about_retention: '' } }))
      await page.setViewportSize({ width, height })
      await page.goto('/')
      await showSidebar(page)
      const title = sidebarTitle(page).getByText('Thexxx')
      await expect(title).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const sheet = (await page.locator('[data-slot="sidebar"][data-mobile="true"]').boundingBox())!
      const box = (await title.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width) // all of it is inside the sheet...
      expect(box.height).toBeGreaterThan(40) // ...over several lines, not cut short on one
    })
  }
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

  // A card's label and value sit side by side, the value taking the rest of the line, unless the value's narrowest form (a word, or an amount, that cannot be broken)
  // will not fit beside the label: then it goes under it, at any text size. Ordinary content at size A is as it always was; a value that cannot fit is what moves.
  test('keeps a card\'s label beside its value for ordinary content, and puts a value that cannot fit beside its label under it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/styleguide')
    const cards = page.getByRole('list', { name: 'Sample transactions' }).getByRole('listitem')
    await expect(cards).toHaveCount(3)
    /** For each label and value of each card: whether the value starts on the label's line. */
    const beside = () =>
      cards.evaluateAll((items) =>
        items.flatMap((item) =>
          Array.from(item.querySelectorAll('dl > div'), (row) => row.querySelector('dd')!.getBoundingClientRect().top < row.querySelector('dt')!.getBoundingClientRect().bottom - 1),
        ),
      )

    expect(await beside()).toEqual(Array(9).fill(true)) // three cards of a date, a description and an amount

    // A description with a word too wide to sit beside "Description" goes under it, and the page does not grow sideways.
    await cards.first().locator('dd').nth(1).evaluate((dd) => (dd.textContent = 'Example'.padEnd(60, 'x')))
    expect(await beside()).toEqual([true, false, true, true, true, true, true, true, true])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
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
    for (const size of ['Medium', 'Large'] as const) {
      await chooseTextSize(page, size)
      for (const selector of ['table', 'table th', 'table td']) {
        expect(await fontSize(page, selector)).toBeGreaterThanOrEqual(15)
      }
    }
  })

  // Small is a choice, and it makes everything 12.5% smaller, tables too (README, Accessibility): so the 15px promise is for Medium and Large. This holds a table's text at
  // Small to exactly that, 12.5% less than it is at Medium (13.125px), so Small scales it as it scales the page and does not make it smaller still.
  test('scales table text with the page at Small: 12.5% smaller than at Medium', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    for (const selector of ['table', 'table th', 'table td']) {
      await chooseTextSize(page, 'Medium')
      const medium = await fontSize(page, selector)
      await chooseTextSize(page, 'Small')
      expect(await fontSize(page, selector)).toBeCloseTo(medium * 0.875, 3)
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
      themeToggle(page).evaluate((el) => {
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
  test('still shows every status icon and word', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/styleguide')
    await expect(page.getByText('Needs attention', { exact: true })).toBeVisible()
    await expect(page.locator('svg[aria-hidden="true"]').first()).toBeVisible()
  })

  // Windows high contrast throws a div's background away, so the D1 usage bar's fill would vanish and leave an empty track. It asks for a system colour on
  // the fill (which is kept) and has a border on the track, so how full it is still shows.
  test("draws the D1 usage bar's fill in the text colour, apart from its track, and gives the track an edge", async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.route('**/api/features', (route) => route.fulfill({ json: { features: [{ id: 'd1-usage', name: 'D1 usage bar', enabled: true }] } }))
    await page.route('**/api/d1-usage', (route) =>
      route.fulfill({ json: { rowsRead: 2_750_000, rowsWritten: 4_321, readLimit: 5_000_000, writeLimit: 100_000, resetsAt: '2026-10-15T00:00:00.000Z' } }),
    )
    await page.goto('/rules')

    const bar = page.getByRole('progressbar', { name: 'Database rows read today' })
    await expect(bar).toBeVisible()
    const drawn = await bar.evaluate((track) => {
      const colour = (value: string) => {
        const probe = document.createElement('div')
        probe.style.backgroundColor = value
        document.body.append(probe)
        const computed = getComputedStyle(probe).backgroundColor
        probe.remove()
        return computed
      }
      const fill = getComputedStyle(track.querySelector('[data-slot="progress-indicator"]')!)
      const style = getComputedStyle(track)
      return { fill: fill.backgroundColor, track: style.backgroundColor, canvasText: colour('CanvasText'), edge: parseFloat(style.borderTopWidth), edgeStyle: style.borderTopStyle }
    })
    expect(drawn.fill).toBe(drawn.canvasText)
    expect(drawn.fill).not.toBe(drawn.track)
    expect(drawn.edge).toBeGreaterThan(0)
    expect(drawn.edgeStyle).toBe('solid')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Header

test.describe('header', () => {
  test('shows the app title from Settings in the sidebar, and uses it as the page title', async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: "Mum's finances", about_contact: '', about_retention: '' } }))
    await page.goto('/')
    await expect(sidebarTitle(page).getByText("Mum's finances")).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })

  test('says Fernledger until the Admin sets a title', async ({ page }) => {
    await page.goto('/')
    await expect(sidebarTitle(page).getByText('Fernledger', { exact: true })).toBeVisible()
    await expect(page).toHaveTitle('Fernledger')
  })

  // Sign out is in the header's bar from `md` up and in its menu below (src/components/site-header.tsx). On a narrow screen it must not be cut off at the edge or broken over two
  // lines. The 44px size is held by the touch-target tests, and the lack of sideways scrolling by the 320px header test above.
  for (const { width, size } of [
    { width: 375, size: 'Medium' },
    { width: 320, size: 'Large' },
  ] as const) {
    test(`Sign out stays whole and inside the screen at ${width}px and text size ${size}`, async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.setViewportSize({ width, height: 640 })
      await page.goto('/')
      await chooseTextSize(page, size)
      await expectTextSize(page, size)
      await openHeaderControls(page)
      await settle(page)
      const link = signOutLink(page)
      await expect(link).toBeVisible()
      const box = await link.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      const lines = await link.evaluate((element) => {
        // Its words, not its icon beside them.
        const words = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!
        const range = document.createRange()
        range.selectNodeContents(words)
        return range.getClientRects().length
      })
      expect(lines).toBe(1)
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Accessibility of the new building blocks at the largest text size

test('the examples page has no WCAG 2.2 AA violations at the largest text size', async ({ page }) => {
  await page.goto('/styleguide')
  await chooseTextSize(page, 'Large')
  await noAxeViolations(page) // right after the click: it waits for the size buttons to finish changing width
})
