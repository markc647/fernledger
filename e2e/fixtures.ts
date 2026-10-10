import { expect, test as base, type BrowserContext } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'

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

export { expect }
