import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs, test } from './fixtures'

// The light and dark projects share one local database, so each makes entries of its own, with values no earlier run used.
const nzToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date())
const WHEN = /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (am|pm)$/

/** The Admin makes two Settings changes and one Import, so the Change Log has entries of two types. */
async function seed(context: BrowserContext, baseURL: string, projectName: string) {
  await signInAs(context, 'admin')
  const stamp = `${projectName} ${Date.now()}`
  const headers = { Origin: baseURL }
  const first = `Sam ${stamp} one`
  const second = `Sam ${stamp} two`
  for (const about_contact of [first, second]) {
    const res = await context.request.patch('/api/settings', { headers, data: { about_contact } })
    expect(res.ok()).toBe(true)
  }
  const account = projectName === 'dark' ? '99-9999-9999999-90' : '99-9999-9999999-91'
  const imported = await context.request.post('/api/imports/chunks', {
    headers,
    data: {
      account: { number: account },
      chunk: { index: 0, count: 1 },
      file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2017-01-01', to: '2017-01-01', ledgerBalance: { cents: 0, date: '2017-01-01' } },
      rows: [{ date: '2017-01-01', uniqueId: `CL${stamp.replaceAll(' ', '')}`, tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -1000 }],
    },
  })
  expect(imported.ok()).toBe(true)
  return { first, second, account }
}

const noAxeViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
}

const entry = (page: Page, text: string | RegExp) => page.getByRole('listitem').filter({ hasText: text })

test.describe.configure({ mode: 'serial' })

for (const role of ['admin', 'member'] as const) {
  test(`the ${role} sees who changed what and when, with before and after, and the page has no WCAG 2.2 AA violations`, async ({ page, context, baseURL }, testInfo) => {
    const { first, second, account } = await seed(context, baseURL!, testInfo.project.name)
    await signInAs(context, role)
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Change Log' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Change Log' })).toBeVisible()

    // Newest first: the Import was made last.
    const imported = entry(page, `Imported 1 rows into ${account}`).first()
    await expect(imported).toBeVisible()
    await expect(imported).toContainText('Import change by admin@example.com')
    await expect(imported.locator('time')).toHaveText(WHEN)
    await expect(imported.getByRole('columnheader', { name: 'Before' })).toHaveCount(0) // an Import has no "before"
    await expect(imported.getByRole('row', { name: /^Added 1$/ })).toBeVisible()
    await expect(imported.getByRole('row', { name: /^From Sun 1 Jan 2017$/ })).toBeVisible()

    // A Settings change shows the field with its old and new value.
    const changed = entry(page, second).first()
    await expect(changed).toContainText('Changed settings: contact')
    await expect(changed).toContainText('Settings change by admin@example.com')
    await expect(changed.getByRole('row', { name: new RegExp(`^About contact ${first} ${second}$`) })).toBeVisible()
    await expect(changed.getByRole('columnheader', { name: 'Before' })).toBeVisible()
    await expect(changed.getByRole('columnheader', { name: 'After' })).toBeVisible()

    await noAxeViolations(page)
  })
}

test('the Change Log can be filtered by type and by date', async ({ page, context, baseURL }, testInfo) => {
  const { second, account } = await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await page.goto('/change-log')
  const imported = entry(page, `Imported 1 rows into ${account}`).first()
  const changed = entry(page, second).first()
  await expect(imported).toBeVisible()
  await expect(changed).toBeVisible()

  await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Settings' })
  await expect(changed).toBeVisible()
  await expect(imported).toHaveCount(0)
  await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Import' })
  await expect(imported).toBeVisible()
  await expect(changed).toHaveCount(0)
  await expect(page.getByRole('listitem').filter({ hasText: 'Settings change' })).toHaveCount(0)

  // The type and dates combine; nothing was changed in 2030.
  await page.getByLabel('From', { exact: true }).fill('2030-01-01')
  await page.getByLabel('To', { exact: true }).fill('2030-12-31')
  await expect(page.getByText('No changes match these filters.')).toBeVisible()
  await noAxeViolations(page)

  // Today (NZ), both ends included, brings today's Import back.
  await page.getByLabel('From', { exact: true }).fill(nzToday())
  await page.getByLabel('To', { exact: true }).fill(nzToday())
  await expect(imported).toBeVisible()
  await expect(changed).toHaveCount(0)

  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('')
  await expect(imported).toBeVisible()
  await expect(changed).toBeVisible()
})

test('a range that ends before it starts is explained, not searched', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/change-log')
  await expect(page.getByRole('heading', { level: 1, name: 'Change Log' })).toBeVisible()
  await page.getByLabel('From', { exact: true }).fill('2026-10-09')
  await page.getByLabel('To', { exact: true }).fill('2026-10-08')
  await expect(page.getByRole('alert')).toContainText('before the “From” date')
  await noAxeViolations(page)
})
