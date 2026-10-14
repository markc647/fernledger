import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures'

// The app shell (src/routes/__root.tsx): a sticky header across the top (the page's banner), and the sidebar beside the page. On a phone the sidebar is a sheet and the
// header's controls are in one menu. These find the same things at every width, so a spec says what it does and not where the control is today.

export type TextSizeName = 'Small' | 'Medium' | 'Large'

/** The value `data-text-size` takes for each size (src/lib/text-size.ts). */
const TEXT_SIZE_VALUE = { Small: 'small', Medium: 'medium', Large: 'large' } as const

/** The sticky header across the top of the page. */
export const siteHeader = (page: Page) => page.getByRole('banner')

/** The top of the sidebar, with the app's title: a link home. */
export const sidebarTitle = (page: Page) => page.locator('[data-slot="sidebar-header"]')

/** The navigation in the sidebar. It is in the page while the sidebar is the icon rail, and while it is a sheet only once the sheet is open. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })

/** The button of the header that opens the menu of its controls, which is all a phone's header has of them. Not visible from `md` up. */
const displayMenuButton = (page: Page) => siteHeader(page).getByRole('button', { name: 'Display settings and sign out' })

/** The header's controls are in its bar from `md` up and in one menu below: opens the menu when the bar doesn't have them. */
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

/** The text size buttons, wherever this width has them (the open menu on a phone). To a screen reader a single-choice toggle group is a group of radio buttons. */
export const textSizeGroup = (page: Page) => page.getByRole('radiogroup', { name: 'Text size' })

/** One of the text size buttons, by the word on it. */
export const textSizeButton = (page: Page, size: TextSizeName) => textSizeGroup(page).getByRole('radio', { name: `${size} text`, exact: true })

/** Chooses a text size, opening the phone's menu to do it and putting it away after. */
export async function chooseTextSize(page: Page, size: TextSizeName) {
  await openHeaderControls(page)
  await textSizeButton(page, size).click()
  await expectTextSize(page, size)
  await closeHeaderControls(page)
}

/** The text size that is applied to the page, which is what every layout measurement depends on. */
export const expectTextSize = (page: Page, size: TextSizeName) => expect(page.locator('html')).toHaveAttribute('data-text-size', TEXT_SIZE_VALUE[size])

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

/** A page's link in the sidebar, by its label there. Only in the page once its group is open. */
export const navLink = (page: Page, label: string) => mainNav(page).getByRole('link', { name: label, exact: true })

/** Goes to a page by its link in the sidebar, opening the sidebar and the page's group first (none for a link of its own, like the Dashboard). */
export async function navigateTo(page: Page, label: string, group?: string) {
  if (group) await openNavGroup(page, group)
  else await showSidebar(page)
  await navLink(page, label).click()
}
