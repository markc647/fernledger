import type { BrowserContext } from '@playwright/test'
import type { Role } from '../src/generated/api/auth'
import { expect, noAxeViolations, test } from './fixtures'
import { openHelp } from './help-helpers'
import { sidebarTitle } from './shell-helpers'

// Cookies are not scoped by port, so the dev identity needs no copy of the port from playwright.config.ts.
const signInAs = (context: BrowserContext, role: Role) =>
  context.addCookies([{ name: 'fernledger_dev_as', value: role, domain: 'localhost', path: '/' }])

// The Settings are shared by every test and both themes, so these run one at a time (workers: 1) and each leaves the defaults behind.
test.afterEach(async ({ context, request, baseURL }) => {
  await signInAs(context, 'admin')
  const reset = await request.patch('/api/settings', {
    headers: { Origin: baseURL! },
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

test('saving a new app title changes the title in the sidebar and the page title straight away', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await expect(sidebarTitle(page).getByText('Fernledger', { exact: true })).toBeVisible()
  await page.getByLabel('App title').fill("Dad's finances")
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(sidebarTitle(page).getByText("Dad's finances")).toBeVisible()
  await expect(page).toHaveTitle("Dad's finances")
})

test('editing a field clears "Settings saved", so saving again announces it again', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  const saved = page.getByRole('status').filter({ hasText: 'Settings saved' })
  await page.getByLabel('App title').fill('Nan')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(saved).toBeVisible()

  await page.getByLabel('App title').fill('Nana')
  await expect(saved).toHaveCount(0)
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(saved).toBeVisible()
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
  await expect(setup).toContainText('Optional: you only need this to use Akahu Sync.')
  await expect(setup).toContainText('Setup needed: the Akahu app token. Add it as the Worker secret AKAHU_APP_TOKEN.')
  // The D1 usage bar is optional too, and its words end with where the steps are.
  await expect(setup).toContainText('D1 usage bar')
  await expect(setup).toContainText('Optional: you only need this to use the D1 usage bar.')
  await expect(setup).toContainText('Setup needed: the Cloudflare analytics token. Add it as the Worker secret CF_ANALYTICS_TOKEN.')
  await expect(setup).toContainText('The steps are in docs/setup.md, under "D1 usage bar (optional)".')
})

test('the Admin is not a Setting', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await expect(page.getByText("The Admin is set when Fernledger is deployed and can't be changed here.")).toBeHidden() // it is in the page's help sheet
  await expect(await openHelp(page)).toContainText("The Admin is set when Fernledger is deployed and can't be changed here.")
  await page.keyboard.press('Escape')
  await expect(page.getByLabel(/admin/i)).toHaveCount(0)
})

test('a Member cannot reach the screen, and the API refuses their write', async ({ page, context, baseURL }) => {
  await signInAs(context, 'member')
  await page.goto('/settings')
  await expect(page.getByText('Only the Admin can change settings.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0)
  await expect(page.getByText(/AKAHU_|Setup needed/)).toHaveCount(0)

  // Sent without a body: the guard refuses before reading one, and Vite's local server then drops the next request on that connection.
  // (The body-carrying refusal is covered at the Worker boundary in worker/settings.test.ts.)
  const write = await context.request.patch('/api/settings', { headers: { Origin: baseURL!, 'Content-Type': 'application/json' } })
  expect(write.status()).toBe(403)
})

test('the Settings screen has no WCAG 2.2 AA violations when saved, and when showing an error', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')

  await page.getByLabel('App title').fill('Nan')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
  await noAxeViolations(page) // straight after Save, while the button may still be changing colour

  await page.getByLabel('App title').fill('')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await noAxeViolations(page)
})

test('fields and the save button are at least 44px tall', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  for (const control of [page.getByLabel('App title'), page.getByRole('button', { name: 'Save settings' })]) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
})
