import { expect, signInAs, test } from './fixtures'

// The page does not jump sideways when a scrollbar comes and goes. Its own file because headless Chromium hides scrollbars, which would make this test pass whatever the page
// did, so it launches the browser with them back (`launchOptions` can only be set for a whole file), and checks that it has.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] }, viewport: { width: 1920, height: 560 } })

// A short page has no scrollbar and a long one has. The header's right edge, and the page's centred content, both move by the scrollbar's width (or half of it) when it comes
// and goes, unless `scrollbar-gutter: stable` (src/index.css) keeps its place. A wide window, where the page is centred, shows both.
test('does not move the page sideways between a short page (Import) and a long one (the Styleguide)', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const where = async (path: string) => {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
    return page.evaluate(() => ({
      heading: document.querySelector('h1')!.getBoundingClientRect().x,
      signOut: document.querySelector<HTMLElement>('header a[href="/cdn-cgi/access/logout"]')!.getBoundingClientRect().right,
      scrollbar: window.innerWidth - document.documentElement.clientWidth,
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
    }))
  }
  const short = await where('/import')
  const long = await where('/styleguide')
  expect(short.scrolls).toBe(false)
  expect(long.scrolls).toBe(true)
  expect(long.scrollbar, 'this run really has a scrollbar on the long page').toBeGreaterThan(0)
  expect(long.heading).toBe(short.heading)
  expect(long.signOut).toBe(short.signOut)
  expect((await where('/import')).heading).toBe(short.heading)
})
