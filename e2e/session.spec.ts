import type { Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { accessRedirect } from './session-helpers'
import { navigateTo } from './shell-helpers'

// What the page says when the visitor's sign-in is not good (src/lib/session.ts, src/components/session-problem.tsx). Nothing loaded yet: the whole page says it, with a button that signs in
// again in this tab. Something has loaded: a banner over the page, which stays as it is, with a link that signs in again in a new tab, and which goes when a call works again.
const refused = (route: Parameters<typeof accessRedirect>[0]) => route.fulfill({ status: 401, json: { error: 'Unauthorised' } })

/** The banner over a page: an alert. */
const banner = (page: Page) => page.getByRole('alert').filter({ hasText: 'sign-in' })
const EXPIRED = 'Your sign-in has expired. Sign in again, then save again; nothing on this page has been lost.'

/** The window is used again, as the browser says it: queries that are stale ask once more. */
const windowUsedAgain = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))

test.describe('when the Access session has run out before anything has loaded', () => {
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

  // An address someone else wrote can have a path that begins with two slashes, which as an address to go to is another site's. Sign in again stays on this site.
  test('Sign in again stays on this site when the address begins with two slashes', async ({ page, baseURL }) => {
    await page.route('**/api/me', accessRedirect)
    await page.goto(`${baseURL}//evil.test/x`) // a path of two slashes on this host
    await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in has expired' })).toBeVisible()
    const navigation = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).searchParams.has('_signin'))
    await page.getByRole('button', { name: 'Sign in again' }).click()
    const asked = new URL((await navigation).url())
    expect(asked.origin).toBe(new URL(baseURL!).origin)
    expect(asked.pathname).toBe('/evil.test/x')
  })

  // A file of the app's own that Access answers with its redirect too: a page's code. The router reloads the page once when it cannot get a page's code, which is Access's own sign-in when the
  // session has run out; here the document is not Access's to answer, so the page loads, and finds out.
  test.describe('when the code of a page cannot be fetched', () => {
    test.use({ expectedConsoleErrors: ['Loading the script', 'CSP violation', 'Failed to fetch dynamically imported module'] })

    const failTheCodeOfAccounts = async (page: Page) => {
      let expired = false
      await page.route('**/api/me', (route) => (expired ? accessRedirect(route) : route.fallback()))
      await page.route(/\/assets\/accounts-[^/]*\.js$/, (route) => (expired ? accessRedirect(route) : route.fallback()))
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
      expired = true
      await navigateTo(page, 'Accounts', 'Set up')
    }

    test('is reloaded by the router once, and the page that comes back says the sign-in has expired', async ({ page, context }) => {
      await signInAs(context, 'admin')
      await failTheCodeOfAccounts(page)
      await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in has expired' })).toBeVisible()
    })

    test('asks who is signed in when the router does not reload, and the banner says the sign-in has expired over what the page could say', async ({ page, context }) => {
      await signInAs(context, 'admin')
      // The router reloads only once for a file it cannot get, and remembers it has in the tab: say it has.
      await page.addInitScript(() => {
        const getItem = Storage.prototype.getItem
        Storage.prototype.getItem = function (key) {
          return String(key).startsWith('tanstack_router_reload:') ? '1' : getItem.call(this, key)
        }
      })
      await failTheCodeOfAccounts(page)
      await expect(banner(page)).toContainText(EXPIRED)
      await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeVisible() // the page could not be drawn, and the banner says why
    })
  })
})

