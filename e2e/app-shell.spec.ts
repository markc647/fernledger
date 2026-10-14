import type { Locator, Page } from '@playwright/test'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import {
  chooseTextSize,
  closeHeaderControls,
  expectTextSize,
  mainNav,
  navGroup,
  navLink,
  openHeaderControls,
  openNavGroup,
  showSidebar,
  siteHeader,
  sidebarTitle,
  signOutLink,
  textSizeButton,
  textSizeGroup,
  themeToggle,
} from './shell-helpers'

// The app shell (src/routes/__root.tsx; shadcn's sidebar-16): a sticky header across the top, the sidebar below it beside the page's raised panel, the display controls on
// the right of the header, and the sidebar's groups. The specs that look at pages leave the shell to this one: what they need of it is in shell-helpers.ts.

const settle = (page: Page) => page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))

/** The desktop sidebar's own box: its `data-state` is `expanded` or `collapsed` (the icon rail). */
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"][data-variant]')
const panel = (page: Page) => page.locator('[data-slot="sidebar-inset"]')

// ---------------------------------------------------------------------------------------------------------------
// Layout

test.describe('layout', () => {
  test('is a sticky header across the whole top, the sidebar below it, and the page in a raised panel beside the sidebar', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 1280, height: 480 })
    await page.goto('/styleguide') // a page longer than the window
    await expect(page.getByRole('heading', { level: 1, name: 'Styleguide' })).toBeVisible()
    const header = siteHeader(page)

    const resting = (await header.boundingBox())!
    const raisedBox = (await panel(page).boundingBox())!
    expect(resting.x).toBe(0) // across the top...
    expect(resting.y).toBe(0)
    expect(resting.width).toBeGreaterThanOrEqual(raisedBox.x + raisedBox.width) // ...over the sidebar and the page both, not beside the sidebar
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(480 + 200) // longer than the window
    await page.mouse.wheel(0, 900)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400)
    expect((await header.boundingBox())!.y).toBe(0) // sticky: still at the top after the page has scrolled away

    const side = (await sidebar(page).locator('[data-slot="sidebar-container"]').boundingBox())!
    expect(side.x).toBe(0)
    expect(side.y).toBeCloseTo(resting.height, 0) // below the header, not beside it
    const raised = (await panel(page).boundingBox())!
    expect(raised.x).toBeGreaterThanOrEqual(side.x + side.width - 1) // beside the sidebar
    const look = await panel(page).evaluate((el) => {
      const style = getComputedStyle(el)
      return { radius: parseFloat(style.borderTopLeftRadius), border: parseFloat(style.borderTopWidth), fill: style.backgroundColor }
    })
    expect(look.radius).toBeGreaterThan(0) // raised: rounded, with an edge (an edge survives Windows high contrast, a shadow does not)...
    expect(look.border).toBeGreaterThan(0)
    expect(look.fill).not.toBe(await header.evaluate((el) => getComputedStyle(el).backgroundColor)) // ...on a tinted shell
  })

  test('has the sidebar toggle, a separator and a breadcrumb (group, then page) at the left of the header', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const header = siteHeader(page)
    const trail = header.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(trail.getByRole('listitem')).toHaveText(['Transactions', 'Import']) // the separator between them is not read
    await expect(trail.locator('[aria-current="page"]')).toHaveText('Import')
    const [toggle, crumbs] = [(await header.getByRole('button', { name: 'Toggle sidebar' }).boundingBox())!, (await trail.boundingBox())!]
    expect(toggle.x).toBeLessThan(crumbs.x)

    await page.goto('/')
    await expect(trail.getByRole('listitem')).toHaveText(['Dashboard']) // a page of its own has no group
    await page.goto('/transactions')
    await expect(trail.getByRole('listitem')).toHaveText(['Transactions', 'All Transactions'])
    await page.goto('/reports/spending') // a page under Reports is Reports
    await expect(trail.getByRole('listitem')).toHaveText(['Reports', 'Reports'])
  })

  test('is one skip link, then the header, then the sidebar, then the page, and the skip link goes to the page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).toBeFocused()
    // Shown above the sticky header, not under it.
    const box = (await skip.boundingBox())!
    expect(await skip.evaluate((el, { x, y }) => document.elementFromPoint(x, y) === el, { x: box.x + 4, y: box.y + 4 })).toBe(true)
    await page.keyboard.press('Enter')
    await expect(page.locator('main#main')).toBeFocused()
    expect(await page.locator('main').count()).toBe(1) // one main landmark
  })

  test('the signed-in email and role are at the foot of the sidebar', async ({ page, context }) => {
    for (const role of ['admin', 'member'] as const) {
      await signInAs(context, role)
      await page.goto('/')
      const me = (await (await context.request.get('/api/me')).json()) as { email: string; role: string }
      const footer = page.locator('[data-slot="sidebar-footer"]')
      await expect(footer).toContainText(me.email)
      await expect(footer).toContainText(role === 'admin' ? 'Admin' : 'Member (read-only)')
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The sidebar's groups

test.describe('the sidebar navigation', () => {
  /** Each group and its links, in order, as the sidebar lists them once every group is open; a page on its own is just its name. */
  const outline = async (page: Page) => {
    const sections: string[] = []
    for (const section of await mainNav(page).locator('[data-slot="sidebar-menu"] > li').all()) {
      const group = section.getByRole('button')
      if ((await group.count()) === 0) {
        sections.push((await section.innerText()).trim())
        continue
      }
      if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click()
      await expect(section.getByRole('link').first()).toBeVisible()
      const links = await section.getByRole('link').allInnerTexts()
      sections.push(`${(await group.innerText()).trim()}: ${links.map((text) => text.trim()).join(', ')}`)
    }
    return sections
  }

  test('lists the Admin\'s pages in groups: Dashboard, Transactions, Reports, Set up and Help', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/')
    await expect(navGroup(page, 'Set up')).toBeVisible() // once who is signed in is known
    expect(await outline(page)).toEqual([
      'Dashboard',
      'Transactions: All Transactions, Uncategorised, Import',
      'Reports: Reports, Charts',
      'Set up: Accounts, Categories, Rules, Budgets, Settings',
      'Help: Change Log, About your data, How to sign in',
    ])
    await noAxeViolations(page) // with every group open
  })

  test('lists a Member\'s: the Summary, and no Set up group at all', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/')
    await expect(navLink(page, 'Summary')).toBeVisible()
    expect(await outline(page)).toEqual([
      'Summary',
      'Transactions: All Transactions',
      'Reports: Reports, Charts',
      'Help: Change Log, About your data, How to sign in',
    ])
    await expect(navGroup(page, 'Set up')).toHaveCount(0)
    await noAxeViolations(page)
  })

  // The Set up group is hidden from a Member's sidebar and from nowhere else: the pages in it are as open as they were, by their addresses (and the API still decides what a Member may do).
  test('hides Set up from a Member without closing its pages to them', async ({ page, context }) => {
    await signInAs(context, 'member')
    for (const [path, heading] of [['/accounts', 'Accounts'], ['/categories', 'Categories'], ['/budgets', 'Budgets']] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      await expect(navGroup(page, 'Set up')).toHaveCount(0)
    }
  })

  test('opens the group that holds the current page, turns its chevron, and opens another when it is clicked', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const [transactions, reports] = [navGroup(page, 'Transactions'), navGroup(page, 'Reports')]
    const chevron = (group: Locator) => group.locator('svg').last().evaluate((el) => getComputedStyle(el).rotate)
    await expect(transactions).toHaveAttribute('aria-expanded', 'true')
    await expect(reports).toHaveAttribute('aria-expanded', 'false')
    await expect(navLink(page, 'Uncategorised')).toBeVisible()
    await expect(navLink(page, 'Charts')).toHaveCount(0) // a shut group has no links to tab through
    await settle(page)
    expect(await chevron(transactions)).toBe('90deg')
    expect(await chevron(reports)).toBe('none')

    await reports.click()
    await expect(reports).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Charts')).toBeVisible()
    await expect(transactions).toHaveAttribute('aria-expanded', 'true') // one group opening does not shut another
    await settle(page)
    expect(await chevron(reports)).toBe('90deg')

    await transactions.click()
    await expect(transactions).toHaveAttribute('aria-expanded', 'false')
    await expect(navLink(page, 'Uncategorised')).toHaveCount(0)
    await settle(page)
    expect(await chevron(transactions)).toBe('none')
  })

  test('opens the group of a page you arrive at from somewhere else, such as a Dashboard shortcut', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/')
    await expect(navGroup(page, 'Transactions')).toHaveAttribute('aria-expanded', 'false') // the Dashboard holds no group
    await page.getByRole('region', { name: 'Your tools' }).getByRole('link', { name: /^Import/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible()
    await expect(navGroup(page, 'Transactions')).toHaveAttribute('aria-expanded', 'true')
  })

  test('marks the current page in both themes: a filled row, in a heavier font, with aria-current', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const current = navLink(page, 'Import')
    const other = navLink(page, 'Uncategorised')
    await expect(current).toHaveAttribute('aria-current', 'page')
    await expect(current).toHaveAttribute('data-active', 'true')
    await expect(other).not.toHaveAttribute('aria-current', 'page')
    const look = (link: Locator) =>
      link.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fill: style.backgroundColor, weight: Number(style.fontWeight) }
      })
    const [on, off] = [await look(current), await look(other)]
    expect(on.fill).not.toBe(off.fill)
    expect(on.fill).not.toBe('rgba(0, 0, 0, 0)')
    expect(on.weight).toBeGreaterThanOrEqual(600)
    expect(off.weight).toBeLessThan(600)
    // Its text is 14px (text-sm) at Medium, like the rest of the sidebar.
    expect(await current.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(14)
  })

  test('the group holding the current page is shown as current while it is shut', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const group = navGroup(page, 'Transactions')
    await expect(group).toHaveAttribute('data-active', 'false') // its page is marked in the open group, not twice
    await group.click()
    await expect(group).toHaveAttribute('data-active', 'true') // shut, it says where you are
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The icon rail and what the sidebar remembers

test.describe('the sidebar collapses to an icon rail', () => {
  test('with the toggle button and with Ctrl+B, and a click on a group icon opens the sidebar and the group', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    const wide = (await panel(page).boundingBox())!

    await siteHeader(page).getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await settle(page)
    const rail = (await sidebar(page).locator('[data-slot="sidebar-container"]').boundingBox())!
    expect(rail.width).toBeLessThan(80) // icons only
    expect((await panel(page).boundingBox())!.width).toBeGreaterThan(wide.width + 100) // and the page has the room
    await expect(mainNav(page).getByRole('link', { name: 'Dashboard' })).toBeVisible() // still a named link, though only its icon shows

    // The icon says what it is when pointed at.
    await navGroup(page, 'Reports').hover()
    await expect(page.getByRole('tooltip')).toHaveText('Reports')

    await page.keyboard.press('Control+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.keyboard.press('Control+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')

    // From the rail a group icon has nowhere to show its pages, so it opens the sidebar, and the group.
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'false')
    await navGroup(page, 'Reports').click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Charts')).toBeVisible()
    await noAxeViolations(page)
  })

  test('is axe-clean as the rail, with the tooltip showing', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    await siteHeader(page).getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await settle(page)
    await navGroup(page, 'Help').focus()
    await page.keyboard.press('Shift')
    await expect(page.getByRole('tooltip')).toHaveText('Help')
    await noAxeViolations(page)
  })

  test('is remembered on this device, per device and not per sign-in', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/')
    await siteHeader(page).getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    expect(await page.evaluate(() => localStorage.getItem('fernledger-sidebar'))).toBe('closed')
    expect(await page.evaluate(() => document.cookie)).not.toContain('sidebar') // in localStorage, as the text size and the theme are, and not in a cookie

    await page.reload()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await signInAs(context, 'member')
    await page.reload()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')

    await page.keyboard.press('Control+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    expect(await page.evaluate(() => localStorage.getItem('fernledger-sidebar'))).toBe('open')
    await page.reload()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
  })

  test('still opens and closes, without errors, when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError')
        },
      })
    })
    await page.goto('/') // the fixture fails the test on any console error or uncaught error
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.keyboard.press('Control+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  })

  // Between a phone and a laptop (768 to 1100px) an open sidebar would take a third of the window, and pages laid out for the whole of it would be squeezed. So there the
  // sidebar starts as the icon rail, follows the width of the window while the person has not chosen, and does what they choose once they have.
  test('starts as the icon rail below 1100px wide and open above it, and what the person chooses is kept', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 900, height: 800 })
    await page.goto('/')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await settle(page)
    expect((await panel(page).boundingBox())!.width).toBeGreaterThan(900 - 100) // the page keeps nearly all of the window

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded') // it follows the window until it is chosen
    await page.setViewportSize({ width: 1099, height: 800 })
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await page.setViewportSize({ width: 1100, height: 800 })
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

    await page.setViewportSize({ width: 900, height: 800 })
    await siteHeader(page).getByRole('button', { name: 'Toggle sidebar' }).click() // chosen: open, on a window where it would start shut
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.reload()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// A phone: the sidebar is a sheet

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  /** Remembers whether either layout was ever in the page, however briefly: the desktop sidebar, or the sheet. */
  const watchLayouts = (page: Page) =>
    page.addInitScript(() => {
      const seen = { desktop: false, sheet: false }
      ;(window as unknown as { __seen: typeof seen }).__seen = seen
      new MutationObserver(() => {
        if (document.querySelector('[data-slot="sidebar-container"]')) seen.desktop = true
        if (document.querySelector('[data-slot="sidebar"][data-mobile="true"]')) seen.sheet = true
      }).observe(document, { childList: true, subtree: true })
    })
  const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: { desktop: boolean; sheet: boolean } }).__seen)

  test('never draws the desktop sidebar, not even for a moment, and a desktop never draws the sheet', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await watchLayouts(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Toggle sidebar' })).toBeVisible()
    expect(await seen(page)).toEqual({ desktop: false, sheet: false }) // the sheet is only in the page while it is open
    await showSidebar(page)
    expect(await seen(page)).toEqual({ desktop: false, sheet: true })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    expect(await seen(page)).toEqual({ desktop: true, sheet: false })
  })

  test('opens from the toggle as a dialog over the page, and closes with Escape, its own button, the page behind it and a link', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/')
    await expect(mainNav(page)).toBeHidden()
    // Found by its slot, not its role: while the sheet is open everything behind it is aria-hidden, the toggle included.
    const toggle = page.locator('[data-slot="sidebar-trigger"]')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()
    const sheet = page.getByRole('dialog', { name: 'Menu' })
    await expect(sheet).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(mainNav(page)).toBeVisible()
    await expect(sidebarTitle(page).getByText('Fernledger')).toBeVisible()
    await expect(sheet.getByText('Admin', { exact: true })).toBeVisible() // who is signed in
    await settle(page)
    const box = (await sheet.boundingBox())!
    expect(box.x).toBe(0)
    expect(box.width).toBeLessThan(390 - 40) // some of the page is left to tap on
    await noAxeViolations(page)

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(toggle).toBeFocused() // back where it came from

    await toggle.click()
    await sheet.getByRole('button', { name: 'Close menu' }).click()
    await expect(sheet).toBeHidden()

    await toggle.click()
    await expect(sheet).toBeVisible()
    await settle(page)
    await page.mouse.click(380, 400) // on the page behind
    await expect(sheet).toBeHidden()

    await navigateToImport(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible()
    await expect(sheet).toBeHidden() // going to a page closes it
    await expect(siteHeader(page).getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Import')
  })

  const navigateToImport = async (page: Page) => {
    await openNavGroup(page, 'Transactions')
    await navLink(page, 'Import').click()
  }

  test('has one header row with the controls in a menu: text size, theme and Sign out, each working', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/')
    const header = siteHeader(page)
    await expect(header.getByRole('button', { name: 'Display settings and sign out' })).toBeVisible()
    await expect(textSizeGroup(page)).toBeHidden()
    await expect(signOutLink(page)).toBeHidden()
    await expect(themeToggle(page)).toBeHidden()
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48.5)

    await openHeaderControls(page)
    await expect(textSizeGroup(page)).toBeVisible()
    await expect(themeToggle(page)).toBeVisible()
    await expect(signOutLink(page)).toHaveAttribute('href', '/cdn-cgi/access/logout')
    await textSizeButton(page, 'Large').click()
    await expectTextSize(page, 'Large')
    await noAxeViolations(page)
    await page.keyboard.press('Escape')
    await expect(textSizeGroup(page)).toBeHidden()
    // The page behind kept the choice, and so does the menu when it is opened again.
    await openHeaderControls(page)
    await expect(textSizeButton(page, 'Large')).toBeChecked()
  })

  test('has a menu that is no taller than the room there is, on a short, landscape screen, and scrolls', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 640, height: 200 })
    await page.goto('/')
    await chooseTextSize(page, 'Large')
    await openHeaderControls(page)
    const menu = page.locator('[data-slot="popover-content"]')
    const box = (await menu.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(200) // it is cut to the window...
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true) // ...and what does not fit is reached by scrolling it
    await signOutLink(page).scrollIntoViewIfNeeded()
    await expect(signOutLink(page)).toBeInViewport()
    await closeHeaderControls(page)
  })

})

