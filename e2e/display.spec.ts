import type { Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, signInAs, test } from './fixtures'

const fontSize = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

const sizeButton = (page: Page, name: 'A' | 'A+' | 'A++') =>
  page.getByRole('group', { name: 'Text size' }).getByRole('button', { name, exact: true })

// ---------------------------------------------------------------------------------------------------------------
// Text size (A / A+ / A++)

test.describe('text size', () => {
  test('starts at A with 16px body text, and each step is bigger', async ({ page }) => {
    await page.goto('/styleguide')
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBe(16)

    await sizeButton(page, 'A+').click()
    await expect(sizeButton(page, 'A+')).toHaveAttribute('aria-pressed', 'true')
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'false')
    const medium = await fontSize(page, 'body')
    expect(medium).toBeGreaterThan(16)

    await sizeButton(page, 'A++').click()
    expect(await fontSize(page, 'body')).toBeGreaterThan(medium)
  })

  test('is remembered on this device, and applied before the app starts', async ({ page }) => {
    await page.goto('/styleguide')
    await sizeButton(page, 'A++').click()
    await page.reload()
    await expect(sizeButton(page, 'A++')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBeCloseTo(16 * 1.3, 1)
    // The CSP-safe external script has set it by the time the document has parsed, so the page never jumps.
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'a-plus-plus')
  })

  test('still works, without errors, when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError')
        },
      })
    })
    await page.goto('/styleguide') // the fixture fails the test on any console error, uncaught error or CSP violation
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'true')
    await sizeButton(page, 'A+').click()
    await expect(sizeButton(page, 'A+')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBeGreaterThan(16)
    // Other controls still work too.
    await page.getByRole('button', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('shrugs off a junk saved value', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fernledger-text-size', 'enormous'))
    await page.goto('/styleguide')
    await expect(sizeButton(page, 'A')).toHaveAttribute('aria-pressed', 'true')
    expect(await fontSize(page, 'body')).toBe(16)
  })

  test('has touch targets of at least 44px', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/styleguide')
    // The links appear once the signed-in Member is known; `.all()` below doesn't wait for them.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link').first()).toBeVisible()
    const targets = [
      ...(['A', 'A+', 'A++'] as const).map((name) => sizeButton(page, name)),
      ...(await page.getByRole('navigation', { name: 'Main' }).getByRole('link').all()),
    ]
    expect(targets.length).toBeGreaterThan(3)
    for (const target of targets) {
      const box = await target.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
      expect(box?.width).toBeGreaterThanOrEqual(44)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Zoom: WCAG 1.4.4 (200%) and 1.4.10 reflow (400%, 320 CSS px). A browser at 200% zoom on a 1280px-wide window
// is a 640 CSS px viewport, which is how Playwright reproduces it.

test.describe('zoom', () => {
  const zoomLevels = [
    { name: '200% zoom', width: 640, height: 360 },
    { name: '400% zoom (320px wide)', width: 320, height: 256 },
  ]
  const pages = ['/', '/settings', '/styleguide', '/transactions', '/import']

  for (const { name, width, height } of zoomLevels) {
    for (const path of pages) {
      for (const size of ['A', 'A++'] as const) {
        test(`${path} at ${name} and text size ${size} has no horizontal scrolling`, async ({ page, context }) => {
          await signInAs(context, 'admin')
          await page.setViewportSize({ width, height })
          await page.goto(path)
          await sizeButton(page, size).click()
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
        })
      }
    }
  }

  test('a very long app title wraps instead of scrolling sideways', async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: 'The'.padEnd(120, 'x'), about_contact: '', about_retention: '' } }))
    await page.setViewportSize({ width: 320, height: 256 })
    await page.goto('/')
    await expect(page.getByRole('banner')).toContainText('Thexxx')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Amounts, dates and the table that becomes cards

test.describe('responsive table', () => {
  test('is a table on a wide screen and cards on a narrow one', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    await expect(table).toBeVisible()
    await expect(page.getByRole('list', { name: 'Sample transactions' })).toBeHidden()
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Description', 'Amount'])
    await expect(table.getByRole('row')).toHaveCount(4) // header + 3 rows

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(table).toBeHidden()
    const cards = page.getByRole('list', { name: 'Sample transactions' }).getByRole('listitem')
    await expect(cards).toHaveCount(3)
    // Each card carries the same facts, each with its heading beside it.
    await expect(cards.first()).toContainText('Date')
    await expect(cards.first()).toContainText('Thu 8 Oct 2026')
    await expect(cards.first()).toContainText('Example Supermarket')
    await expect(cards.first()).toContainText('−$1,111.11')
  })

  test('builds each cell once, so the page has no duplicate ids, at either width', async ({ page }) => {
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/styleguide')
      await expect(page.getByText('Example Supermarket')).toHaveCount(1)
      const duplicates = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
        return ids.filter((id, i) => ids.indexOf(id) !== i)
      })
      expect(duplicates).toEqual([])
    }
  })

  test('shows signed NZD amounts and NZ dates, with the direction in words', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    await expect(table.getByRole('row').nth(1)).toContainText('Thu 8 Oct 2026')
    await expect(table.getByText('−$1,111.11')).toBeVisible()
    await expect(table.getByText('+$1,234.56')).toBeVisible()
    await expect(table.getByText('Money out').first()).toBeVisible()
    await expect(table.getByText('Money in').first()).toBeVisible()
    expect(await table.innerText()).not.toMatch(/\d-\$|-\$/) // a real minus sign, never a hyphen
  })

  test('right-aligns amounts and gives digits a fixed width', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    await expect(page.getByRole('table')).toBeVisible()
    await page.evaluate(() => document.fonts.ready) // measure the real font, not the fallback it swaps from
    const wide = page.getByRole('table').getByText('−$1,111.11')
    const other = page.getByRole('table').getByText('−$8,888.88')
    const [a, b] = [await wide.boundingBox(), await other.boundingBox()]
    // Same number of characters, different digits: equal widths means tabular figures; equal right edges, right-aligned.
    expect(a!.width).toBeCloseTo(b!.width, 1)
    expect(a!.x + a!.width).toBeCloseTo(b!.x + b!.width, 1)
    const align = await wide.locator('xpath=ancestor::td').evaluate((el) => getComputedStyle(el).textAlign)
    expect(['right', 'end']).toContain(align)
  })

  test('keeps table text at 15px or more at every text size', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/styleguide')
    for (const size of ['A', 'A+', 'A++'] as const) {
      await sizeButton(page, size).click()
      for (const selector of ['table', 'table th', 'table td']) {
        expect(await fontSize(page, selector)).toBeGreaterThanOrEqual(15)
      }
    }
  })

  test('keeps card text at 15px or more on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/styleguide')
    expect(await fontSize(page, 'ul[aria-label="Sample transactions"] li')).toBeGreaterThanOrEqual(15)
    expect(await fontSize(page, 'ul[aria-label="Sample transactions"] dt')).toBeGreaterThanOrEqual(15)
  })

  test('prints as a table even from a phone-width page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ media: 'print' })
    await page.goto('/styleguide')
    const table = page.getByRole('table', { name: 'Sample transactions' })
    await expect(table).toBeVisible()
    await expect(table.getByRole('row')).toHaveCount(4) // header + 3 rows
    await expect(page.getByRole('list', { name: 'Sample transactions' })).toBeHidden()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Statuses

test('a status is an icon and words as well as a colour', async ({ page }) => {
  await page.goto('/styleguide')
  for (const words of ['Synced', 'Pending', 'Needs attention', 'Problem', 'Not set up']) {
    const status = page.getByText(words, { exact: true })
    await expect(status).toBeVisible()
    const icon = status.locator('xpath=..').locator('svg')
    await expect(icon).toHaveCount(1)
    await expect(icon).toHaveAttribute('aria-hidden', 'true') // the words carry the meaning for a screen reader
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Device settings

test.describe('reduced motion', () => {
  test('is respected: transitions and animations all but stop', async ({ page }) => {
    await page.goto('/styleguide')
    const duration = () =>
      page.getByRole('button', { name: 'Dark' }).evaluate((el) => {
        const s = getComputedStyle(el)
        return { transition: parseFloat(s.transitionDuration), scroll: s.scrollBehavior }
      })
    // Without the preference the button does animate (so the check below proves something).
    expect((await duration()).transition).toBeGreaterThan(0.05)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await duration()
    expect(reduced.transition).toBeLessThanOrEqual(0.001)
    expect(reduced.scroll).toBe('auto')
  })
})

test.describe('forced colours (Windows high contrast)', () => {
  test('keeps the chosen text size and theme visible, and focus drawn as an outline', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/styleguide')
    const pressed = sizeButton(page, 'A')
    const unpressed = sizeButton(page, 'A+')
    const background = (button: typeof pressed) => button.evaluate((el) => getComputedStyle(el).backgroundColor)
    // The pressed button is told apart by more than the fill the browser throws away.
    expect(await background(pressed)).not.toBe(await background(unpressed))

    await unpressed.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const outline = await unpressed.evaluate((el) => {
      const s = getComputedStyle(el)
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }
    })
    expect(outline.style).toBe('solid')
    expect(outline.width).toBeGreaterThanOrEqual(2)
  })

  test('still shows every status icon and word', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/styleguide')
    await expect(page.getByText('Needs attention', { exact: true })).toBeVisible()
    await expect(page.locator('svg[aria-hidden="true"]').first()).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Header

test.describe('header', () => {
  test('shows the app title from Settings, and uses it as the page title', async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: { app_title: "Mum's finances", about_contact: '', about_retention: '' } }))
    await page.goto('/')
    await expect(page.getByRole('banner').getByText("Mum's finances")).toBeVisible()
    await expect(page).toHaveTitle("Mum's finances")
  })

  test('says Fernledger until the Admin sets a title', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('banner').getByText('Fernledger', { exact: true })).toBeVisible()
    await expect(page).toHaveTitle('Fernledger')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Accessibility of the new building blocks at the largest text size

test('the examples page has no WCAG 2.2 AA violations at the largest text size', async ({ page }) => {
  await page.goto('/styleguide')
  await sizeButton(page, 'A++').click()
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} element(s)`)).toEqual([])
})
