import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type BrowserContext } from '@playwright/test'

const signInAs = (context: BrowserContext, who: 'admin' | 'member') =>
  context.addCookies([{ name: 'fernledger_dev_as', value: who, url: 'http://localhost:5199' }])

const pages = [
  { who: 'admin', path: '/', heading: 'Summary' },
  { who: 'admin', path: '/settings', heading: 'Settings' },
  { who: 'member', path: '/', heading: 'Summary' },
] as const

for (const { who, path, heading } of pages) {
  test(`${heading} page as ${who} has no WCAG 2.2 AA violations`, async ({ page, context }, testInfo) => {
    await signInAs(context, who)
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    // The project's theme must really be showing, or the scan would not be testing it.
    await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
  })
}

test('the Admin sees Settings in the navigation, a Member does not', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()

  await page.getByRole('button', { name: 'Member' }).click()
  await expect(page.getByText('read-only Member')).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Summary' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0)
})

test('the theme toggle overrides the device and is remembered', async ({ page }, testInfo) => {
  await page.goto('/')
  const html = page.locator('html')
  const opposite = testInfo.project.name === 'dark' ? 'Light' : 'Dark'

  await page.getByRole('button', { name: opposite }).click()
  await expect(html).toHaveClass(opposite === 'Dark' ? /dark/ : /^(?!.*dark)/)

  await page.reload()
  await expect(html).toHaveClass(opposite === 'Dark' ? /dark/ : /^(?!.*dark)/)
  await expect(page.getByRole('button', { name: opposite })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Device' }).click()
  await expect(html).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
})
