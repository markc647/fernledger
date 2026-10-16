import type { Page } from '@playwright/test'
import { NET_WORTH_PATH, showNetWorth, SPENDING_REPORT_PATH, SPENT, spendingDrawn, stubNetWorth, stubSpendingReport } from './chart-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { changeDeviceScheme, mainNav, openHeaderControls, openNavGroup, signOutLink, themeToggle } from './shell-helpers'

const pages = [
  { role: 'admin', path: '/', heading: 'Dashboard' },
  { role: 'admin', path: '/settings', heading: 'Settings' },
  { role: 'member', path: '/', heading: 'Summary' },
  { role: 'member', path: '/styleguide', heading: 'Styleguide' },
  { role: 'member', path: NET_WORTH_PATH, heading: 'Net worth' },
  { role: 'admin', path: SPENDING_REPORT_PATH, heading: 'Spending by Category' },
] as const

const darkClass = (dark: boolean) => (dark ? /dark/ : /^(?!.*dark)/)

for (const { role, path, heading } of pages) {
  test(`${heading} page as ${role} has no WCAG 2.2 AA violations`, async ({ page, context }, testInfo) => {
    await signInAs(context, role)
    // The Net worth page and the Spending by Category Report are where the charts are, and the Worker refuses to add up net worth for more than 49 Accounts, which the specs that share
    // this database can reach. So the answers are stubbed and the charts drawn before the scan (net worth when its button is pressed), and it scans the pictures and not the refusal that a
    // long run of specs would put in their place.
    if (path === NET_WORTH_PATH) await stubNetWorth(page)
    if (path === SPENDING_REPORT_PATH) await stubSpendingReport(page, SPENT, 16_050)
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    if (path === NET_WORTH_PATH) await showNetWorth(page)
    if (path === SPENDING_REPORT_PATH) await spendingDrawn(page, /^Bar chart of the 3 Categories/)
    // The project's theme must really be showing, or the scan would not be testing it.
    await expect(page.locator('html')).toHaveClass(darkClass(testInfo.project.name === 'dark'))

    await noAxeViolations(page)
  })
}

test('the shared axe check emulates reduced motion for itself and leaves motion as it found it', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible()
  const reducedMotion = () => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  expect(await reducedMotion()).toBe(false)

  // Global reduced motion broke the focus-outline and text-size tests, which look at a transition on its way, so it must not outlast the check.
  const seen: boolean[] = []
  await page.exposeFunction('sawMotion', (reduced: boolean) => seen.push(reduced))
  await page.evaluate(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    query.addEventListener('change', () => (window as unknown as { sawMotion: (reduced: boolean) => void }).sawMotion(query.matches))
  })
  await noAxeViolations(page)

  expect(await reducedMotion()).toBe(false)
  await expect.poll(() => seen).toEqual([true, false]) // on for the check, then off again
})

test('pages and the API carry the security headers, and the built app is not the dev server', async ({ page, request }) => {
  const asset = await page.goto('/')
  expect(asset?.headers()['content-security-policy']).toContain("default-src 'none'")
  const api = await request.get('/api/me')
  expect(api.headers()['content-security-policy']).toContain("default-src 'none'")
  // Vite's dev server serves source modules; a production build has none.
  expect(await page.locator('script[src^="/src/"]').count()).toBe(0)
})

test('the Admin sees Settings in the navigation, a Member does not', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/')
  const nav = mainNav(page)
  await openNavGroup(page, 'Set up')
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()

  await signInAs(context, 'member')
  await page.reload()
  await expect(page.locator('[data-slot="sidebar-footer"]').getByText('Member (read-only)')).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Summary' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Set up' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0)
})

// Cloudflare Access's own sign-out path on the app's hostname (README, What it does). Access answers it before the Worker is reached, and local dev has no Access, so these tests
// prove the link and that pressing it makes the browser navigate there, never that anyone is signed out. The answer is stubbed: the dev Worker would send its single-page
// fallback, which is not what Access sends.
const SIGN_OUT_PATH = '/cdn-cgi/access/logout'
const stubSignOut = (page: Page) => page.route(`**${SIGN_OUT_PATH}`, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Stub for Access</title>' }))
const signOutNavigation = (page: Page) =>
  page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === SIGN_OUT_PATH)

