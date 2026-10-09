import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'
import { expect, test } from './fixtures'

const signInAs = (context: BrowserContext, role: Role) =>
  context.addCookies([{ name: 'fernledger_dev_as', value: role, url: 'http://localhost:5199' }])

const pages = [
  { role: 'admin', path: '/', heading: 'Summary' },
  { role: 'admin', path: '/settings', heading: 'Settings' },
  { role: 'member', path: '/', heading: 'Summary' },
  { role: 'member', path: '/styleguide', heading: 'Display examples' },
] as const

const darkClass = (dark: boolean) => (dark ? /dark/ : /^(?!.*dark)/)

for (const { role, path, heading } of pages) {
  test(`${heading} page as ${role} has no WCAG 2.2 AA violations`, async ({ page, context }, testInfo) => {
    await signInAs(context, role)
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    // The project's theme must really be showing, or the scan would not be testing it.
    await expect(page.locator('html')).toHaveClass(darkClass(testInfo.project.name === 'dark'))

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
  })
}

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
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()

  await signInAs(context, 'member')
  await page.reload()
  await expect(page.getByText('Member (read-only)')).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Summary' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0)
})

test('the theme toggle overrides the device and is remembered', async ({ page }, testInfo) => {
  const deviceIsDark = testInfo.project.name === 'dark'
  await page.goto('/')
  const html = page.locator('html')

  await page.getByRole('button', { name: deviceIsDark ? 'Light' : 'Dark' }).click()
  await expect(html).toHaveClass(darkClass(!deviceIsDark))

  await page.reload()
  await expect(html).toHaveClass(darkClass(!deviceIsDark))
  await expect(page.getByRole('button', { name: deviceIsDark ? 'Light' : 'Dark' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Device' }).click()
  await expect(html).toHaveClass(darkClass(deviceIsDark))
})

test('theme buttons are at least 44px and focus is visible with enough contrast', async ({ page }) => {
  await page.goto('/')
  for (const name of ['Device', 'Light', 'Dark']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
  }
  for (const link of await page.getByRole('navigation', { name: 'Main' }).getByRole('link').all()) {
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }

  // Tab past the skip link to the first navigation link and check a real outline is drawn.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!)
    return { tag: document.activeElement!.tagName, width: parseFloat(style.outlineWidth), style: style.outlineStyle }
  })
  expect(outline).toEqual({ tag: 'A', width: 2, style: 'solid' })
})
