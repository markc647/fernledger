import type { Locator, Page } from '@playwright/test'
import { expect, noAxeViolations, settle, test } from './fixtures'
import { ruleActions, ruleGrip, withRules } from './rule-helpers'
import { actionsButton, arrowTo, menuAction, OPEN_MENU, openActions, textContrast } from './row-actions-helpers'
import { chooseTextSize, expectTextSize } from './shell-helpers'

// The "⋯" menu of a row and the handle that drags a Rule (src/components/row-actions.tsx, sortable-rows.tsx), as the reader sees them: in both themes (every test runs in both),
// with Windows high contrast, at the text sizes, and on both pages that have them. What the actions do is in rules.spec.ts, rules-reorder.spec.ts and categories.spec.ts.

/** The colour a CSS value is, as the browser computes it for a property, so a token is compared in whichever colour space the theme writes it. */
const resolved = (page: Page, property: 'color' | 'backgroundColor', value: string) =>
  page.evaluate(
    ({ property, value }) => {
      const probe = document.createElement('div')
      probe.style[property] = value
      document.body.append(probe)
      const colour = getComputedStyle(probe)[property]
      probe.remove()
      return colour
    },
    { property, value },
  )

const style = (target: Locator, ...properties: string[]) =>
  target.evaluate((element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])), properties)

/** Two Rules to look at (the first has one after it, so it can move down), on the Rules page. `body` is given the first one's id. */
const withRule = (page: Page, context: Parameters<typeof withRules>[0], baseURL: string, testInfo: { project: { name: string } }, body: (id: number) => Promise<void>) =>
  withRules(context, baseURL, testInfo, ['LOOK', 'LOOK TOO'], async ([id]) => {
    await page.goto('/rules')
    await body(id)
  })