// ---------------------------------------------------------------------------------------------------------------
// The header's controls, from the keyboard

test('the header controls are one Tab stop each, in order, and work from the keyboard', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const tab = () => page.keyboard.press('Tab')
  await tab() // the skip link
  await tab()
  await expect(siteHeader(page).getByRole('button', { name: 'Toggle sidebar' })).toBeFocused()
  await tab()
  await expect(textSizeButton(page, 'Medium')).toBeFocused() // a group is one stop, at the chosen size...
  await page.keyboard.press('ArrowRight')
  await expect(textSizeButton(page, 'Large')).toBeFocused() // ...and the arrow keys move within it
  await page.keyboard.press('Space')
  await expectTextSize(page, 'Large')
  await expect(textSizeButton(page, 'Large')).toBeChecked()
  await page.keyboard.press('ArrowLeft')
  await expect(textSizeButton(page, 'Medium')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(textSizeButton(page, 'Small')).toBeFocused()
  await page.keyboard.press('Enter')
  await expectTextSize(page, 'Small')
  await page.keyboard.press('Enter') // pressing the chosen size again keeps it: one size is always chosen
  await expectTextSize(page, 'Small')
  await expect(textSizeButton(page, 'Small')).toBeChecked()

  await tab()
  await expect(themeToggle(page)).toBeFocused()
  const before = await page.locator('html').getAttribute('class')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).not.toHaveAttribute('class', before ?? '')
  await tab()
  await expect(signOutLink(page)).toBeFocused()

  // The text size group has accessible names that start with what the buttons show.
  await expect(textSizeGroup(page).getByRole('radio')).toHaveText(['Small', 'Medium', 'Large'])
  await expect(textSizeGroup(page).getByRole('radio', { name: 'Small text' })).toBeVisible()
  await expect(textSizeGroup(page).getByRole('radio', { name: 'Medium text' })).toBeVisible()
  await expect(textSizeGroup(page).getByRole('radio', { name: 'Large text' })).toBeVisible()
})

