import type { Page } from '@playwright/test'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { usageFigures, usageOn } from './rule-helpers'
import { expectTextSize, navigateTo, openHeaderControls, siteHeader, textSizeButton, textSizeGroup } from './shell-helpers'

// The Admin's free allowance bar, in the header on every page (src/components/allowance-bar.tsx): how much of today's free D1 allowance is left, of whichever of the rows read and the rows
// written has less. Local development has no Cloudflare token, so each test says the D1 usage bar is set up (`/api/features`) and answers the figures itself.

const WIDE = { width: 1500, height: 800 } // more than 82rem of header at every text size but the largest; the specs that go there set their own
const PHONE = { width: 390, height: 844 }
const PIXELS = { Medium: 16, 'Xtra Large': 20 } as const
const SAVED = { Medium: 'medium', 'Xtra Large': 'xlarge' } as const

async function stubAllowance(page: Page, figures: Record<string, unknown> = {}) {
  await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
  await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures(figures) }))
}

/** The bar in the header: a progressbar named for what it is, which its label is. */
const bar = (page: Page) => siteHeader(page).getByRole('progressbar', { name: 'Free allowance left today' })

const FIGURES_READ = 'Rows read today: 1,234,567 of 5,000,000'
const FIGURES_WRITTEN = 'Rows written today: 4,321 of 100,000'

