import type { Page } from '@playwright/test'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { stubPaidPlan, usageFigures, usageOn } from './rule-helpers'
import type { D1Usage } from '../src/generated/api/d1-usage'
import { expectTextSize, navigateTo, openHeaderControls, siteHeader, textSizeButton, textSizeGroup } from './shell-helpers'

// The Admin's free allowance bar, in the header on every page (src/components/allowance-bar.tsx): how much of today's free D1 allowance is left, of whichever of the rows read and the rows
// written has gone further, with the Rules page's words and colours for the same figures (src/lib/d1-usage.ts). Local development has no Cloudflare token, so each test says the D1 usage bar
// is set up (`/api/features`) and answers the figures itself.

// The header has the bar, with the controls, from 66rem of it (the controls alone fold into the menu at 56rem, e2e/display.spec.ts), and writes the bar's words out from 86rem.
const WIDE = { width: 1500, height: 800 } // the words written out, at every text size but the largest
const COMPACT = { width: 1100, height: 800 } // the bar and its value
const PHONE = { width: 390, height: 844 }
const PIXELS = { Medium: 16, 'Xtra Large': 20 } as const
const SAVED = { Medium: 'medium', 'Xtra Large': 'xlarge' } as const

async function stubAllowance(page: Page, figures: Partial<D1Usage> = {}) {
  await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
  await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures(figures) }))
}

const LABEL = 'Free allowance left today'

/** The bar in the header: a progressbar named for what it is, which its label is (written out or not). */
const bar = (page: Page) => siteHeader(page).getByRole('progressbar', { name: LABEL })

/** Whether the words are written out beside the bar: its label is there for a screen reader either way, and is clipped to a pixel when there is no room. */
const writtenOut = (page: Page) => siteHeader(page).getByText(LABEL).evaluate((label) => label.getBoundingClientRect().width > 2)

const FIGURES_READ = 'Rows read today: 1,234,567 of 5,000,000'
const FIGURES_WRITTEN = 'Rows written today: 4,321 of 100,000'