test('Ctrl+B and the toggle button are both keyboard ways to the sidebar, and the toggle says whether it is open', async ({ page }) => {
  await page.goto('/')
  const toggle = siteHeader(page).getByRole('button', { name: 'Toggle sidebar' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  await page.keyboard.press('Control+b')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

// ---------------------------------------------------------------------------------------------------------------
// Focus

/** A colour, as the page draws it (red, green, blue). Canvas reads any CSS colour, including the oklch the theme uses. */
const rgbOf = (page: Page, colours: string[]) =>
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

const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!
}
const contrastOf = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** What the reader's palette draws a system colour (Highlight) as, asked of a probe: the same string a computed style gives. */
const systemColour = (page: Page, name: string) =>
  page.evaluate((colour) => {
    const probe = document.createElement('div')
    probe.style.color = colour
    document.body.append(probe)
    const computed = getComputedStyle(probe).color
    probe.remove()
    return computed
  }, name)

/** What draws focus on a control: its outline, and the colour of what is around it (the first solid background up from its parent). */
async function focusIndicator(page: Page, control: Locator) {
  await page.keyboard.press('Shift') // a key, so focus is drawn as it is for the keyboard
  await control.focus()
  await settle(page)
  const found = await control.evaluate((el) => {
    const style = getComputedStyle(el)
    let behind = el.parentElement
    while (behind && /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(getComputedStyle(behind).backgroundColor)) behind = behind.parentElement
    return {
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      colour: style.outlineColor,
      behind: behind ? getComputedStyle(behind).backgroundColor : 'rgb(255, 255, 255)',
    }
  })
  const [colour, behind] = await rgbOf(page, [found.colour, found.behind])
  return { ...found, contrast: contrastOf(colour!, behind!) }
}

test.describe('focus', () => {
  /** One of each kind of control the shell has, as the header and the sidebar show it. */
  const controls = (page: Page) => ({
    'a button (the theme toggle)': themeToggle(page),
    'a button that looks like a link (Sign out)': signOutLink(page),
    'the sidebar toggle': siteHeader(page).getByRole('button', { name: 'Toggle sidebar' }),
    'a text size button': textSizeButton(page, 'Small'),
    'a group of the sidebar': navGroup(page, 'Reports'),
    'a page of the sidebar': navLink(page, 'Import'),
    'the app title': sidebarTitle(page).getByRole('link'),
  })

  test('is drawn as a 2px outline that is 3:1 against what is behind it, on every kind of control, in this theme', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    await expect(navLink(page, 'Import')).toBeVisible()
    for (const [what, control] of Object.entries(controls(page))) {
      const focus = await focusIndicator(page, control)
      expect(focus.style, `${what}: outline style`).toBe('solid')
      expect(focus.width, `${what}: outline width`).toBeGreaterThanOrEqual(2)
      expect(focus.contrast, `${what}: ${focus.colour} on ${focus.behind}`).toBeGreaterThanOrEqual(3)
    }
  })

  test('is still drawn in Windows high contrast, as an outline in the reader\'s colour', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/import')
    await expect(navLink(page, 'Import')).toBeVisible()
    for (const [what, control] of Object.entries(controls(page))) {
      const focus = await focusIndicator(page, control)
      expect(focus.style, `${what}: outline style`).toBe('solid')
      expect(focus.width, `${what}: outline width`).toBeGreaterThanOrEqual(2)
    }
    // The outline is a colour the reader chose, not the app's: it is not drawn in the theme's ring colour.
    expect((await focusIndicator(page, themeToggle(page))).colour).toBe(await systemColour(page, 'Highlight'))
  })

  test('shows the current page and the chosen text size in Windows high contrast, with the reader\'s highlight', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/import')
    await expect(navLink(page, 'Import')).toBeVisible()
    const highlight = await systemColour(page, 'Highlight')
    const fill = (control: Locator) => control.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await fill(navLink(page, 'Import'))).toBe(highlight) // the current page...
    expect(await fill(navLink(page, 'Uncategorised'))).not.toBe(highlight) // ...and not the rest
    expect(await fill(textSizeButton(page, 'Medium'))).toBe(highlight) // the chosen size...
    expect(await fill(textSizeButton(page, 'Small'))).not.toBe(highlight)
    await navGroup(page, 'Transactions').click() // a shut group that holds the current page is current too
    await expect(navGroup(page, 'Transactions')).toHaveAttribute('aria-expanded', 'false')
    expect(await fill(navGroup(page, 'Transactions'))).toBe(highlight)
    expect(await fill(navGroup(page, 'Reports'))).not.toBe(highlight)
    // The breadcrumb's current page is not a link and is left as it is.
    expect(await fill(siteHeader(page).locator('[aria-current="page"]'))).not.toBe(highlight)
  })

  // The header sticks to the top. Going back up a long page, the browser brings what has focus to the top edge of the window, which would be under the header
  // (WCAG 2.4.11) if the page did not keep room for it (`scroll-padding-top`, src/index.css).
  test('is never hidden under the sticky header as you tab back up a long page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 })
    await page.goto('/styleguide')
    await expect(page.getByRole('heading', { level: 1, name: 'Styleguide' })).toBeVisible()
    await page.keyboard.press('Shift+Tab') // from the top of the page, to the last thing on it
    const header = (await siteHeader(page).boundingBox())!
    let climbed = 0
    for (let i = 0; i < 40; i++) {
      const box = await page.evaluate(() => {
        const rect = document.activeElement!.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, scrollY: window.scrollY }
      })
      if (box.scrollY > 0) {
        climbed++
        expect(box.top, `Shift+Tab ${i}: the focused element is not under the header`).toBeGreaterThanOrEqual(header.y + header.height - 1)
      }
      await page.keyboard.press('Shift+Tab')
    }
    expect(climbed, 'the page really was scrolled while the focus climbed it').toBeGreaterThan(10)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Print

test.describe('print', () => {
  test('is the page alone: no header, no sidebar (open, or the rail), and no raised panel around it', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/how-to-sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'How to sign in' })).toBeVisible()
    for (const state of ['expanded', 'collapsed'] as const) {
      await page.emulateMedia({ media: 'print' })
      await expect(siteHeader(page)).toBeHidden()
      await expect(mainNav(page)).toBeHidden()
      await expect(sidebar(page)).toBeHidden()
      const raised = await panel(page).evaluate((el) => {
        const style = getComputedStyle(el)
        return { margin: style.marginLeft, radius: style.borderTopLeftRadius, shadow: style.boxShadow, border: style.borderTopWidth }
      })
      expect(raised).toMatchObject({ margin: '0px', radius: '0px', border: '0px' })
      expect(raised.shadow === 'none' || /^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(raised.shadow), `no shadow, but ${raised.shadow}`).toBe(true) // none, or only transparent ones
      expect((await panel(page).boundingBox())!.x).toBe(0) // the page starts at the left of the paper, not after a sidebar's worth of nothing
      await page.emulateMedia({ media: 'screen' })
      if (state === 'expanded') await page.keyboard.press('Control+b')
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Accessibility of what opens

test('the phone menu and the sidebar sheet have no WCAG 2.2 AA violations at the largest text size, when open', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await chooseTextSize(page, 'Large')
  await openHeaderControls(page)
  await noAxeViolations(page)
  await closeHeaderControls(page)
  await openNavGroup(page, 'Set up')
  await noAxeViolations(page)
})
