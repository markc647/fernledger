import type { Page } from '@playwright/test'
import { expect } from './fixtures'

// A page's "?" and the help sheet it opens (src/components/help-sheet.tsx). The text a reader reads once is in the sheet, not on the page, so a spec that looks for it opens the sheet first.

/** What the "?" is called, and the sheet it opens (src/components/help-sheet.tsx): the same on every page. */
export const HELP_LABEL = 'About this page'

/** The "?" beside the page's heading. */
export const helpButton = (page: Page) => page.getByRole('button', { name: HELP_LABEL })

/** The sheet the "?" opens, once it is open. */
export const helpSheet = (page: Page) => page.getByRole('dialog', { name: HELP_LABEL })

/** Opens the page's help sheet and returns it, to look for what it says or to follow a link in it. `Escape` closes it. */
export async function openHelp(page: Page) {
  await helpButton(page).click()
  await expect(helpSheet(page)).toBeVisible()
  return helpSheet(page)
}
