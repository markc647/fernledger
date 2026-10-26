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
    data: { app_title: 'Fernledger', about_contact: '', about_retention: '', cloudflare_plan: 'free' },
  })
  expect(reset.ok()).toBe(true)
})

// The Cloudflare plan (ADR 0018). Its save is answered here, so the shared test database stays on the Free Plan and specs running beside this one
// keep their daily caps; the Worker's tests keep the Setting (worker/settings.test.ts).
test('the Admin turns on Cloudflare Paid Plan, a switch that is off by default and says what it does, and saves it with the Settings', async ({ page, context }) => {
  await signInAs(context, 'admin')
  let sent: Record<string, unknown> | undefined
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    sent = route.request().postDataJSON()
    await route.fulfill({ json: sent })
  })
  await page.goto('/settings')
  const plan = page.getByRole('switch', { name: 'Cloudflare Paid Plan' })
  await expect(plan).toHaveAttribute('aria-checked', 'false') // the Free Plan
  await expect(plan).toHaveAccessibleDescription(/^Turn this on only if this Cloudflare account is on the Workers Paid plan\. .*Fernledger would stop working until 00:00 UTC/)

  await plan.click()
  await expect(plan).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
  expect(sent).toMatchObject({ cloudflare_plan: 'paid' })
  await noAxeViolations(page)

  // The label turns it too, and so do Space and Enter on the switch, as on a button.
  await page.getByText('Cloudflare Paid Plan', { exact: true }).click()
  await expect(plan).toHaveAttribute('aria-checked', 'false')
  await plan.focus()
  await page.keyboard.press('Space')
  await expect(plan).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Enter')
  await expect(plan).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toHaveCount(0) // a change since the save
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
  // The tests' Worker has no Members' read count key, which npm run deploy sets (#53): not optional, and nothing is switched off without it.
  await expect(setup).toContainText("Members' read count key")
  await expect(setup).toContainText("Setup needed: the key for the Members' read counts. Run npm run deploy, which sets the Worker secret MEMBER_KEY_SECRET.")
  await expect(setup).toContainText('These features are switched off, or not doing all they should, until you do the following.')
})

// "Run a Sync now" (worker/sync-route.ts). The browser tests run with no Akahu tokens, so what is reachable here is the
// Setup-needed state: the offer is there, it says what to set up, and it asks the Worker for nothing (a run would be refused
// with "Not set up" and would contact no one). A run that reaches Akahu is pinned at the Worker boundary in worker/sync-route.test.ts.
test('the Admin is offered a Sync to run now, and told to set Akahu up first while it is off', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  const section = page.getByRole('region', { name: 'Run a Sync now' })
  await expect(section).toContainText("Akahu Sync isn't set up yet, so there is nothing to run.")
  // What to add is said once on this screen, in Setup needed below, and not repeated here.
  await expect(section).not.toContainText('AKAHU_APP_TOKEN')
  await expect(section.getByRole('button', { name: 'Run a Sync now' })).toHaveCount(0)
})

test('a Member is not offered a Sync to run', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/settings')
  await expect(page.getByText('Only the Admin can change settings.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Run a Sync now' })).toHaveCount(0)
})

test('the Admin is not a Setting', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.goto('/settings')
  await expect(page.getByLabel('App title')).toBeVisible() // the form is drawn, which is where the sentence used to be
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
  for (const control of [page.getByLabel('App title'), page.getByRole('switch', { name: 'Cloudflare Paid Plan' }), page.getByRole('button', { name: 'Save settings' })]) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
})

// The Account Link (spec 29), on the same screen as the Cutover Dates a Sync depends on. The browser tests run with no Akahu
// tokens, so what is reachable here is the Setup-needed state: the section says so and asks the Worker for nothing, because the
// route would answer "Not set up" and contact no one. Linking itself is pinned at the Worker boundary in
// worker/account-link.test.ts, and the one call to Akahu in worker/outbound.test.ts.
test('the Admin is told to set Akahu up before anything can be linked, and nothing asks Akahu', async ({ page, context }) => {
  const asked: string[] = []
  await page.route('**/api/akahu/**', (route) => {
    asked.push(route.request().url())
    return route.abort()
  })
  await signInAs(context, 'admin')
  await page.goto('/settings')

  const section = page.getByRole('region', { name: 'Akahu Sync' })
  await expect(section).toContainText("Akahu Sync isn't set up yet, so there is nothing to link to.")
  // What to add is said once on this screen, in Setup needed below.
  await expect(section).not.toContainText('AKAHU_APP_TOKEN')
  await expect(section.getByRole('button', { name: 'Show my Akahu accounts' })).toHaveCount(0)
  // The list of Akahu accounts is never fetched as the page loads: asking contacts Akahu (ADR 0010).
  expect(asked).toEqual([])
})

test('a Member sees no Account Link controls', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/settings')
  await expect(page.getByText('Only the Admin can change settings.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Akahu Sync' })).toHaveCount(0)
})
