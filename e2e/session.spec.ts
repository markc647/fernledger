import type { Route } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { navigateTo } from './shell-helpers'

// Cloudflare Access's session ends after the length the Admin chose (24 hours, docs/setup.md). After that, Access answers every request for the app's host, API calls included,
// with a 302 to its sign-in page on the team's own domain, and says not to keep it. The page's Content Security Policy (connect-src 'self') would refuse to follow it, and Chrome
// reports that as an error, so the page asks not to follow any redirect and reads one as "your sign-in has expired" (src/lib/session.ts). Local development has no Access, so these
// tests make the answer themselves.
const ACCESS_SIGN_IN = 'https://example.cloudflareaccess.com/cdn-cgi/access/login/localhost?kid=0123abcd&meta=made-up&redirect_url=%2Fapi%2Fme'
const accessRedirect = (route: Route) => route.fulfill({ status: 302, headers: { Location: ACCESS_SIGN_IN, 'Cache-Control': 'private, no-store' } })
const refused = (route: Route) => route.fulfill({ status: 401, json: { error: 'Unauthorised' } })

test.describe('when the Access session has run out', () => {
  test('the first thing the page asks is answered by Access: it says the sign-in has expired, and Access\'s page is never fetched', async ({ page }) => {
    const fetched: string[] = []
    await page.route('https://example.cloudflareaccess.com/**', (route) => {
      fetched.push(route.request().url())
      return route.abort()
    })
    await page.route('**/api/me', accessRedirect)
    await page.goto('/')

    const heading = page.getByRole('heading', { level: 1, name: 'Your sign-in has expired' })
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused() // the page has been replaced: a screen reader is told
    await expect(page.getByRole('main')).toContainText('Fernledger asks you to sign in again after a while, usually every day')
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Not signed in' })).toHaveCount(0)
    expect(fetched).toEqual([]) // an error in the console, which the fixture also fails the test for, would be the page following it
    await noAxeViolations(page)
  })

  test('Sign in again loads this same page afresh, with a new value on its address that is gone once the page is back', async ({ page }) => {
    let expired = true
    await page.route('**/api/me', (route) => (expired ? accessRedirect(route) : route.fallback()))
    await page.goto('/transactions?q=EXAMPLE%20SHOP&sort=amount')
    await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in has expired' })).toBeVisible()
    expired = false // by the time the page is asked for again, Access has the visitor's new sign-in

    const navigation = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).searchParams.has('_signin'))
    await page.getByRole('button', { name: 'Sign in again' }).click()
    const request = await navigation
    const asked = new URL(request.url())
    expect(request.method()).toBe('GET')
    expect(request.resourceType()).toBe('document') // the whole page, which Access answers, and not a fetch
    expect(asked.pathname).toBe('/transactions')
    expect([...asked.searchParams.keys()]).toEqual(['q', 'sort', '_signin'])
    expect(asked.searchParams.get('q')).toBe('EXAMPLE SHOP')
    expect(asked.search).toContain('q=EXAMPLE%20SHOP&sort=amount&') // the rest as it was written

    // Back in the app, on the page it was on, and its address is the one the visitor had.
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Your sign-in has expired' })).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).search).toBe('?q=EXAMPLE%20SHOP&sort=amount')
  })

  test('a sign-in that runs out while a page is open is said to have expired when a save meets Access, not as a failed save', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/settings', (route) => (route.request().method() === 'PATCH' ? accessRedirect(route) : route.fallback()))
    await page.goto('/settings')
    await page.getByLabel('App title').fill('Never saved')
    await page.getByRole('button', { name: 'Save settings' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in has expired' })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible()
    await expect(page.getByText('Settings saved')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0) // the page's own "could not save" is not what to tell
  })

  test('a page that is open and goes to another, which asks for its data, is told the same', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let expired = false
    await page.route('**/api/accounts', (route) => (expired ? accessRedirect(route) : route.fallback()))
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    expired = true
    await navigateTo(page, 'Accounts', 'Set up')
    await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in has expired' })).toBeVisible()
  })
})

// A 401 comes from the Worker itself: Access let the visitor in, and the Worker did not accept the token it sent (worker/auth.ts). Signing in again is no answer to that.
test.describe('when the Worker refuses the sign-in', () => {
  test.use({ expectedStatuses: [401, 500] })

  test('the first thing the page asks is refused: it says "Not signed in" and offers no way to sign in again', async ({ page }) => {
    await page.route('**/api/me', refused)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Not signed in' })).toBeVisible()
    await expect(page.getByRole('main')).toContainText('Sign in through your usual Fernledger link to see this page.')
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Your sign-in has expired' })).toHaveCount(0)
    await noAxeViolations(page)
  })

  test('a save that is refused while a page is open says "Not signed in" too', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.route('**/api/settings', (route) => (route.request().method() === 'PATCH' ? refused(route) : route.fallback()))
    await page.goto('/settings')
    await page.getByLabel('App title').fill('Never saved')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Not signed in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Your sign-in has expired' })).toHaveCount(0)
  })

  test('a server failure is still "Something went wrong"', async ({ page }) => {
    await page.route('**/api/me', (route) => route.fulfill({ status: 500, json: { error: 'stubbed' } }))
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0)
  })
})

// Access's redirect is answered for the page itself too, so the page the browser holds must be asked for every time, and not kept (public/_headers; scripts/security-headers.test.mjs
// reads the file). Back, Reload and a tab left open overnight then reach Access, and show its sign-in instead of an app with nothing behind it. A hashed file in /assets is a new
// address when it changes, so those are kept.
test('every page is stored by no browser, and the hashed files in /assets are kept for a year', async ({ page, request }) => {
  for (const path of ['/', '/index.html', '/transactions', '/reports/spending', '/settings']) {
    const response = await page.goto(path)
    expect(response?.headers()['cache-control'], path).toBe('no-store')
  }
  const script = await page.locator('script[type="module"][src^="/assets/"]').first().getAttribute('src')
  expect((await request.get(script!)).headers()['cache-control']).toBe('public, max-age=31536000, immutable')
})
