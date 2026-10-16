import type { Locator, Page } from '@playwright/test'
import { expect, settle } from './fixtures'

// The app shell (src/routes/__root.tsx): a sticky header across the top (the page's banner), and the sidebar beside the page. On a phone the sidebar is a sheet and the
// header's controls are in one menu. These find the same things at every width, so a spec says what it does and not where the control is today.

export type TextSizeName = 'Small' | 'Medium' | 'Large' | 'Xtra Large'

/** The value `data-text-size` takes for each size (src/lib/text-size.ts). */
const TEXT_SIZE_VALUE = { Small: 'small', Medium: 'medium', Large: 'large', 'Xtra Large': 'xlarge' } as const

/** The sticky header across the top of the page. */
export const siteHeader = (page: Page) => page.getByRole('banner')

/** Where the page is, in the header: the group, then the page. */
export const breadcrumb = (page: Page) => siteHeader(page).getByRole('navigation', { name: 'Breadcrumb' })

/** The top of the sidebar, with the app's title: a link home. */
export const sidebarTitle = (page: Page) => page.locator('[data-slot="sidebar-header"]')

/** The navigation in the sidebar. It is in the page while the sidebar is the icon rail, and while it is a sheet only once the sheet is open. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })

/** The button of the header that opens the menu of its controls, which is all a phone's header has of them. Not visible from `md` up. */
const displayMenuButton = (page: Page) => siteHeader(page).getByRole('button', { name: 'Display settings and sign out' })

/** The header's controls are in its bar from `md` up, while the bar is 46rem wide, and in one menu otherwise: opens the menu when the bar doesn't have them. */
export async function openHeaderControls(page: Page) {
  const trigger = displayMenuButton(page)
  await expect(trigger.or(textSizeGroup(page))).toBeVisible() // the header is drawn: `isVisible` below does not wait for it
  if (await trigger.isVisible()) {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  }
}

/** Puts the phone's menu away, so it isn't over the page the spec goes on to use. */
export async function closeHeaderControls(page: Page) {
  const trigger = displayMenuButton(page)
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Escape')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  }
}

/** The text size buttons, wherever this width has them (the open menu on a phone): a group of four radio buttons. */
export const textSizeGroup = (page: Page) => page.getByRole('group', { name: 'Text size' })

/** One of the text size buttons (a radio button), by the word on it. */
export const textSizeButton = (page: Page, size: TextSizeName) => textSizeGroup(page).getByRole('radio', { name: `${size} text`, exact: true })

/** What a text size button looks like: the radio button is invisible and on top, and the word beside it is drawn, filled when it is chosen and outlined when it has focus. */
export const textSizeLabel = (page: Page, size: TextSizeName) => textSizeButton(page, size).locator('xpath=following-sibling::span')

/** Chooses a text size, opening the phone's menu to do it and putting it away after. */
export async function chooseTextSize(page: Page, size: TextSizeName) {
  await openHeaderControls(page)
  await textSizeButton(page, size).click()
  await expectTextSize(page, size)
  await closeHeaderControls(page)
}

/**
 * Runs `check` at each text size the control offers (Small, Medium, Large and Xtra Large: 14px, 16px, 18px and 20px), so a size added to it is covered without the spec being told. It fails
 * unless there are four, the largest being 20px or more, as README Accessibility promises. The size is chosen at the width the page has when this is called (a laptop's header has the buttons in its bar, a phone's has them in a menu), and `check` may change
 * the width: the next size is chosen from the width this started at.
 */
export async function atEveryTextSize(page: Page, check: (size: string) => Promise<void>) {
  const start = page.viewportSize()!
  await openHeaderControls(page)
  const count = await textSizeGroup(page).getByRole('radio').count()
  await closeHeaderControls(page)
  expect(count).toBeGreaterThanOrEqual(4)
  let largest = 0
  for (let i = 0; i < count; i++) {
    await page.setViewportSize(start)
    await openHeaderControls(page)
    // The label, which holds the radio button and the word drawn beside it: once a keyboard has been used (closing the phone's menu with Escape) the menu opens with focus on its first
    // radio button, whose word is then drawn over it, and a click on the radio button itself is refused as intercepted. A click on the label is a click on either.
    const option = textSizeGroup(page).locator('label').nth(i)
    await option.click()
    await expect(option.getByRole('radio')).toBeChecked()
    await closeHeaderControls(page)
    const root = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
    largest = Math.max(largest, root)
    await settle(page)
    await check(`text size ${i + 1} of ${count} (${root}px)`)
  }
  expect(largest).toBeGreaterThanOrEqual(20)
}

