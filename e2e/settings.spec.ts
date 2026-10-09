import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'
import { expect, test } from './fixtures'

const origin = 'http://localhost:5199'
const signInAs = (context: BrowserContext, role: Role) => context.addCookies([{ name: 'fernledger_dev_as', value: role, url: origin }])

// The Settings are shared by every test and both themes, so these run one at a time (workers: 1) and each leaves the defaults behind.
test.afterEach(async ({ context, request }) => {
  await signInAs(context, 'admin')
  const reset = await request.patch('/api/settings', {
    headers: { Origin: origin },
    data: { app_title: 'Fernledger', about_contact: '', about_retention: '' },
  })
  expect(reset.ok()).toBe(true)
})

test('the Admin edits the app title and the About-your-data fields, and they are kept', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

  await page.getByLabel('App title').fill("Mum's finances")
  await page.getByLabel('Who to contact about this data').fill('Sam, sam@example.com')
  await page.getByLabel('How long the data is kept').fill('Until Mum asks us to delete it')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('App title')).toHaveValue("Mum's finances")
  await expect(page.getByLabel('Who to contact about this data')).toHaveValue('Sam, sam@example.com')
  await expect(page.getByLabel('How long the data is kept')).toHaveValue('Until Mum asks us to delete it')
})

test('a blank app title is refused, says so, and nothing is saved', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await page.getByLabel('App title').fill('   ')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toContainText('App title')

  await page.reload()
  await expect(page.getByLabel('App title')).toHaveValue('Fernledger')
})

test('the Admin is told what to set up, and how, for a feature that is switched off', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  const setup = page.getByRole('region', { name: 'Setup needed' })
  await expect(setup).toContainText('Akahu Sync')
  await expect(setup).toContainText('Setup needed: the Akahu app token. Add it as the Worker secret AKAHU_APP_TOKEN.')
})

test('the Admin is not a Setting', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await expect(page.getByText("The Admin is set when Fernledger is deployed and can't be changed here.")).toBeVisible()
  await expect(page.getByLabel(/admin/i)).toHaveCount(0)
})

test('a Member cannot reach the screen, and the API refuses their write', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/settings')
  await expect(page.getByText('Only the Admin can change settings.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0)
  await expect(page.getByText(/AKAHU_|Setup needed/)).toHaveCount(0)

  // Sent without a body: the guard refuses before reading one, and Vite's local server then drops the next request on that connection.
  // (The body-carrying refusal is covered at the Worker boundary in worker/settings.test.ts.)
  const write = await context.request.patch('/api/settings', { headers: { Origin: origin, 'Content-Type': 'application/json' } })
  expect(write.status()).toBe(403)
})

test('the Settings screen has no WCAG 2.2 AA violations when saved, and when showing an error', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  const scan = async () => {
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
  }

  await page.getByLabel('App title').fill('Nan')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
  await scan()

  await page.getByLabel('App title').fill('')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await scan()
})

test('fields and the save button are at least 44px tall', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  for (const control of [page.getByLabel('App title'), page.getByRole('button', { name: 'Save settings' })]) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
})
