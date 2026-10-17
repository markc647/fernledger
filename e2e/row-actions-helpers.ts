import type { Locator, Page } from '@playwright/test'
import { expect, noAxeViolations } from './fixtures'
import { contrastOf, rgbOf, type Rgb } from './shell-helpers'

// The "⋯" menu on a row of the Rules, Categories, Accounts, Budgets, Transactions and kept Reports tables (src/components/row-actions.tsx), and the cards on a phone: the same button and menu at every width. A spec says which
// row's actions it means and which it chooses, and not where the control is today.

/** The "⋯" button of a row. `row` is what it names: "Rule 3" for a Rule, the Category's name for a Category. */
export const actionsButton = (page: Page, row: string) => page.getByRole('button', { name: `Actions for ${row}`, exact: true })

/** The "⋯" button of every Rule, in the order the page shows them. */
export const ruleActionButtons = (page: Page) => page.getByRole('button', { name: /^Actions for Rule \d+$/ })

/**
 * Axe on the page from the top of it (`fromTop`, e2e/fixtures.ts), for the specs of a page with a long list of rows with buttons: the Rules, the Categories and the menus of their rows.
 * The sticky header can be over most of a row's button wherever the page is scrolled to, which axe reads as a target too small to press.
 */
export const noAxeViolationsFromTop = (page: Page) => noAxeViolations(page, { fromTop: true })

/** The open menu, for `noAxeViolations(page, { within: OPEN_MENU })`: while it is open the rest of the page is hidden from a screen reader, and is not what is looked at. */
export const OPEN_MENU = '[data-slot="dropdown-menu-content"]'

/** The open menu's item by its words. */
export const menuAction = (page: Page, action: string) => page.getByRole('menuitem', { name: action, exact: true })

/** Opens the row's menu. (While it is open the rest of the page is hidden from a screen reader, the button too, so it is no longer found by its role: ask the menu.) */
export async function openActions(button: Locator) {
  await button.click()
  await expect(button.page().getByRole('menu')).toBeVisible()
}

/** With the menu open, the arrow keys down to an item (skipping the ones that are turned off, as they do), to choose it with the keyboard. */
export async function arrowTo(page: Page, action: string) {
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '')
  for (let presses = 0; presses < 6; presses++) {
    const was = await focused()
    if (was === action) return
    await page.keyboard.press('ArrowDown')
    await expect.poll(focused).not.toBe(was) // the next item has focus before the next press
  }
  await expect(menuAction(page, action)).toBeFocused()
}

/** Opens the row's menu and chooses an item. */
export async function chooseAction(button: Locator, action: string) {
  await openActions(button)
  await menuAction(button.page(), action).click()
}

/** Opens the "⋯" menu of the row `row` names ("Rule 3", an Account's name, a Transaction's "description, date") and chooses an item: what a spec does where the page once had a button on the row. */
export const rowAction = (page: Page, row: string, action: string) => chooseAction(actionsButton(page, row), action)

/**
 * The contrast of an element's text against what it is drawn on, as the browser paints it (WCAG 1.4.3): the fills of the element and of each element it is in, the first of them over
 * the page, laid one over the next (a translucent fill, such as a tint, shows what is under it).
 */
export async function textContrast(target: Locator) {
  const { text, fills } = await target.evaluate((element) => {
    const fills: string[] = []
    for (let node: Element | null = element; node; node = node.parentElement) fills.unshift(getComputedStyle(node).backgroundColor)
    return { text: getComputedStyle(element).color, fills }
  })
  const [colour, ...layers] = await rgbOf(target.page(), [text, ...fills])
  let behind: Rgb = { r: 255, g: 255, b: 255 }
  for (const layer of layers) {
    const alpha = layer.a / 255
    behind = { r: layer.r * alpha + behind.r * (1 - alpha), g: layer.g * alpha + behind.g * (1 - alpha), b: layer.b * alpha + behind.b * (1 - alpha) }
  }
  return contrastOf(colour!, behind)
}
