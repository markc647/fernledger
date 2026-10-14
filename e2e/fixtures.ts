import { AxeBuilder } from '@axe-core/playwright'
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'

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
 * `test.use({ expectedStatuses: [404] })`; any other failed request still fails it.
 */
export const test = base.extend<{ expectedStatuses: number[] }>({
  expectedStatuses: [[], { option: true }],
  page: async ({ page, expectedStatuses }, use) => {
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const failed = FAILED_REQUEST.exec(message.text())
      if (failed && expectedStatuses.includes(Number(failed[1]))) return
      problems.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`)
      })
    })
    await use(page)
    expect(problems).toEqual([])
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
 */
export async function noAxeViolations(page: Page) {
  const wasReduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    await settle(page)
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
    // Which element, not only how many, because a CI run keeps no trace to look at afterwards.
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
  } finally {
    await page.emulateMedia({ reducedMotion: wasReduced ? 'reduce' : 'no-preference' })
  }
}

export { expect }