test('the menu, its items and the handle are drawn in the theme, and their text is at least 4.5:1 against what it is on, resting and highlighted', async ({ page, context, baseURL }, testInfo) => {
  await withRule(page, context, baseURL!, testInfo, async (id) => {
    const actions = ruleActions(page, id)
    // The handle and the button are graphics that carry meaning: 3:1 (1.4.11), and in practice more.
    expect(await textContrast(actions)).toBeGreaterThanOrEqual(3)
    expect(await textContrast(ruleGrip(page, id))).toBeGreaterThanOrEqual(3)
    expect((await style(ruleGrip(page, id), 'color'))['color']).toBe(await resolved(page, 'color', 'var(--muted-foreground)'))

    // Opened with the keyboard, which highlights the first item at once.
    await actions.focus()
    await page.keyboard.press('Enter')
    await expect(menuAction(page, 'Edit')).toBeFocused()
    const menu = page.locator(OPEN_MENU)
    expect((await style(menu, 'background-color', 'color'))).toEqual({
      'background-color': await resolved(page, 'backgroundColor', 'var(--popover)'),
      color: await resolved(page, 'color', 'var(--popover-foreground)'),
    })
    expect((await style(page.locator('[data-slot="dropdown-menu-separator"]'), 'background-color'))['background-color']).toBe(await resolved(page, 'backgroundColor', 'var(--border)'))
    expect((await style(menuAction(page, 'Remove'), 'color'))['color']).toBe(await resolved(page, 'color', 'var(--danger)'))

    // Each item, resting and highlighted (the highlight moves down the items, so each is highlighted once and resting while another is). Remove's words are red, so it is
    // the one most likely to fall short, and a tint behind it has to leave them at 4.5:1.
    const items = ['Edit', 'Move down', 'Remove']
    for (const highlighted of items) {
      await arrowTo(page, highlighted)
      for (const action of items) expect(await textContrast(menuAction(page, action)), `${action}, ${action === highlighted ? 'highlighted' : 'resting'}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

test('Windows high contrast keeps the handle and the button as buttons, the highlighted item in the highlight colour, the line between items, and a Rule being dragged outlined', async ({ page, context, baseURL }, testInfo) => {
  await withRule(page, context, baseURL!, testInfo, async (id) => {
    await page.emulateMedia({ forcedColors: 'active' })
    const highlight = await resolved(page, 'backgroundColor', 'Highlight')
    const highlightColour = await resolved(page, 'color', 'Highlight')
    const highlightText = await resolved(page, 'color', 'HighlightText')
    const canvasText = await resolved(page, 'backgroundColor', 'CanvasText')

    // The button and the handle keep an edge (a fill is dropped), so they are still things to press.
    for (const target of [ruleActions(page, id), ruleGrip(page, id)]) {
      const edge = await style(target, 'border-top-width', 'border-top-style')
      expect(parseFloat(edge['border-top-width']!)).toBeGreaterThan(0)
      expect(edge['border-top-style']).toBe('solid')
    }

    // The menu has an edge, its highlighted item is the palette's highlight, the others have no box, and the line between items is drawn.
    await ruleActions(page, id).focus()
    await page.keyboard.press('Enter')
    await expect(menuAction(page, 'Edit')).toBeFocused()
    expect(parseFloat((await style(page.locator(OPEN_MENU), 'border-top-width'))['border-top-width']!)).toBeGreaterThan(0)
    expect(await style(menuAction(page, 'Edit'), 'background-color', 'color')).toEqual({ 'background-color': highlight, color: highlightText })
    expect((await style(menuAction(page, 'Move down'), 'outline-style'))['outline-style']).toBe('none')
    expect((await style(page.locator('[data-slot="dropdown-menu-separator"]'), 'background-color'))['background-color']).toBe(canvasText)
    await arrowTo(page, 'Remove') // the destructive item is highlighted in the same way, and its words are not the colour of its fill
    expect(await style(menuAction(page, 'Remove'), 'background-color', 'color')).toEqual({ 'background-color': highlight, color: highlightText })
    await page.keyboard.press('Escape')

    // Focus on the handle is the palette's outline, and a Rule picked up is outlined as well as lifted.
    const handle = ruleGrip(page, id)
    await ruleActions(page, id).focus()
    await page.keyboard.press('Shift+Tab') // back to the handle, as a keyboard does, so that it has focus that shows
    await expect(handle).toBeFocused()
    const ring = await style(handle, 'outline-style', 'outline-width', 'outline-color')
    expect(ring['outline-style']).toBe('solid')
    expect(parseFloat(ring['outline-width']!)).toBeGreaterThanOrEqual(2)
    expect(ring['outline-color']).toBe(highlightColour)
    await page.keyboard.press('Space')
    const picked = page.locator('tr[data-dragging="true"]')
    await expect(picked).toHaveCount(1)
    expect(await style(picked, 'outline-style', 'outline-width')).toEqual({ 'outline-style': 'solid', 'outline-width': '2px' })
    await page.keyboard.press('Escape')
  })
})

for (const size of ['Medium', 'Large'] as const) {
  test(`the Actions button, the handle and the menu's items are at least 44px at text size ${size}`, async ({ page, context, baseURL }, testInfo) => {
    await withRule(page, context, baseURL!, testInfo, async (id) => {
      await chooseTextSize(page, size)
      await expectTextSize(page, size)
      await settle(page)
      for (const target of [ruleActions(page, id), ruleGrip(page, id)]) {
        const box = (await target.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.height).toBeGreaterThanOrEqual(44)
      }
      await openActions(ruleActions(page, id))
      await settle(page)
      for (const item of await page.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      // The text is the page's 16px at Medium (and 20px at Large), not shadcn's 14px: the menu is read at the size the page is.
      expect(parseFloat((await style(menuAction(page, 'Edit'), 'font-size'))['font-size']!)).toBe(size === 'Medium' ? 16 : 20)
    })
  })
}

// The pages with their menus closed are scanned by the specs of the pages (rules.spec.ts, categories.spec.ts). Open, the menu is the part of the page that matters: the rest is hidden from a
// screen reader while it is open, and is not looked at.
test("a row's menu, open on the Rules page and on the Categories page, has no WCAG 2.2 AA violations", async ({ page, context, baseURL }, testInfo) => {
  await withRule(page, context, baseURL!, testInfo, async (id) => {
    await openActions(ruleActions(page, id))
    await noAxeViolations(page, { within: OPEN_MENU })
    await page.keyboard.press('Escape')

    await page.goto('/categories')
    await expect(page.getByRole('cell', { name: 'Groceries', exact: true })).toBeVisible()
    await openActions(actionsButton(page, 'Groceries'))
    await noAxeViolations(page, { within: OPEN_MENU })
  })
})
