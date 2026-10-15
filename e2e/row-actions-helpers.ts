import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures'

// The "⋯" menu on a row of the Rules and Categories tables (src/components/row-actions.tsx), and the cards on a phone: the same button and menu at every width. A spec says which
// row's actions it means and which it chooses, and not where the control is today.

/** The "⋯" button of a row. `row` is what it names: "Rule 3" for a Rule, the Category's name for a Category. */
export const actionsButton = (page: Page, row: string) => page.getByRole('button', { name: `Actions for ${row}`, exact: true })

/** The "⋯" button of every Rule, in the order the page shows them. */
export const ruleActionButtons = (page: Page) => page.getByRole('button', { name: /^Actions for Rule \d+$/ })

/** The open menu, for `noAxeViolations(page, { within: OPEN_MENU, keepScroll: true })`: while it is open the rest of the page is hidden from a screen reader, and is not what is looked at. */
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

/**
 * The contrast of an element's text against what it is drawn on, as the browser paints it (WCAG 1.4.3): the element's own fill, which may be translucent, over the first fill under it that
 * is not. Read from a canvas, which turns whatever colour space the theme is written in into the sRGB the reader sees.
 */
export const textContrast = (target: Locator) =>
  target.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const paint = (colour: string) => {
      context.fillStyle = colour
      context.fillRect(0, 0, 1, 1)
    }
    const fills: string[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const fill = getComputedStyle(node).backgroundColor
      context.clearRect(0, 0, 1, 1)
      paint(fill)
      if (context.getImageData(0, 0, 1, 1).data[3] === 0) continue // nothing there
      fills.unshift(fill)
      if (context.getImageData(0, 0, 1, 1).data[3] === 255) break // opaque: nothing under it shows
    }
    context.clearRect(0, 0, 1, 1)
    for (const fill of fills) paint(fill)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    const background = [r!, g!, b!]
    context.clearRect(0, 0, 1, 1)
    paint(getComputedStyle(element).color)
    const [tr, tg, tb] = context.getImageData(0, 0, 1, 1).data
    const luminance = ([red, green, blue]: number[]) => {
      const [lr, lg, lb] = [red!, green!, blue!].map((value) => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!
    }
    const [lighter, darker] = [luminance(background), luminance([tr!, tg!, tb!])].sort((x, y) => y - x)
    return (lighter! + 0.05) / (darker! + 0.05)
  })
