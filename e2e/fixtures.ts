import { expect, test as base } from '@playwright/test'

/**
 * Every test fails on any console error, uncaught error or Content-Security-Policy violation, so the UI is proven
 * to work under the real headers (public/_headers for assets, the Worker for /api) and not only in a dev server.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const problems: string[] = []
    page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`))
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