for (const role of ['admin', 'member'] as const) {
  test(`the ${role} has a Sign out link in the header that goes to Access's logout path`, async ({ page, context }) => {
    await signInAs(context, role)
    await page.goto('/')
    const link = page.getByRole('banner').getByRole('link', { name: 'Sign out' })
    await expect(link).toBeVisible()
    // Relative, so it stays on the app's own hostname: no new host for the CSP or ADR 0010 to allow.
    await expect(link).toHaveAttribute('href', SIGN_OUT_PATH)
  })
}

test('Sign out is a full page navigation, not a fetch or a route of the app', async ({ page }) => {
  await stubSignOut(page)
  await page.goto('/')
  const navigation = signOutNavigation(page)
  await page.getByRole('banner').getByRole('link', { name: 'Sign out' }).click()
  const request = await navigation
  expect(request.method()).toBe('GET')
  expect(request.resourceType()).toBe('document')
  await expect(page).toHaveURL(new RegExp(`${SIGN_OUT_PATH}$`))
})

// Sign out needs no API data, so it is there when who is signed in can't be read: a 401 from a wrong ACCESS_AUD or team domain while an Access session is live,
// and a failing API. Those are the cases where someone needs it.
test.describe('when who is signed in cannot be read', () => {
  test.use({ expectedStatuses: [401, 500] })

  for (const { status, heading } of [
    { status: 401, heading: 'Not signed in' },
    { status: 500, heading: 'Something went wrong' },
  ]) {
    // In the header's bar, and on a phone in its menu.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      test(`the header still has Sign out on the "${heading}" page (${status}) at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.route('**/api/me', (route) => route.fulfill({ status, json: { error: 'stubbed' } }))
        await page.goto('/')
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
        await openHeaderControls(page)
        await expect(signOutLink(page)).toHaveAttribute('href', SIGN_OUT_PATH)
        await noAxeViolations(page)
      })
    }
  }
})

// The theme: one toggle. A first visit follows the device, and so does a device that changes while the page is open. Once the toggle has been used, the choice is the person's, on this device.
test.describe('the theme toggle', () => {
  test('follows the device until it is used, then keeps the choice across a reload and a change of the device', async ({ page }, testInfo) => {
    const deviceIsDark = testInfo.project.name === 'dark'
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveClass(darkClass(deviceIsDark)) // a first visit follows the device
    await expect(themeToggle(page)).toHaveAccessibleName(`Switch to ${deviceIsDark ? 'light' : 'dark'} theme`)

    // The device changes its mind before the toggle is used, and the page follows it (the theme is the layout's, so this does not need the toggle on screen).
    await changeDeviceScheme(page, deviceIsDark ? 'light' : 'dark')
    await expect(html).toHaveClass(darkClass(!deviceIsDark))
    await changeDeviceScheme(page, deviceIsDark ? 'dark' : 'light')
    await expect(html).toHaveClass(darkClass(deviceIsDark))

    await themeToggle(page).click()
    await expect(html).toHaveClass(darkClass(!deviceIsDark))
    await expect(themeToggle(page)).toHaveAccessibleName(`Switch to ${deviceIsDark ? 'dark' : 'light'} theme`)

    await page.reload()
    await expect(html).toHaveClass(darkClass(!deviceIsDark)) // remembered, and applied before the app starts
    // Now it is the person's choice, so the device does not move it.
    await changeDeviceScheme(page, deviceIsDark ? 'light' : 'dark')
    await expect(html).toHaveClass(darkClass(!deviceIsDark))

    await themeToggle(page).click() // and the toggle switches it back, which is remembered too
    await expect(html).toHaveClass(darkClass(deviceIsDark))
    await page.reload()
    await expect(html).toHaveClass(darkClass(deviceIsDark))
  })

  test('follows the device while it is in a phone\'s menu out of sight, and switches from there', async ({ page }, testInfo) => {
    const deviceIsDark = testInfo.project.name === 'dark'
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const html = page.locator('html')
    await changeDeviceScheme(page, deviceIsDark ? 'light' : 'dark')
    await expect(html).toHaveClass(darkClass(!deviceIsDark)) // no toggle was on the screen
    await openHeaderControls(page)
    await themeToggle(page).click()
    await expect(html).toHaveClass(darkClass(deviceIsDark))
    await expect(themeToggle(page)).toHaveAccessibleName(`Switch to ${deviceIsDark ? 'light' : 'dark'} theme`)
  })
})
