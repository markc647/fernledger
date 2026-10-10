import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

// Ticket 30: the pages every Member can open (About your data, How to sign in) and the Home Screen app. Axe runs on both
// pages in both themes (the project is the theme), for a Member and for the Admin; the zoom test in display.spec.ts
// covers both pages too.

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

// The Settings are shared by every test and both themes, so each test leaves the defaults behind (as settings.spec.ts does).
test.afterEach(async ({ request, baseURL }) => {
  const reset = await request.patch('/api/settings', {
    headers: { Origin: baseURL! },
    data: { app_title: 'Fernledger', about_contact: '', about_retention: '' },
  })
  expect(reset.ok()).toBe(true)
})

/** The Admin fills in the About-your-data fields. The default identity is the Admin, so the request needs no cookie. */
const adminSets = async (request: APIRequestContext, baseURL: string | undefined, data: object) =>
  expect((await request.patch('/api/settings', { headers: { Origin: baseURL! }, data })).ok()).toBe(true)

const section = (page: Page, name: string) => page.getByRole('region', { name })

// ---------------------------------------------------------------------------------------------------------------
// Navigation

test.describe('navigation', () => {
  for (const role of ['member', 'admin'] as const) {
    test(`a ${role} has both pages in the navigation, and they open`, async ({ page, context }) => {
      await signInAs(context, role)
      await page.goto('/')
      const nav = page.getByRole('navigation', { name: 'Main' })
      await nav.getByRole('link', { name: 'About your data' }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'About your data' })).toBeVisible()
      await nav.getByRole('link', { name: 'How to sign in' }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// About your data

test.describe('About your data', () => {
  test('answers what is held, who sees it, where it is stored, how long and who to ask, with the Admin\'s words from Settings', async ({ page, context, request, baseURL }) => {
    await adminSets(request, baseURL, { about_contact: 'Sam, 021 000 0000', about_retention: 'Until Mum asks us to delete it' })
    await signInAs(context, 'member')
    await page.goto('/about-your-data')

    for (const name of ['What is held', 'Who can see it', 'Where it is stored', 'How long it is kept', 'Who to ask']) {
      await expect(section(page, name)).toBeVisible()
      await expect(section(page, name).getByRole('heading', { level: 2, name })).toBeVisible()
    }
    await expect(section(page, 'Who to ask')).toContainText('Sam, 021 000 0000')
    await expect(section(page, 'How long it is kept')).toContainText('Until Mum asks us to delete it')
    // What the app does regardless of what the Admin writes.
    await expect(section(page, 'How long it is kept')).toContainText('Fernledger never deletes your data by itself')
    await expect(section(page, 'What is held')).toContainText('Transactions')
    await expect(section(page, 'What is held')).toContainText('Change Log')
    await expect(section(page, 'Who can see it')).toContainText('Cloudflare Access')
  })

  test('lists everything the database holds: Accounts, Transactions, Balances, Categories, the Change Log, sign-in, Settings', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/about-your-data')
    const held = section(page, 'What is held')
    await expect(held.getByRole('listitem').locator('strong')).toHaveText(['Accounts:', 'Transactions:', 'Balances:', 'Categories:', 'The Change Log:', 'Who may sign in:', 'Settings:'])
    await expect(held.getByRole('listitem').filter({ hasText: 'Balances:' })).toContainText('balance a bank reported')
    // The Change Log keeps values, Notes included, and is where the Admin's email address is held.
    await expect(held.getByRole('listitem').filter({ hasText: 'The Change Log:' })).toContainText('often with the values from before and after')
    await expect(held.getByRole('listitem').filter({ hasText: 'The Change Log:' })).toContainText('any Note')
    await expect(held.getByRole('listitem').filter({ hasText: 'Who may sign in:' })).toContainText("It writes the Admin's email address into each Change Log entry")
    await expect(held).not.toContainText(/Admin's email address, outside the database/)
  })

  test('says what the weekly backup holds, and that earlier backups keep what was later removed', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/about-your-data')
    await expect(section(page, 'What is held')).toContainText('A copy of the database is saved every week')
    await expect(section(page, 'What is held')).toContainText("The sign-in list and any Akahu keys are kept outside the database, so the backups don't hold them")
    await expect(section(page, 'What is held')).toContainText("The Admin's email address is in the Change Log, so it is in the backups")
    await expect(section(page, 'How long it is kept')).toContainText('earlier backups still hold their copy')
  })

  test('gives a Member neutral lines, not setup instructions, until the Admin fills the fields in', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/about-your-data')
    await expect(section(page, 'Who to ask')).toContainText('Ask the person who invited you to Fernledger.')
    await expect(section(page, 'How long it is kept')).toContainText("The Admin hasn't said yet how long the data is kept.")
    await expect(page.getByText('Setup needed')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Open Settings' })).toHaveCount(0)
  })

  test('tells the Admin what to set up, with a way to Settings, until the fields are filled in', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/about-your-data')
    await expect(section(page, 'Who to ask')).toContainText('Setup needed: say who Members should ask about this data.')
    await expect(section(page, 'How long it is kept')).toContainText('Setup needed: say how long the data is kept.')
    await section(page, 'Who to ask').getByRole('link', { name: 'Open Settings' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  })

  test('stops telling the Admin to set up once the fields are filled in', async ({ page, context, request, baseURL }) => {
    await adminSets(request, baseURL, { about_contact: 'Sam', about_retention: 'Seven years' })
    await signInAs(context, 'admin')
    await page.goto('/about-your-data')
    await expect(section(page, 'Who to ask')).toContainText('Sam')
    await expect(page.getByText('Setup needed')).toHaveCount(0)
  })

  test("shows the Admin's words as plain text, never as markup", async ({ page, context, request, baseURL }) => {
    await adminSets(request, baseURL, { about_contact: '<b>Sam</b>\nSecond line' })
    await signInAs(context, 'member')
    await page.goto('/about-your-data')
    await expect(section(page, 'Who to ask')).toContainText('<b>Sam</b>')
    await expect(section(page, 'Who to ask').locator('b')).toHaveCount(0)
  })

  test('says Oceania is a location hint, not a residency guarantee (ADR 0007), and names only the outbound calls of ADR 0010', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/about-your-data')
    const stored = section(page, 'Where it is stored')
    await expect(stored).toContainText('Oceania')
    await expect(stored).toContainText('a request, not a guarantee')
    const text = await page.getByRole('main').innerText()
    expect(text).not.toMatch(/Sydney|data residency|stored in New Zealand/i)
    await expect(section(page, 'Who can see it')).toContainText('no one but Akahu (only if this Fernledger uses Akahu Sync) and, to check a sign-in, your own Cloudflare Access')
  })

  test('says whether Akahu Sync is set up, from what the Worker reports', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/about-your-data')
    await expect(section(page, 'What is held')).toContainText("Akahu Sync isn't set up here, so Transactions come only from bank files the Admin imports.")

    await page.route('**/api/features', (route) => route.fulfill({ json: { features: [{ id: 'akahu-sync', name: 'Akahu Sync', enabled: true }] } }))
    await page.reload()
    // Sync hasn't shipped, so only the keys can be claimed, not that Transactions arrive from Akahu.
    await expect(section(page, 'What is held')).toContainText('Akahu access keys are set up here.')
    await expect(section(page, 'What is held')).not.toContainText("isn't set up")
    await expect(section(page, 'What is held')).not.toContainText(/Sync is on|can also arrive/)
    await expect(section(page, 'What is held')).not.toContainText('Worker secrets')
  })

  test('says so, rather than showing neutral lines, when the Settings cannot be loaded', async ({ page, context }) => {
    await signInAs(context, 'member')
    // A body that isn't JSON fails the query without a failed request, which the fixture would report as a console error.
    await page.route('**/api/settings', (route) => route.fulfill({ contentType: 'application/json', body: 'not json' }))
    await page.goto('/about-your-data')
    // The query tries again a few times before it gives up.
    await expect(section(page, 'Who to ask').getByRole('alert')).toContainText("couldn't load", { timeout: 15_000 })
    await expect(section(page, 'Who to ask')).not.toContainText('Ask the person who invited you')
    await expect(section(page, 'How long it is kept').getByRole('alert')).toBeVisible()
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}, filled in or not`, async ({ page, context, request, baseURL }, testInfo) => {
      await signInAs(context, role)
      for (const filled of [false, true]) {
        await adminSets(request, baseURL, filled ? { about_contact: 'Sam', about_retention: 'Seven years' } : { about_contact: '', about_retention: '' })
        await page.goto('/about-your-data')
        await expect(page.getByRole('heading', { level: 1, name: 'About your data' })).toBeVisible()
        await expect(section(page, 'Who to ask')).toContainText(filled ? 'Sam' : role === 'admin' ? 'Setup needed' : 'Ask the person who invited you')
        await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
        const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
        expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// How to sign in

test.describe('How to sign in', () => {
  test('gives the Cloudflare Access email-code steps in plain English, and that the session lasts a while', async ({ page, context, baseURL }) => {
    await signInAs(context, 'member')
    await page.goto('/how-to-sign-in')
    const steps = page.getByRole('list', { name: 'Steps' }).getByRole('listitem')
    await expect(steps).toHaveCount(5)
    await expect(steps.nth(0)).toContainText('Open Fernledger')
    await expect(steps.nth(1)).toContainText('email address')
    await expect(steps.nth(2)).toContainText('junk or spam')
    await expect(steps.nth(3)).toContainText('code')
    await expect(steps.nth(4)).toContainText('for a while (usually 24 hours')
    // The app's own address, filled in at runtime from where the page is open: no address is written into the guide.
    await expect(steps.nth(0)).toContainText(new URL(baseURL!).host)
    await expect(page.getByRole('heading', { level: 2, name: 'If something goes wrong' })).toBeVisible()
  })

  test('names the Cloudflare buttons and promises no delivery time', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/how-to-sign-in')
    const main = page.getByRole('main')
    await expect(main).toContainText('"Send login code"')
    await expect(main).toContainText('"Sign in"')
    await expect(main).toContainText('"Request new code"')
    await expect(main).toContainText('10 minutes')
    await expect(main).not.toContainText(/within a minute|minute or two/i)
  })

  test('tells the Admin, and only the Admin, to print it for each Member', async ({ page, context }) => {
    const note = 'Print this and give it to each Member before their first sign-in.'
    await signInAs(context, 'member')
    await page.goto('/how-to-sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    await expect(page.getByText(note)).toHaveCount(0)

    await signInAs(context, 'admin')
    await page.goto('/how-to-sign-in')
    await expect(page.getByText(note)).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(page.getByText(note)).toBeHidden()
  })

  test("shows the Admin's contact under \"Still stuck?\" once it is set, and not before", async ({ page, context, request, baseURL }) => {
    await signInAs(context, 'member')
    await page.goto('/how-to-sign-in')
    const stuck = page.getByRole('listitem').filter({ hasText: 'Still stuck?' })
    await expect(stuck).toContainText('Ask the Admin.')
    await expect(stuck).not.toContainText('Sam')

    await adminSets(request, baseURL, { about_contact: 'Sam, 021 000 0000' })
    await page.reload()
    await expect(stuck).toContainText('Sam, 021 000 0000')
  })

  test('has no real email address and no link to another site', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/how-to-sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    expect(await page.getByRole('main').innerText()).not.toMatch(/\S+@\S+\.\S+/)
    expect(await page.getByRole('main').locator('a[href^="http"], a[href^="//"]').count()).toBe(0)
  })

  test('names the app by its title, when the Admin has set one', async ({ page, context, request, baseURL }) => {
    await adminSets(request, baseURL, { app_title: "Mum's finances" })
    await signInAs(context, 'member')
    await page.goto('/how-to-sign-in')
    await expect(page.getByRole('main')).toContainText("This guide is for Mum's finances.")
  })

  test('the Print button opens the print dialog', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.addInitScript(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => void ((window as unknown as { printed: number }).printed += 1)
    })
    await page.goto('/how-to-sign-in')
    await page.getByRole('button', { name: 'Print this guide' }).click()
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)
  })

  test.describe('printed', () => {
    test.beforeEach(async ({ page, context }) => {
      await signInAs(context, 'member')
      await page.emulateMedia({ media: 'print' })
      await page.goto('/how-to-sign-in')
      await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    })

    test('is just the guide: no header, navigation or buttons', async ({ page }) => {
      await expect(page.getByRole('banner')).toBeHidden()
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
      await expect(page.getByRole('button')).toHaveCount(0) // hidden elements are not in the accessibility tree
      await expect(page.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveCount(5)
    })

    test("leaves a blank line for the Admin's name and phone, on paper only", async ({ page }) => {
      await expect(page.getByText("Admin's name and phone:")).toBeVisible()
      await page.emulateMedia({ media: 'screen' })
      await expect(page.getByText("Admin's name and phone:")).toBeHidden()
    })

    test('uses large print: steps at 12pt (16px) or more', async ({ page }) => {
      const sizes = await page.getByRole('list', { name: 'Steps' }).getByRole('listitem').evaluateAll((items) => items.map((el) => parseFloat(getComputedStyle(el).fontSize)))
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16)
    })

    test('is dark text on white paper, even from the dark theme', async ({ page }) => {
      const { text, paper } = await page.evaluate(() => {
        const rgb = (css: string) => {
          const ctx = document.createElement('canvas').getContext('2d')!
          ctx.fillStyle = '#000'
          ctx.fillStyle = css
          ctx.fillRect(0, 0, 1, 1)
          return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
        }
        const style = getComputedStyle(document.body)
        return { text: rgb(style.color), paper: rgb(style.backgroundColor) }
      })
      expect(Math.max(...text)).toBeLessThan(90)
      expect(Math.min(...paper)).toBeGreaterThan(240)
    })

    test('fits on one A4 page at the usual text size', async ({ page }) => {
      const pdf = await page.pdf({ format: 'A4' })
      const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []
      expect(pages).toHaveLength(1)
    })
  })

  for (const role of ['member', 'admin'] as const) {
    test(`has no WCAG 2.2 AA violations as a ${role}`, async ({ page, context }, testInfo) => {
      await signInAs(context, role)
      await page.goto('/how-to-sign-in')
      await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
      await expect(page.locator('html')).toHaveClass(testInfo.project.name === 'dark' ? /dark/ : /^(?!.*dark)/)
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Home Screen app

test.describe('Add to Home Screen', () => {
  test('serves a manifest and icons that the browser accepts under the real headers', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/')
    const link = page.locator('link[rel="manifest"]')
    await expect(link).toHaveAttribute('href', '/manifest.webmanifest')
    // Cloudflare Access would send a cookie-less manifest request to its login page, so the request must carry the cookies.
    await expect(link).toHaveAttribute('crossorigin', 'use-credentials')

    const res = await page.request.get('/manifest.webmanifest')
    expect(res.ok()).toBe(true)
    expect(res.headers()['content-type']).toMatch(/json/)
    expect(res.headers()['content-security-policy']).toContain("manifest-src 'self'")
    const manifest = await res.json()
    expect(manifest.display).toBe('standalone')
    for (const icon of manifest.icons) {
      const image = await page.request.get(icon.src)
      expect(image.ok(), icon.src).toBe(true)
      expect(image.headers()['content-type'], icon.src).toBe('image/png')
    }
    const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
    expect((await page.request.get(touch!)).ok()).toBe(true)
  })

  test("Chromium parses the manifest without errors, and the page's own headers do not block it", async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/')
    const cdp = await context.newCDPSession(page)
    const { errors, data } = await cdp.send('Page.getAppManifest')
    expect(errors).toEqual([])
    expect(JSON.parse(data!)).toMatchObject({ display: 'standalone', start_url: '/' })
    // The fixture also fails this test on any CSP violation the manifest or icons caused.
  })

  test('has no service worker, so no offline mode and no push', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const path of ['/', '/about-your-data', '/how-to-sign-in']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0)
      expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    }
  })
})