/** The text size that is applied to the page, which is what every layout measurement depends on. */
export const expectTextSize = (page: Page, size: TextSizeName) => expect(page.locator('html')).toHaveAttribute('data-text-size', TEXT_SIZE_VALUE[size])

/** Makes the browser refuse `localStorage`, as private modes and blocked site data do: reading it throws. For a spec of what still works without it. */
export const blockStorage = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage is blocked', 'SecurityError')
      },
    })
  })

/**
 * Changes the device's light or dark setting, and waits until the page has heard of it and had a frame to draw what it does with it, so a spec can say that the page did
 * not move (there is nothing to wait for otherwise) as well as that it did.
 */
export async function changeDeviceScheme(page: Page, scheme: 'light' | 'dark') {
  // Listening first (awaited, so it is there before the change), and read after.
  await page.evaluate(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const heard = new Promise<void>((resolve) => query.addEventListener('change', () => requestAnimationFrame(() => resolve()), { once: true }))
    Object.assign(window, { __deviceSchemeHeard: heard, __deviceSchemeQuery: query }) // the query is kept, or it may be collected, and its listener with it
  })
  await page.emulateMedia({ colorScheme: scheme })
  await page.evaluate(() => (window as unknown as { __deviceSchemeHeard: Promise<void> }).__deviceSchemeHeard)
}

/** The Sign out link, in the header's bar or in its open menu. */
export const signOutLink = (page: Page) => page.getByRole('link', { name: 'Sign out' })

/** The button that switches the theme, whichever it will switch to. */
export const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (light|dark) theme$/ })

/** Opens the sidebar when this width keeps it away (a phone's sheet), so that what is in it can be found and used. */
export async function showSidebar(page: Page) {
  const nav = mainNav(page)
  // Found by its slot, not its role: while the sheet is open everything behind it, the toggle included, is aria-hidden.
  const toggle = page.locator('[data-slot="sidebar-trigger"]')
  await expect(toggle).toBeVisible() // the shell is drawn, so the navigation is there if this width has it: `isVisible` does not wait
  if (!(await nav.isVisible())) {
    await toggle.click()
    await expect(nav).toBeVisible()
  }
}

/** A group's button in the sidebar. */
export const navGroup = (page: Page, group: string): Locator => mainNav(page).getByRole('button', { name: group, exact: true })

/** Opens a group of the sidebar if it is shut (and the sidebar if it is a sheet or the icon rail). */
export async function openNavGroup(page: Page, group: string) {
  await showSidebar(page)
  const trigger = navGroup(page, group)
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Every icon of the collapsed sidebar, and the 2px outline round the one with focus, are inside the part of the sidebar that does not cut things off. (A 44px icon in a rail too
 * narrow for it is cut off, and a box measured with `boundingBox` does not say so: it is the whole box, cut or not.)
 */
export async function expectRailUnclipped(page: Page) {
  const content = (await page.locator('[data-slot="sidebar-content"]').boundingBox())!
  const rows = [...(await mainNav(page).getByRole('button').all()), ...(await mainNav(page).getByRole('link').all())]
  expect(rows.length).toBeGreaterThan(4)
  for (const row of rows) {
    const box = (await row.boundingBox())!
    expect(box.x, 'room for its outline on the left').toBeGreaterThanOrEqual(content.x + 2 - 0.5)
    expect(box.x + box.width, 'room for its outline on the right').toBeLessThanOrEqual(content.x + content.width - 2 + 0.5)
  }
}

/** A page's link in the sidebar, by its label there. Only in the page once its group is open. */
export const navLink = (page: Page, label: string) => mainNav(page).getByRole('link', { name: label, exact: true })

/** Goes to a page by its link in the sidebar, opening the sidebar and the page's group first (none for a link of its own, like the Dashboard). */
export async function navigateTo(page: Page, label: string, group?: string) {
  if (group) await openNavGroup(page, group)
  else await showSidebar(page)
  await navLink(page, label).click()
}

// Colour, as the page draws it: for the specs that hold a contrast to WCAG (the sidebar, the menu of a row's actions).

/** A colour, as the page draws it (red, green, blue). Canvas reads any CSS colour, including the oklch the theme uses. */
export const rgbOf = (page: Page, colours: string[]) =>
  page.evaluate((list) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    return list.map((css) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = css
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return { r: r!, g: g!, b: b!, a: a! }
    })
  }, colours)

export type Rgb = { r: number; g: number; b: number }

const luminance = ({ r, g, b }: Rgb) => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!
}
/** WCAG's contrast ratio of two colours (1.4.3, 1.4.11). */
export const contrastOf = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