test.describe('the Admin\'s header', () => {
  test('says how much of today is left, in one bar named for it, as an estimate, with no word while there is plenty', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page)
    await page.setViewportSize(WIDE)
    await page.goto('/reports')

    await expect(bar(page)).toBeVisible()
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '75') // 3,765,433 of the 5,000,000 rows read are left, and 95% of the rows written
    await expect(bar(page)).toHaveAttribute('aria-valuetext', `About 75% left. ${FIGURES_READ}. ${FIGURES_WRITTEN}. An estimate: Cloudflare runs a few minutes behind.`)
    await expect(siteHeader(page).getByText('Free allowance left today')).toBeVisible()
    await expect(siteHeader(page).getByText('about 75%')).toBeVisible() // "about": Cloudflare's figures run a few minutes behind
    await expect(siteHeader(page).locator('[data-slot="badge"]')).toHaveCount(0)
    await noAxeViolations(page)
  })

  test('is one bar, of whichever has less left: the rows written when they leave less than the rows read', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page, { rowsWritten: 60_000 })
    await page.setViewportSize(WIDE)
    await page.goto('/reports')

    await expect(bar(page)).toHaveAttribute('aria-valuenow', '40')
    await expect(siteHeader(page).getByText('about 40%')).toBeVisible()
    await expect(siteHeader(page).getByRole('progressbar')).toHaveCount(1)
    await expect(bar(page)).toHaveAttribute('aria-valuetext', /^About 40% left\. Rows read today: 1,234,567 of 5,000,000\. Rows written today: 60,000 of 100,000\./)
  })

  // Hover is not the only way: the bar is a tab stop, and both figures open on its focus too.
  test('has both figures on hover and on keyboard focus, and they close on Escape and when the pointer or focus leaves', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page)
    await page.setViewportSize(WIDE)
    await page.goto('/reports/income-vs-spending') // a page of Reports, whose group is a link
    const tooltip = page.getByRole('tooltip')
    const expectFigures = async () => {
      await expect(tooltip).toContainText(FIGURES_READ)
      await expect(tooltip).toContainText(FIGURES_WRITTEN)
      await expect(tooltip).toContainText('An estimate: Cloudflare runs a few minutes behind.')
      await expect(tooltip).toContainText('The allowance starts again on')
    }

    await bar(page).hover()
    await expectFigures()
    await page.mouse.move(5, 500, { steps: 5 }) // Radix closes a tooltip on the move after the pointer has left it, not on the leaving
    await expect(tooltip).toHaveCount(0)

    // The keyboard: the Reports link is the last tab stop before the bar.
    await siteHeader(page).getByRole('link', { name: 'Reports' }).focus()
    await page.keyboard.press('Tab')
    await expect(bar(page)).toBeFocused()
    await expectFigures()
    expect(await bar(page).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid') // focus is drawn
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await page.keyboard.press('Tab')
    await expect(textSizeButton(page, 'Medium')).toBeFocused() // not a trap, and on to the controls
    await expect(tooltip).toHaveCount(0)
  })

  // The words are there as well as the colour: Low below 20% left (amber), Almost used below 5% (red), nothing at 20% and over. The fill is the theme's own colour for it.
  for (const { left, figures, word, token } of [
    { left: 20, figures: { rowsRead: 4_000_000 }, word: null, token: 'success' },
    { left: 19, figures: { rowsRead: 4_000_001 }, word: 'Low', token: 'warning' }, // 19.99998% is left: rounded down, so it is never shown as more than is left, and is Low
    { left: 5, figures: { rowsRead: 4_750_000 }, word: 'Low', token: 'warning' },
    { left: 4, figures: { rowsRead: 4_750_001 }, word: 'Almost used', token: 'danger' }, // 4.99998%
    { left: 0, figures: { rowsRead: 5_100_000 }, word: 'Almost used', token: 'danger' },
  ] as const) {
    test(`at ${left}% left says ${word ?? 'nothing'}, and the bar is the ${token} colour`, { tag: '@theme' }, async ({ page, context }) => {
      await signInAs(context, 'admin')
      await stubAllowance(page, figures)
      await page.setViewportSize(WIDE)
      await page.goto('/reports')

      await expect(bar(page)).toHaveAttribute('aria-valuenow', String(left))
      await expect(siteHeader(page).getByText(`about ${left}%`)).toBeVisible()
      if (word) {
        await expect(siteHeader(page).locator('[data-slot="badge"]')).toHaveText(word)
        await expect(bar(page)).toHaveAttribute('aria-valuetext', new RegExp(`^About ${left}% left, ${word}\\. `)) // said to a screen reader as well
      } else {
        await expect(siteHeader(page).locator('[data-slot="badge"]')).toHaveCount(0)
      }
      const painted = await page.evaluate((name) => {
        const probe = document.createElement('div')
        probe.style.backgroundColor = `var(--${name})`
        document.body.append(probe)
        const colour = getComputedStyle(probe).backgroundColor
        probe.remove()
        return { token: colour, fill: getComputedStyle(document.querySelector('header [data-slot="progress-indicator"]')!).backgroundColor }
      }, token)
      expect(painted.fill).toBe(painted.token)
    })
  }

  // Windows high contrast throws a div's background away: the fill asks for a system colour (which is kept) and the track has an edge, so how full it is still shows, and the word has its own edge.
  test('draws the fill in the text colour in Windows high contrast, with an edge on the track and on the word', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await stubAllowance(page, { rowsRead: 4_100_000 })
    await page.setViewportSize(WIDE)
    await page.goto('/reports')
    await expect(bar(page)).toBeVisible()
    const drawn = await page.evaluate(() => {
      const header = document.querySelector('header')!
      const colour = (value: string) => {
        const probe = document.createElement('div')
        probe.style.backgroundColor = value
        document.body.append(probe)
        const computed = getComputedStyle(probe).backgroundColor
        probe.remove()
        return computed
      }
      const track = getComputedStyle(header.querySelector('[data-slot="progress-track"]')!)
      const word = getComputedStyle(header.querySelector('[data-slot="badge"]')!)
      return {
        fill: getComputedStyle(header.querySelector('[data-slot="progress-indicator"]')!).backgroundColor,
        canvasText: colour('CanvasText'),
        trackEdge: [parseFloat(track.borderTopWidth), track.borderTopStyle],
        wordEdge: [parseFloat(word.borderTopWidth), word.borderTopStyle],
      }
    })
    expect(drawn.fill).toBe(drawn.canvasText)
    expect(drawn.trackEdge).toEqual([expect.any(Number), 'solid'])
    expect(drawn.trackEdge[0]).toBeGreaterThan(0)
    expect(drawn.wordEdge[1]).toBe('solid')
    expect(drawn.wordEdge[0]).toBeGreaterThan(0)
  })

  test.describe('when the figures cannot be had', () => {
    test.use({ expectedStatuses: [502] })

    test('says "Allowance unknown", quietly: no bar, no alert, nothing announced, and the page works', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
      await page.route('**/api/d1-usage', (route) => route.fulfill({ status: 502, json: { error: 'Usage unavailable', reason: 'unreachable' } }))
      await page.setViewportSize(WIDE)
      await page.goto('/reports')

      await expect(siteHeader(page).getByText('Allowance unknown')).toBeVisible()
      await expect(siteHeader(page).getByRole('progressbar')).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(siteHeader(page).getByRole('status')).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
      await noAxeViolations(page)
    })

    test('says so again, not the figures from before, when a reading fails after one that worked, and the next reading brings them back', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
      let asked = 0
      await page.route('**/api/d1-usage', (route) => (asked++ === 1 ? route.fulfill({ status: 502, json: { error: 'Usage unavailable', reason: 'unreachable' } }) : route.fulfill({ json: usageFigures() })))
      await page.clock.install({ time: new Date('2026-10-11T02:00:00Z') })
      await page.setViewportSize(WIDE)
      await page.goto('/reports')
      await expect(bar(page)).toBeVisible()

      await page.clock.runFor(5 * 60_000)
      await expect(siteHeader(page).getByText('Allowance unknown')).toBeVisible()
      await expect(siteHeader(page).getByRole('progressbar')).toHaveCount(0)
      await page.clock.runFor(5 * 60_000)
      await expect(bar(page)).toBeVisible()
      await expect(siteHeader(page).getByText('Allowance unknown')).toHaveCount(0)
    })
  })

  test('is not there for a Member, nor while the D1 usage bar is not set up, and asks for no figures then', async ({ page, context }) => {
    const asked: string[] = []
    page.on('request', (request) => request.url().includes('/api/d1-usage') && asked.push(request.url()))
    await page.setViewportSize(WIDE)

    // The Admin of a Fernledger that has not set it up (as local development has not): nothing is shown, and nothing is asked.
    await signInAs(context, 'admin')
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(siteHeader(page).getByText('Free allowance left today')).toHaveCount(0)
    await expect(siteHeader(page).getByText('Allowance unknown')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])

    // A Member, whatever `/api/features` says of it: the Worker would refuse them anyway, and the header never asks.
    await stubAllowance(page)
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(siteHeader(page).getByText('Free allowance left today')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])
  })

  // The figures are read as the page loads, every five minutes while the window is in view and when it is used again after a minute: not on every page, and not with a timer of its own
  // that a background tab would keep running (the browser's own pause of it is not tested here).
  test('reads the figures as the page loads, every five minutes, and when the window is used again after a minute, and not from page to page', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
    let asked = 0
    await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures({ rowsRead: 1_000_000 + 500_000 * asked++ }) }))
    await page.clock.install({ time: new Date('2026-10-11T02:00:00Z') })
    await page.setViewportSize(WIDE)
    await page.goto('/reports')
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '80') // 4,000,000 of 5,000,000 left
    expect(asked).toBe(1)

    // Going to other pages asks for nothing: the header stays.
    await navigateTo(page, 'Net worth', 'Reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Net worth' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(asked).toBe(1)

    await page.clock.runFor(4 * 60_000 + 50_000)
    await page.waitForLoadState('networkidle')
    expect(asked).toBe(1) // not yet five minutes
    await page.clock.runFor(10_000)
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '70') // the second reading
    expect(asked).toBe(2)

    // The window is used again: not within a minute of the last reading, and after one.
    const windowUsedAgain = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await page.clock.runFor(30_000)
    await windowUsedAgain()
    await page.waitForLoadState('networkidle')
    expect(asked).toBe(2)
    await page.clock.runFor(31_000)
    await windowUsedAgain()
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '60') // the third
    expect(asked).toBe(3)
  })

  // The header is one menu on a phone, and the bar is in it with both figures written out (a touch screen has no hover).
  test('is in the header\'s menu on a phone, with both figures written under it', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page, { rowsRead: 4_100_000 })
    await page.setViewportSize(PHONE)
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(siteHeader(page).getByRole('progressbar')).toHaveCount(0) // not in the bar of the header...

    await openHeaderControls(page) // ...but in its menu
    const menu = page.locator('[data-slot="popover-content"]')
    const inMenu = menu.getByRole('progressbar', { name: 'Free allowance left today' })
    await expect(inMenu).toBeVisible()
    await expect(inMenu).toHaveAttribute('aria-valuenow', '18')
    await expect(menu.getByText('about 18%')).toBeVisible()
    await expect(menu.locator('[data-slot="badge"]')).toHaveText('Low')
    await expect(menu.getByText('Rows read today: 4,100,000 of 5,000,000')).toBeVisible()
    await expect(menu.getByText(FIGURES_WRITTEN)).toBeVisible()
    await expect(menu.getByText('An estimate: Cloudflare runs a few minutes behind.')).toBeVisible()
    await settle(page)
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
    await noAxeViolations(page)
  })

  // The bar needs room, so the controls fold into the menu sooner than the 56rem the other pages have: 82rem, where the widest it gets (Almost used, on the longest page name) still leaves the
  // page's name whole. A window that is narrower has the bar in the menu.
  for (const size of ['Medium', 'Xtra Large'] as const) {
    test(`keeps the page name whole: the bar and the controls are in the bar from 82rem wide and in the menu below it, at ${size}`, async ({ page, context }) => {
      await signInAs(context, 'admin')
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['fernledger-text-size-v2', SAVED[size]])
      await stubAllowance(page, { rowsRead: 4_900_000, rowsWritten: 99_000 }) // "about 1%" and Almost used: the widest
      const edge = 82 * PIXELS[size]
      const menuButton = siteHeader(page).getByRole('button', { name: 'Display settings and sign out' })
      const pageName = siteHeader(page).locator('[aria-current="page"]')
      const expectNameWhole = async (what: string) => {
        await expect(pageName).toHaveText('Income vs spending by month')
        expect(await pageName.evaluate((el) => el.scrollWidth <= el.clientWidth), `${what}: the page's name is cut short`).toBe(true)
      }

      await page.setViewportSize({ width: edge + 20, height: 800 }) // a scrollbar's width wider than the bar it holds, and 20px clears it
      await page.goto('/reports/income-vs-spending')
      await expectTextSize(page, size)
      await settle(page)
      await expect(bar(page)).toBeVisible()
      await expect(textSizeGroup(page)).toBeVisible()
      await expect(menuButton).toBeHidden()
      await expectNameWhole('in the bar')

      await page.setViewportSize({ width: edge - 20, height: 800 })
      await settle(page)
      await expect(bar(page)).toBeHidden()
      await expect(textSizeGroup(page)).toBeHidden()
      await expect(menuButton).toBeVisible()
      await expectNameWhole('in the menu')
      await openHeaderControls(page)
      await expect(page.locator('[data-slot="popover-content"]').getByRole('progressbar', { name: 'Free allowance left today' })).toBeVisible()
    })
  }
})