test.describe('when the Access session runs out while a page is open', () => {
  test('a save that meets Access leaves the page and what was typed in it, and the banner says to sign in again: in a new tab, which Save then does not lose', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let expired = false
    await page.route('**/api/settings', (route) => (expired && route.request().method() === 'PATCH' ? accessRedirect(route) : route.fallback()))
    await page.goto('/settings')
    await page.getByLabel('App title').fill('Typed, not yet saved')
    expired = true
    const save = page.getByRole('button', { name: 'Save settings' })
    await save.focus()
    await save.press('Enter')

    // The page is still there, with what was typed (and focus is not taken: the banner does not ask for it).
    await expect(banner(page)).toHaveText(new RegExp(`^${EXPIRED}`))
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(page.getByLabel('App title')).toHaveValue('Typed, not yet saved')
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alert"]') ?? null)).toBeNull()
    await expect(page.getByRole('heading', { name: 'Your sign-in has expired' })).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toHaveCount(0)

    // Sign in again opens Access's sign-in in a new tab, for this page's own address, so that nothing here is lost.
    const link = banner(page).getByRole('link', { name: 'Sign in again' })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener')
    const opened = context.waitForEvent('page')
    await link.click()
    const tab = await opened
    await tab.waitForLoadState()
    expect(new URL(tab.url()).origin).toBe(new URL(page.url()).origin)
    await expect(async () => expect(new URL(tab.url()).pathname).toBe('/settings')).toPass()
    await tab.close()

    // The banner stays in view under the header as the page is scrolled.
    expect(await banner(page).evaluate((element) => getComputedStyle(element).position)).toBe('sticky')

    // Signed in again, the same Save works, and the banner goes with the call that worked.
    expired = false
    await save.click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    await expect(banner(page)).toHaveCount(0)
    await page.getByLabel('App title').fill('Fernledger') // the title the other specs expect
    await save.click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
  })

  test('a read in the background raises the banner, and does not replace the page or move focus', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let expired = false
    await page.route('**/api/me', (route) => (expired ? accessRedirect(route) : route.fallback()))
    await page.goto('/settings')
    const title = page.getByLabel('App title')
    await title.fill('Being typed')
    await title.focus()
    expired = true
    await windowUsedAgain(page) // who is signed in is asked again, as it is when the window is used

    await expect(banner(page)).toContainText(EXPIRED)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(title).toHaveValue('Being typed')
    await expect(title).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
    await title.fill('Fernledger')
    expired = false
    await windowUsedAgain(page)
    await expect(banner(page)).toHaveCount(0) // who is signed in worked, and it clears
  })

  test('a page that is open and goes to another, which asks for its data, has the banner over that page', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let expired = false
    await page.route('**/api/accounts', (route) => (expired ? accessRedirect(route) : route.fallback()))
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    expired = true
    await navigateTo(page, 'Accounts', 'Set up')
    await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
    await expect(banner(page)).toContainText(EXPIRED)
  })

  test('the banner has no WCAG 2.2 AA violations', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let expired = false
    await page.route('**/api/me', (route) => (expired ? accessRedirect(route) : route.fallback()))
    await page.goto('/settings')
    await expect(page.getByLabel('App title')).toBeVisible()
    expired = true
    await windowUsedAgain(page)
    await expect(banner(page)).toBeVisible()
    await noAxeViolations(page)
  })
})

// A 401 comes from the Worker itself: Access let the visitor in, and the Worker did not accept the token it sent (worker/auth.ts). Signing in again is no answer to that.
test.describe('when the Worker refuses the sign-in', () => {
  test.use({ expectedStatuses: [401, 500] })

  test('the first thing the page asks is refused: it says "Not signed in", to reload, and offers no way to sign in again', async ({ page }) => {
    await page.route('**/api/me', refused)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Not signed in' })).toBeVisible()
    await expect(page.getByRole('main')).toContainText('Sign in through your usual Fernledger link to see this page.')
    await expect(page.getByRole('main')).toContainText('reload the page to try again')
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Your sign-in has expired' })).toHaveCount(0)
    await noAxeViolations(page)
  })

  test('a refusal while a page is open is a banner that says so, keeps the page, and goes with the next call that works', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let refuse = false
    await page.route('**/api/settings', (route) => (refuse && route.request().method() === 'PATCH' ? refused(route) : route.fallback()))
    await page.goto('/settings')
    await page.getByLabel('App title').fill('Typed, not yet saved')
    refuse = true
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Not signed in' })).toContainText('Reload the page to try again')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(page.getByLabel('App title')).toHaveValue('Typed, not yet saved')
    await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Your sign-in has expired' })).toHaveCount(0)

    refuse = false // a one-off does not stay
    await page.getByLabel('App title').fill('Fernledger')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Not signed in' })).toHaveCount(0)
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