test.describe("the Admin's header", () => {
  test('has no bar on the Paid Plan, which has no daily allowance to have left (ADR 0018)', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page)
    await stubPaidPlan(page)
    await page.setViewportSize(WIDE)
    const paid = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/settings')
    await page.goto('/reports')
    await paid // the header knows the plan
    await expect(textSizeGroup(page)).toBeVisible()
    await expect(bar(page)).toHaveCount(0)
    await expect(siteHeader(page).getByText(LABEL)).toHaveCount(0)

    // The same header on the Free Plan has it, so it is the plan that took it away.
    await page.unroute('**/api/settings')
    await page.reload()
    await expect(bar(page)).toBeVisible()
  })

  test('says how much of today is left, in one bar named for it, as an estimate, and with the word the Rules page has for it, Plenty left', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page)
    await page.setViewportSize(WIDE)
    await page.goto('/reports')

    await expect(bar(page)).toBeVisible()
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '75') // 3,765,433 of the 5,000,000 rows read are left, and 95% of the rows written
    await expect(bar(page)).toHaveAttribute('aria-valuetext', `About 75% left, Plenty left. ${FIGURES_READ}. ${FIGURES_WRITTEN}. An estimate: Cloudflare runs a few minutes behind.`)
    await expect(siteHeader(page).getByText(LABEL)).toBeVisible()
    await expect(siteHeader(page).getByText('about 75%')).toBeVisible() // "about": Cloudflare's figures run a few minutes behind
    await expect(siteHeader(page).locator('[data-slot="badge"]')).toHaveText('Plenty left')
    await noAxeViolations(page)
  })

  test('is one bar, of whichever has gone further: the rows written when they have, and says what the Rules page says of those figures', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page, { rowsWritten: 60_000 })
    await page.setViewportSize(WIDE)
    await page.goto('/reports')
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '40')
    await expect(siteHeader(page).getByText('about 40%')).toBeVisible()
    await expect(siteHeader(page).getByRole('progressbar')).toHaveCount(1)
    await expect(bar(page)).toHaveAttribute('aria-valuetext', /^About 40% left, Plenty left\. Rows read today: 1,234,567 of 5,000,000\. Rows written today: 60,000 of 100,000\./)
  })

  // Compact, where the controls are in the bar too: the bar and its value, and the words that are its name are its accessible name and the first line of its tooltip.
  test('is the bar and its value from 66rem, with its name for a screen reader and in its tooltip, and the text size, theme and Sign out beside it', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page, { rowsRead: 3_750_000 }) // Running low
    await page.setViewportSize(COMPACT)
    await page.goto('/reports/income-vs-spending')

    await expect(bar(page)).toBeVisible() // named, though the words are not written out
    expect(await writtenOut(page)).toBe(false)
    await expect(siteHeader(page).getByText('about 25%')).toBeVisible()
    await expect(siteHeader(page).locator('[data-slot="badge"]')).toBeHidden() // no room for the word: a shape beside the value says it is going, and the value text says it in words
    await expect(siteHeader(page).locator('[data-slot="progress-value"] svg')).toBeVisible() // none while there is plenty: see the next test
    await expect(bar(page)).toHaveAttribute('aria-valuetext', /^About 25% left, Running low\. /)
    await expect(textSizeGroup(page)).toBeVisible()
    await expect(siteHeader(page).getByRole('link', { name: 'Sign out' })).toBeVisible()
    await bar(page).focus()
    await expect(page.getByRole('tooltip')).toContainText(LABEL)
    await expect(page.getByRole('tooltip')).toContainText('Rows read today: 3,750,000 of 5,000,000')
    await noAxeViolations(page)
  })

  // Hover is not the only way: the bar is a tab stop, and both figures open on its focus too.
  test('has both figures on hover and on keyboard focus, and they close on Escape and when the pointer or focus leaves', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page)
    await page.setViewportSize(WIDE)
    await page.goto('/reports/income-vs-spending') // a page of Reports, whose group is a link
    const tooltip = page.getByRole('tooltip')
    const expectFigures = async () => {
      await expect(tooltip).toContainText(LABEL)
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
    await expect(textSizeButton(page, 'Small')).toBeFocused() // not a trap, and on to the controls
    await expect(tooltip).toHaveCount(0)
  })

  // A touch screen has no hover, and a tap does not focus a tooltip open: a tap opens it, a tap elsewhere shuts it, and the bar is a target of 44px.
  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true })

    test('has a target of at least 44px, and a tap opens both figures and a tap elsewhere shuts them', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await stubAllowance(page)
      await page.setViewportSize(WIDE)
      await page.goto('/reports')
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      const box = (await bar(page).boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)

      const tooltip = page.getByRole('tooltip')
      await expect(tooltip).toHaveCount(0)
      await bar(page).tap()
      await expect(tooltip).toContainText(FIGURES_READ)
      await expect(tooltip).toContainText(FIGURES_WRITTEN)
      await page.getByRole('heading', { level: 1, name: 'Reports' }).tap()
      await expect(tooltip).toHaveCount(0)
    })
  })

  // The words are there as well as the colour. The scale is the Rules page's (src/lib/d1-usage.ts): amber (Running low) from 70% used, which is 30% left, red (Almost used) from 85% used, which
  // is 15% left, and Used up only when the allowance has been reached; the percentage is rounded down, so 0% is not Used up. The fill is the theme's own colour for it.
  for (const { left, figures, word, token } of [
    { left: 30, figures: { rowsRead: 3_499_999 }, word: 'Plenty left', token: 'success' }, // 30.00002% is left: not yet 70% used
    { left: 30, figures: { rowsRead: 3_500_000 }, word: 'Running low', token: 'warning' },
    { left: 15, figures: { rowsRead: 4_249_999 }, word: 'Running low', token: 'warning' },
    { left: 15, figures: { rowsRead: 4_250_000 }, word: 'Almost used', token: 'danger' },
    { left: 0, figures: { rowsRead: 4_999_999 }, word: 'Almost used', token: 'danger' }, // 0% is shown, and it is not used up
    { left: 0, figures: { rowsRead: 5_100_000 }, word: 'Used up', token: 'danger' },
    { left: 0, figures: { rowsWritten: 100_000 }, word: 'Used up', token: 'danger' },
  ] as const) {
    test(`at ${left}% left with ${JSON.stringify(figures)} says ${word}, and the bar is the ${token} colour`, { tag: '@theme' }, async ({ page, context }) => {
      await signInAs(context, 'admin')
      await stubAllowance(page, figures)
      await page.setViewportSize(WIDE)
      await page.goto('/reports')

      await expect(bar(page)).toHaveAttribute('aria-valuenow', String(left))
      await expect(siteHeader(page).getByText(`about ${left}%`)).toBeVisible()
      await expect(siteHeader(page).locator('[data-slot="badge"]')).toHaveText(word)
      await expect(bar(page)).toHaveAttribute('aria-valuetext', new RegExp(`^About ${left}% left, ${word}\\. `)) // said to a screen reader as well
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
    await expect(siteHeader(page).getByText(LABEL)).toHaveCount(0)
    await expect(siteHeader(page).getByText('Allowance unknown')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])

    // A Member, whatever `/api/features` says of it: the Worker would refuse them anyway, and the header never asks.
    await stubAllowance(page)
    await signInAs(context, 'member')
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(siteHeader(page).getByText(LABEL)).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])
  })

  // The figures are read as the page loads and every five minutes while the window is in view, and when the window comes back into view if the last reading is five minutes old: not on every
  // page, and not in a background tab (which asks for nothing, and is brought up to date when it is used again). So an open window asks about 12 times an hour, at the most.
  test('reads the figures as the page loads, every five minutes, and when a window that was out of view is used again, and not from page to page', async ({ page, context }) => {
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

    // Using the window again (it was in view all along): not five minutes since the last reading, so nothing is asked. That is what keeps a window that is used a lot to about 12 an hour.
    const visibility = (state: 'visible' | 'hidden') =>
      page.evaluate((now) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => now })
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
      }, state)
    await page.clock.runFor(60_000)
    await visibility('visible')
    await page.waitForLoadState('networkidle')
    expect(asked).toBe(2)

    // A window that is out of view asks for nothing, however long it is, and is brought up to date when it is used again: one reading, and not one for each interval that passed.
    await visibility('hidden')
    await page.clock.runFor(12 * 60_000)
    await page.waitForLoadState('networkidle')
    expect(asked).toBe(2)
    await visibility('visible')
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '60') // the third
    expect(asked).toBe(3)
  })

  // The header is one menu on a phone, and the bar is in it with its words and both figures written out (a touch screen has no hover).
  test("is in the header's menu on a phone, with its words and both figures written under it", async ({ page, context }) => {
    await signInAs(context, 'admin')
    await stubAllowance(page, { rowsRead: 4_100_000 })
    await page.setViewportSize(PHONE)
    await page.goto('/reports')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(siteHeader(page).getByRole('progressbar')).toHaveCount(0) // not in the bar of the header...

    await openHeaderControls(page) // ...but in its menu
    const menu = page.locator('[data-slot="popover-content"]')
    const inMenu = menu.getByRole('progressbar', { name: LABEL })
    await expect(inMenu).toBeVisible()
    await expect(inMenu).toHaveAttribute('aria-valuenow', '18')
    await expect(menu.getByText(LABEL)).toBeVisible()
    await expect(menu.getByText('about 18%')).toBeVisible()
    await expect(menu.locator('[data-slot="badge"]')).toHaveText('Running low')
    await expect(menu.getByText('Rows read today: 4,100,000 of 5,000,000')).toBeVisible()
    await expect(menu.getByText(FIGURES_WRITTEN)).toBeVisible()
    await expect(menu.getByText('An estimate: Cloudflare runs a few minutes behind.')).toBeVisible()
    await settle(page)
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
    await noAxeViolations(page)
  })

  // The bar needs room, so with it the controls fold into the menu at 66rem and not 56rem (the page's name has no room to spare at 56), and its words are written out from 86rem. At each edge
  // the page's name is whole, and has room to spare besides: a font that is a little wider than this one (another system's) must not be what cuts it short. The widest each form gets is
  // tried: "about 30%" with a shape and "about 30%" with Running low (a long word), and "about 100%" with Plenty left.
  for (const size of ['Medium', 'Xtra Large'] as const) {
    for (const { state, figures } of [
      { state: 'Running low', figures: { rowsRead: 3_500_000, rowsWritten: 0 } },
      { state: 'Plenty left', figures: { rowsRead: 0, rowsWritten: 0 } },
    ]) {
      test(`keeps the page name whole, with room to spare, at ${state}: the bar and the controls are in the bar from 66rem wide and in the menu below it, and its words are written out from 86rem, at ${size}`, async ({ page, context }) => {
        await signInAs(context, 'admin')
        await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['fernledger-text-size-v2', SAVED[size]])
        await stubAllowance(page, figures)
        const px = PIXELS[size]
        const menuButton = siteHeader(page).getByRole('button', { name: 'Display settings and sign out' })
        const pageName = siteHeader(page).locator('[aria-current="page"]')
        // Whole, and with at least 2rem between the end of its words and what is beside it.
        const expectNameWhole = async (what: string) => {
          await expect(pageName).toHaveText('Income vs spending by month')
          expect(await pageName.evaluate((el) => el.scrollWidth <= el.clientWidth), `${what}: the page's name is cut short`).toBe(true)
          const spare = await page.evaluate(() => {
            const name = document.querySelector('header [aria-current="page"]')!
            const range = document.createRange()
            range.selectNodeContents(name)
            const cluster = [...document.querySelectorAll('header .ms-auto')].find((element) => element.getBoundingClientRect().width > 0) // the controls, or the menu button
            return cluster ? cluster.getBoundingClientRect().left - range.getBoundingClientRect().right - 8 : Number.POSITIVE_INFINITY // 8: the gap between them
          })
          expect(spare, `${what}: the room left beside the page's name`).toBeGreaterThanOrEqual(2 * px)
        }

        // A scrollbar's width wider than the bar it holds, and 20px clears it.
        await page.setViewportSize({ width: 86 * px + 20, height: 800 })
        await page.goto('/reports/income-vs-spending')
        await expectTextSize(page, size)
        await settle(page)
        await expect(bar(page)).toBeVisible()
        expect(await writtenOut(page)).toBe(true)
        await expect(siteHeader(page).locator('[data-slot="badge"]')).toHaveText(state)
        await expect(textSizeGroup(page)).toBeVisible()
        await expect(menuButton).toBeHidden()
        await expectNameWhole('with its words written out')

        await page.setViewportSize({ width: 86 * px - 20, height: 800 })
        await settle(page)
        await expect(bar(page)).toBeVisible()
        expect(await writtenOut(page)).toBe(false) // the words are still its name
        await expect(siteHeader(page).locator('[data-slot="badge"]')).toBeHidden()
        await expect(textSizeGroup(page)).toBeVisible()
        await expect(menuButton).toBeHidden()
        await expectNameWhole('compact')

        await page.setViewportSize({ width: 66 * px + 20, height: 800 })
        await settle(page)
        await expect(bar(page)).toBeVisible()
        await expect(textSizeGroup(page)).toBeVisible()
        await expectNameWhole('compact, at the edge')

        await page.setViewportSize({ width: 66 * px - 20, height: 800 })
        await settle(page)
        await expect(bar(page)).toBeHidden()
        await expect(textSizeGroup(page)).toBeHidden()
        await expect(menuButton).toBeVisible()
        await expectNameWhole('in the menu')
        await openHeaderControls(page)
        await expect(page.locator('[data-slot="popover-content"]').getByRole('progressbar', { name: LABEL })).toBeVisible()
      })
    }
  }
})
