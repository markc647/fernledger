import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'
import { openHelp } from './help-helpers'
import { openApplyDialog, ruleActions, withRules } from './rule-helpers'
import { openActions } from './row-actions-helpers'

// The page stays where it is when a menu, a sheet or a question opens. Radix locks the page's scroll while one is open (react-remove-scroll), which hides the page's scrollbar and adds the
// scrollbar's width to the body as a margin, to make up for the room it took. The page already keeps the scrollbar's place (`scrollbar-gutter: stable`, src/index.css), so that margin
// moved everything a second time. Its own file because headless Chromium hides scrollbars, which would make this test pass whatever the page did, so it launches the browser with them
// back (`launchOptions` can only be set for a whole file), and checks that it has.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

/** Where the header, the page's content and the header's buttons and links are (a text size button moves when the header does). */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const { x, width } = element.getBoundingClientRect()
      return { x, width }
    }
    return {
      header: box(document.querySelector('header')!),
      main: box(document.querySelector('main')!),
      controls: [...document.querySelectorAll('header a, header button')].map(box),
    }
  })

/** The width of the page's scrollbar, which is nothing when the page fits the window, or when the scroll is locked. */
const scrollbar = (page: Page) => page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)

// On a page taller than the window, which has a scrollbar to hide, and on one that fits, which has none (the library then has no room to make up for, and the page is the same).
for (const { page: kind, height, scrolls } of [
  { page: 'a page that scrolls', height: 360, scrolls: true },
  { page: 'a page that fits the window', height: 1600, scrolls: false },
]) {
  test(`does not move the page sideways when a row's menu, the page's help sheet or the question about applying the Rules opens, on ${kind}`, async ({ page, context, baseURL }, testInfo) => {
    // Eight Rules, so that the page is taller than a window 360px high.
    await withRules(context, baseURL!, testInfo, ['LOCK 1', 'LOCK 2', 'LOCK 3', 'LOCK 4', 'LOCK 5', 'LOCK 6', 'LOCK 7', 'LOCK 8'], async ([rule]) => {
      await page.setViewportSize({ width: 1600, height })
      await page.goto('/rules')
      await expect(ruleActions(page, rule)).toBeVisible()
      await settle(page)
      const before = await layout(page)
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), `the page ${scrolls ? 'scrolls' : 'fits'}`).toBe(scrolls)
      if (scrolls) expect(await scrollbar(page), 'this run really has a scrollbar').toBeGreaterThan(0)

      const overlays = [
        { name: "a row's menu", open: () => openActions(ruleActions(page, rule)) },
        { name: "the page's help sheet", open: () => openHelp(page) },
        { name: 'the question about applying the Rules', open: () => openApplyDialog(page) },
      ]
      for (const { name, open } of overlays) {
        await open()
        await settle(page)
        // It has locked the page's scroll (otherwise this proves nothing: the scrollbar is gone), and nothing has moved by even a pixel.
        await expect(page.locator('body[data-scroll-locked]'), `${name} locks the page's scroll`).toHaveCount(1)
        expect(await scrollbar(page), `${name} hides the scrollbar`).toBe(0)
        expect(await layout(page), name).toEqual(before)
        await page.keyboard.press('Escape')
        await expect(page.locator('body[data-scroll-locked]'), `${name} is closed`).toHaveCount(0)
        await settle(page)
        expect(await layout(page), `${name}, closed again`).toEqual(before)
      }
    })
  })
}
