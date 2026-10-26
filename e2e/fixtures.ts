import { AxeBuilder } from '@axe-core/playwright'
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'
import type { D1Usage } from '../src/generated/api/d1-usage'

// A spec that creates Accounts uses numbers of its own (99-9999-9999999-NN), one set for each project, because the light and dark projects and every spec share one
// local database. Take unused NN from account-numbers.json and add them there: `npm run test:scripts` fails when two specs use the same one.

/** Signs in as the localhost dev identity for `role`. A cookie on `localhost` is shared by every port, so no port is needed here. */
export const signInAs = (context: BrowserContext, role: Role) =>
  context.addCookies([{ name: 'fernledger_dev_as', value: role, domain: 'localhost', path: '/' }])

// Chrome logs every failed request to the console as an error, whatever the page does with the answer.
const FAILED_REQUEST = /^Failed to load resource: the server responded with a status of (\d+)/

/**
 * Every test fails on any console error, uncaught error or Content-Security-Policy violation, so the UI is proven
 * to work under the real headers (public/_headers for assets, the Worker for /api) and not only in a dev server.
 * A test that expects a request to fail on purpose (a Transaction that doesn't exist) lists the status in
 * `test.use({ expectedStatuses: [404] })`; any other failed request still fails it. A 429 `member-busy` is expected anywhere: the Members' daily read limit lets a Member have only a
 * few dear requests in flight, so a Member's page that sends more together is told to wait its turn and asks again (src/lib/member-busy.ts), and the browser logs each. It is allowed
 * only as many times as the Worker answered so. A test that makes something fail on purpose in a way that is not a status (a script
 * that cannot be fetched, which the browser and React both log) lists what it expects in `expectedConsoleErrors`, as pieces of the message (strings, because Playwright reads an array whose second item is an object as a fixture's value and its options).
 */
export const test = base.extend<{ expectedStatuses: number[]; expectedConsoleErrors: string[] }>({
  expectedStatuses: [[], { option: true }],
  expectedConsoleErrors: [[], { option: true }],
  page: async ({ page, expectedStatuses, expectedConsoleErrors }, use) => {
    const problems: string[] = []
    const busyLogged: string[] = []
    const busyAnswers: Promise<boolean>[] = []
    page.on('response', (res) => {
      if (res.status() === 429) busyAnswers.push(res.json().then((body: { reason?: unknown }) => body.reason === 'member-busy', () => false))
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const failed = FAILED_REQUEST.exec(message.text())
      if (failed && expectedStatuses.includes(Number(failed[1]))) return
      if (failed?.[1] === '429') return void busyLogged.push(`console: ${message.text()}`)
      if (expectedConsoleErrors.some((expected) => message.text().includes(expected))) return
      problems.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
    // Local development has no Cloudflare token, so the D1 usage figures are never real here. A spec that says the D1 usage bar is set up (`/api/features`) makes the Admin's header ask for
    // them (src/components/allowance-bar.tsx), and gets these unless it answers for itself: a route added later is the one that is used.
    const usage: D1Usage = { rowsRead: 1_234_567, rowsWritten: 4_321, readLimit: 5_000_000, writeLimit: 100_000, resetsAt: '2026-10-15T00:00:00.000Z' }
    await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usage }))
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`)
      })
    })
    await use(page)
    const busy = (await Promise.all(busyAnswers)).filter(Boolean).length
    expect([...problems, ...busyLogged.slice(busy)]).toEqual([])
  },
})

/** Waits for the page's transitions and animations to finish, so what is measured is where things end up and not on the way (the sheet sliding in, a button changing colour). */
export const settle = (page: Page) => page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))

/** The WCAG 2.2 AA rule tags axe is asked for. */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/**
 * Axe on the page as it is, against WCAG 2.2 AA: the one check every spec calls. A button that has just been enabled is still fading in, and axe reads the colour it has at
 * that moment, which is not its colour: a transition runs in real time (a page's fake clock does not move it), and waiting for the running ones misses one React has yet to
 * start. So it emulates reduced motion (src/index.css makes every transition and animation near-instant under it), waits for what is running, and puts the setting back. The
 * emulation is for this check only: reduced motion left on broke the focus-outline and text-size tests, which look at a transition on its way. (It is put back to what the page
 * had, not to `null`, which Playwright accepts and does not apply to this media feature: the page stays reduced.)
 *
 * `within` is a selector for the part of the page to look at, for a state where the rest is not the reader's to use: while a menu of actions is open (Radix, modal) everything behind it is
 * `aria-hidden` and focus is held in the menu, but its focusable elements are still in the page, which axe reads as `aria-hidden-focus` whatever holds focus. The page is not moved for it:
 * a menu is beside its button, and goes off the screen with it.
 *
 * Without `within`, it looks from the top of the page, and not from where the reader happens to be scrolled to: part-way down a long list, the sticky header can be over most of a row's
 * button, and axe reads that button (44px, and fully there once the page moves) as a target under 24px (`target-size`, "partially obscured"), in whichever row the scroll leaves under the
 * header. It was once asked for page by page, and each new page with a list met the same failure first on CI.
 *
 * `color-contrast` is left out unless a scan asks for `contrast: true`, and every other rule always runs: see CODING_STANDARDS.md#tests.
 */
export async function noAxeViolations(page: Page, { within, contrast = false }: { within?: string; contrast?: boolean } = {}) {
  const wasReduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    if (!within) await page.evaluate(() => window.scrollTo(0, 0)) // before the wait, which is for what the move itself starts
    await settle(page)
    const axe = new AxeBuilder({ page }).withTags(WCAG)
    if (!contrast) axe.disableRules('color-contrast')
    if (within) axe.include(within)
    const { violations } = await axe.analyze()
    // Which element, not only how many, so the CI log says it without opening the trace.
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
  } finally {
    await page.emulateMedia({ reducedMotion: wasReduced ? 'reduce' : 'no-preference' })
  }
}

export { expect }
