import type { Locator, Page } from '@playwright/test'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import {
  blockStorage,
  breadcrumb,
  chooseTextSize,
  closeHeaderControls,
  contrastOf,
  expectRailUnclipped,
  expectTextSize,
  mainNav,
  navGroup,
  navLink,
  openHeaderControls,
  openNavGroup,
  rgbOf,
  showSidebar,
  siteHeader,
  sidebarTitle,
  signOutLink,
  textSizeButton,
  textSizeGroup,
  textSizeLabel,
  themeToggle,
} from './shell-helpers'

// The app shell (src/routes/__root.tsx; shadcn's sidebar-16): a sticky header across the top, the sidebar below it beside the page's raised panel, the display controls on
// the right of the header, and the sidebar's groups. The specs that look at pages leave the shell to this one: what they need of it is in shell-helpers.ts.

/** The desktop sidebar's own box: its `data-state` is `expanded` or `collapsed` (the icon rail). */
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]:not([data-mobile])')
const panel = (page: Page) => page.locator('[data-slot="sidebar-inset"]')
const toggleButton = (page: Page) => siteHeader(page).getByRole('button', { name: 'Toggle sidebar' })

// ---------------------------------------------------------------------------------------------------------------
// Layout

test.describe('layout', () => {
  test('is a sticky header across the whole top, the sidebar below it, and the page in a raised panel beside the sidebar', { tag: '@theme' }, async ({ page, context }) => {
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
    const trail = breadcrumb(page)
    await expect(trail.getByRole('listitem')).toHaveText(['Transactions', 'Import']) // the separator between them is not read
    await expect(trail.locator('[aria-current="page"]')).toHaveText('Import')
    const [toggle, crumbs] = [(await toggleButton(page).boundingBox())!, (await trail.boundingBox())!]
    expect(toggle.x).toBeLessThan(crumbs.x)

    await page.goto('/')
    await expect(trail.getByRole('listitem')).toHaveText(['Dashboard']) // a page of its own has no group
    await page.goto('/transactions')
    await expect(trail.getByRole('listitem')).toHaveText(['Transactions', 'All Transactions'])
    await page.goto('/reports')
    await expect(trail.getByRole('listitem')).toHaveText(['Reports', 'Reports'])
    await page.goto('/reports/spending') // a Report is a page of Reports: named in the trail, with Reports marked in the sidebar
    await expect(trail.getByRole('listitem')).toHaveText(['Reports', 'Spending by Category'])
    await expect(trail.locator('[aria-current="page"]')).toHaveText('Spending by Category')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Reports')).toHaveAttribute('data-active', 'true')
    // Net worth is no Report but a page with a row of its own under Reports: named in the trail, and it (not Reports) is the row marked.
    await page.goto('/reports/net-worth')
    await expect(trail.getByRole('listitem')).toHaveText(['Reports', 'Net worth'])
    await expect(trail.locator('[aria-current="page"]')).toHaveText('Net worth')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Net worth')).toHaveAttribute('data-active', 'true')
    await expect(navLink(page, 'Reports')).not.toHaveAttribute('data-active', 'true')
    await expect(mainNav(page).locator('[data-active="true"]')).toHaveCount(1)
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

  // Who is signed in arrives a moment after the page. The link at the top is called by what the reader is (the Summary, or the Admin's Dashboard), so it waits for it: its place is
  // kept, so the groups under it do not jump when it comes, and the footer says nothing in the meantime rather than a word of its own.
  test('keeps the first link\'s place while who is signed in is not known, so the groups do not jump when it arrives', async ({ page, context }) => {
    await signInAs(context, 'admin')
    let release!: () => void
    const answer = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/api/me', async (route) => {
      await answer
      await route.continue()
    })
    await page.goto('/')
    await expect(navGroup(page, 'Transactions')).toBeVisible()
    await expect(navLink(page, 'Dashboard')).toHaveCount(0) // not known yet, so not called by either name
    await expect(page.locator('[data-slot="sidebar-footer"]')).toBeEmpty()
    const before = (await navGroup(page, 'Transactions').boundingBox())!.y

    release()
    await expect(navLink(page, 'Dashboard')).toBeVisible()
    await expect(page.locator('[data-slot="sidebar-footer"]')).toContainText('admin@example.com')
    expect((await navGroup(page, 'Transactions').boundingBox())!.y).toBe(before)
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
      'Reports: Reports, Net worth',
      'Set up: Accounts, Categories, Rules, Budgets, Settings',
      'Help: Change Log, About your data, How to sign in',
    ])
    await noAxeViolations(page) // with every group open
  })

  test('lists a Member\'s: the Summary, Net worth and Accounts among the Reports, and no Set up group at all', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/')
    await expect(navLink(page, 'Summary')).toBeVisible()
    expect(await outline(page)).toEqual([
      'Summary',
      'Transactions: All Transactions',
      'Reports: Reports, Net worth, Accounts',
      'Help: Change Log, About your data, How to sign in',
    ])
    await expect(navGroup(page, 'Set up')).toHaveCount(0)
    await expect(mainNav(page).getByRole('link', { name: /^(Categories|Budgets)$/ })).toHaveCount(0)
    await noAxeViolations(page)
  })

  // The Set up group, and Categories and Budgets in it, are hidden from a Member's sidebar and from nowhere else: the pages are as open as they were, by their addresses (and the API
  // still decides what a Member may do). A Member gets to Budgets from the Summary, and the page still says where it is.
  test('hides Set up from a Member without closing its pages to them, and the pages still say where they are', async ({ page, context }) => {
    await signInAs(context, 'member')
    const trail = breadcrumb(page)
    await page.goto('/')
    await page.getByRole('region', { name: 'Budget vs actual' }).getByRole('link', { name: 'See all Budgets' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible()
    await expect(trail.getByRole('listitem')).toHaveText(['Set up', 'Budgets']) // from every page, not only the ones in this sidebar
    await expect(navGroup(page, 'Set up')).toHaveCount(0)
    await expect(mainNav(page).locator('[data-active="true"]')).toHaveCount(0) // and nothing in the sidebar is marked as here

    await page.goto('/categories')
    await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible()
    await expect(trail.getByRole('listitem')).toHaveText(['Set up', 'Categories'])
    await expect(navGroup(page, 'Set up')).toHaveCount(0)

    // Accounts has a place in a Member's sidebar: among the Reports, where it opens, and is marked.
    await page.goto('/accounts')
    await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible()
    await expect(trail.getByRole('listitem')).toHaveText(['Reports', 'Accounts'])
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Accounts')).toHaveAttribute('data-active', 'true')
    await expect(navGroup(page, 'Set up')).toHaveCount(0)
  })

  test('shows the Admin Accounts in Set up, not Reports', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/accounts')
    await expect(breadcrumb(page).getByRole('listitem')).toHaveText(['Set up', 'Accounts'])
    await expect(navGroup(page, 'Set up')).toHaveAttribute('aria-expanded', 'true')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'false')
  })

  test('opens the group that holds the current page, and opens another when it is clicked', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const [transactions, reports] = [navGroup(page, 'Transactions'), navGroup(page, 'Reports')]
    await expect(transactions).toHaveAttribute('aria-expanded', 'true')
    await expect(reports).toHaveAttribute('aria-expanded', 'false')
    await expect(navLink(page, 'Uncategorised')).toBeVisible()
    await expect(navLink(page, 'Reports')).toHaveCount(0) // a shut group has no links to tab through

    await reports.click()
    await expect(reports).toHaveAttribute('aria-expanded', 'true')
    await expect(reports).toHaveAttribute('aria-controls', /.+/) // it says which list it opens, while there is one
    await expect(navLink(page, 'Reports')).toBeVisible()
    await expect(transactions).toHaveAttribute('aria-expanded', 'true') // one group opening does not shut another

    await transactions.click()
    await expect(transactions).toHaveAttribute('aria-expanded', 'false')
    await expect(transactions).not.toHaveAttribute('aria-controls')
    await expect(navLink(page, 'Uncategorised')).toHaveCount(0)
  })

  test('opens the group of a page you arrive at from somewhere else, such as a link on the Dashboard', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/')
    await expect(navGroup(page, 'Set up')).toHaveAttribute('aria-expanded', 'false') // the Dashboard holds no group
    await page.getByRole('region', { name: 'Budget vs actual' }).getByRole('link', { name: 'Set or change Budgets' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible()
    await expect(navGroup(page, 'Set up')).toHaveAttribute('aria-expanded', 'true')
  })

  // The pill alone is a white or grey fill a hair away from the tint (1.1:1), so the row has a bar at its start that is 3:1 against the tint in both themes
  // (--sidebar-marker, pinned in scripts/theme-contrast.test.mjs), as well as the fill, the hairline, a heavier font and aria-current.
  test('marks the current page in both themes: a bar that is 3:1 against the sidebar, a fill, a heavier font and aria-current', { tag: '@theme' }, async ({ page, context }) => {
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
        const bar = getComputedStyle(el, '::before')
        return { fill: style.backgroundColor, weight: Number(style.fontWeight), bar: bar.content === 'none' ? null : { width: parseFloat(bar.width), colour: bar.backgroundColor } }
      })
    const [on, off] = [await look(current), await look(other)]
    expect(on.fill).not.toBe(off.fill)
    expect(on.fill).not.toBe('rgba(0, 0, 0, 0)')
    expect(on.weight).toBeGreaterThanOrEqual(600)
    expect(off.weight).toBeLessThan(600)
    expect(off.bar?.width ?? 0).toBe(0) // only the current row has one
    expect(on.bar?.width).toBeGreaterThanOrEqual(3)
    const [bar, tint, pill] = await rgbOf(page, [on.bar!.colour, await page.locator('[data-slot="sidebar-inner"]').evaluate((el) => getComputedStyle(el).backgroundColor), on.fill])
    expect(contrastOf(bar!, tint!), 'the bar against the sidebar').toBeGreaterThanOrEqual(3)
    expect(contrastOf(bar!, pill!), 'the bar against the pill it is drawn on').toBeGreaterThanOrEqual(3)
    // Its text is 16px at Medium: the page's size, like the rest of the sidebar (README, Accessibility: one size for all text).
    expect(await current.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(16)
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

    await toggleButton(page).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await settle(page)
    const rail = (await sidebar(page).locator('[data-slot="sidebar-container"]').boundingBox())!
    expect(rail.width).toBeLessThan(80) // icons only
    expect((await panel(page).boundingBox())!.width).toBeGreaterThan(wide.width + 100) // and the page has the room
    await expect(mainNav(page).getByRole('link', { name: 'Dashboard' })).toBeVisible() // still a named link, though only its icon shows
    await expectRailUnclipped(page) // and no icon, nor the outline round the one with focus, is cut off by the rail

    // The icon says what it is when pointed at: a group, and the app's title above them.
    await navGroup(page, 'Reports').hover()
    await expect(page.getByRole('tooltip')).toHaveText('Reports')
    await page.keyboard.press('Escape') // a tooltip can be dismissed (WCAG 1.4.13), and this one is gone before the next is wanted
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await sidebarTitle(page).getByRole('link').hover()
    await expect(page.getByRole('tooltip')).toHaveText('Fernledger')

    await page.keyboard.press('Control+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.keyboard.press('Control+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')

    // From the rail a group icon has nowhere to show its pages, so it opens the sidebar, and the group.
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'false')
    await navGroup(page, 'Reports').click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Reports')).toBeVisible()
    await noAxeViolations(page)
  })

  // The rail has no list to show, so a group does not say it is open there, though the sidebar remembers that it is: opened again, it is as it was.
  test('does not say a group is open while its list is not shown, and has it open again with the sidebar', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const group = navGroup(page, 'Transactions')
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await toggleButton(page).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(group).not.toHaveAttribute('aria-controls')
    await expect(navLink(page, 'Uncategorised')).toHaveCount(0)
    await toggleButton(page).click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(navLink(page, 'Uncategorised')).toBeVisible()
  })

  test('has a tooltip only in the rail: an open sidebar\'s rows describe nothing by one', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const group = navGroup(page, 'Reports')
    await group.hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    expect(await group.getAttribute('aria-describedby')).toBeNull()
    await toggleButton(page).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await group.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Reports')
    expect(await group.getAttribute('aria-describedby')).not.toBeNull()
  })

  test('says who is signed in from the rail, to the keyboard as well as the mouse', async ({ page, context }) => {
    await signInAs(context, 'member')
    await page.goto('/')
    await toggleButton(page).click()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    const me = (await (await context.request.get('/api/me')).json()) as { email: string }
    const who = page.locator('[data-slot="sidebar-footer"]').getByRole('group')
    await expect(who).toHaveAccessibleName(`${me.email}, Member (read-only)`)
    await page.keyboard.press('Shift') // a key, so focus is shown as it is for the keyboard
    await who.focus()
    await expect(page.getByRole('tooltip')).toHaveText(`${me.email}, Member (read-only)`)
  })

  test('is axe-clean as the rail, with the tooltip showing', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    await toggleButton(page).click()
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
    await toggleButton(page).click()
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

  // Ctrl or Cmd + B is the sidebar's when it is only that chord, not typed into a field, not held down, and nothing else has taken it.
  test('opens and closes on Ctrl+B once, and leaves the key to a field being typed in, to a held key, and to other chords', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/settings')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.getByLabel('App title').focus()
    await page.keyboard.press('Control+b') // in a text field
    await page.keyboard.press('Meta+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.getByLabel('App title').blur() // the key goes to the page again

    await page.keyboard.press('Control+Shift+b') // another chord
    await page.keyboard.press('Control+Alt+b')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.keyboard.press('Control+B') // the key as a capital (Caps Lock) is still the chord
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')

    await page.keyboard.down('Control') // held down: one press toggles once, whatever repeats
    await page.keyboard.down('b')
    await page.keyboard.down('b')
    await page.keyboard.down('b')
    await page.keyboard.up('b')
    await page.keyboard.up('Control')
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

    // A radio button is not a field: Ctrl+B works from the text size buttons.
    await textSizeButton(page, 'Medium').focus()
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
    await expectRailUnclipped(page)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded') // it follows the window until it is chosen
    await page.setViewportSize({ width: 1099, height: 800 })
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await page.setViewportSize({ width: 1100, height: 800 })
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

    await page.setViewportSize({ width: 900, height: 800 })
    await toggleButton(page).click() // chosen: open, on a window where it would start shut
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
    await expect(toggleButton(page)).toBeVisible()
    expect(await seen(page)).toEqual({ desktop: false, sheet: false }) // the sheet is only in the page while it is open
    await showSidebar(page)
    expect(await seen(page)).toEqual({ desktop: false, sheet: true })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    expect(await seen(page)).toEqual({ desktop: true, sheet: false })
  })

  const navigateToImport = async (page: Page) => {
    await openNavGroup(page, 'Transactions')
    await navLink(page, 'Import').click()
  }

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
    await expect(breadcrumb(page)).toContainText('Import')
  })

  // A tap on the link of the page you are on goes nowhere, so nothing in the address changes to close the sheet: the tap closes it.
  test('closes on a tap on any link, the link of the page you are already on and the link home included', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    const sheet = page.getByRole('dialog', { name: 'Menu' })
    for (const link of [() => navLink(page, 'Import'), () => sidebarTitle(page).getByRole('link')]) {
      await showSidebar(page)
      await expect(sheet).toBeVisible()
      await settle(page)
      await link().click()
      await expect(sheet).toBeHidden()
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible() // the link home went home
    await showSidebar(page)
    await settle(page)
    await navLink(page, 'Dashboard').click() // and so did the Dashboard's own, which is the page it is on
    await expect(sheet).toBeHidden()
  })

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
    await textSizeButton(page, 'Xtra Large').click()
    await expectTextSize(page, 'Xtra Large')
    await noAxeViolations(page)
    await page.keyboard.press('Escape')
    await expect(textSizeGroup(page)).toBeHidden()
    // The page behind kept the choice, and so does the menu when it is opened again.
    await openHeaderControls(page)
    await expect(textSizeButton(page, 'Xtra Large')).toBeChecked()
  })

  test('has a menu that is no taller than the room there is, on a short, landscape screen, and scrolls', async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.setViewportSize({ width: 640, height: 200 })
    await page.goto('/')
    await chooseTextSize(page, 'Xtra Large')
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

test('the header controls are one Tab stop each, in order, and the arrow keys choose a text size, as they do for radio buttons', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const tab = () => page.keyboard.press('Tab')
  await tab() // the skip link
  await tab()
  await expect(toggleButton(page)).toBeFocused()
  await tab()
  await expect(textSizeButton(page, 'Medium')).toBeFocused() // a group is one stop, at the chosen size...
  await page.keyboard.press('ArrowRight')
  await expect(textSizeButton(page, 'Large')).toBeFocused() // ...and an arrow key moves within it, and chooses
  await expect(textSizeButton(page, 'Large')).toBeChecked()
  await expectTextSize(page, 'Large')
  await page.keyboard.press('ArrowRight')
  await expect(textSizeButton(page, 'Xtra Large')).toBeChecked()
  await expectTextSize(page, 'Xtra Large')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(textSizeButton(page, 'Medium')).toBeChecked()
  await page.keyboard.press('ArrowLeft')
  await expect(textSizeButton(page, 'Small')).toBeChecked()
  await expectTextSize(page, 'Small')
  await page.keyboard.press('ArrowLeft') // and wraps round, as radio buttons do
  await expect(textSizeButton(page, 'Xtra Large')).toBeChecked()

  await tab()
  await expect(themeToggle(page)).toBeFocused()
  const before = await page.locator('html').getAttribute('class')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).not.toHaveAttribute('class', before ?? '')
  await tab()
  await expect(signOutLink(page)).toBeFocused()

  // The text size group is named, and its buttons have names that start with what they show.
  await expect(textSizeGroup(page).getByRole('radio')).toHaveCount(4)
  await expect(textSizeLabel(page, 'Small')).toHaveText('Small')
  await expect(textSizeLabel(page, 'Medium')).toHaveText('Medium')
  await expect(textSizeLabel(page, 'Large')).toHaveText('Large')
  await expect(textSizeLabel(page, 'Xtra Large')).toHaveText('Xtra Large')
})

test('Ctrl+B and the toggle button are both keyboard ways to the sidebar, and the toggle says whether it is open', async ({ page }) => {
  await page.goto('/')
  const toggle = toggleButton(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  await page.keyboard.press('Control+b')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

// What the browser refuses to keep (private modes, blocked site data) is not what the page needs: the text size, the theme and the sidebar all still work for the visit.
test('still works, without errors, when the browser blocks storage: the text size, the theme, and the sidebar', { tag: '@theme' }, async ({ page }, testInfo) => {
  const deviceIsDark = testInfo.project.name === 'dark'
  await blockStorage(page)
  await page.goto('/') // the fixture fails the test on any console error, uncaught error or CSP violation
  await expect(textSizeButton(page, 'Medium')).toBeChecked()
  await expect(page.locator('html')).toHaveClass(deviceIsDark ? /dark/ : /^(?!.*dark)/) // the theme follows the device
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

  await textSizeButton(page, 'Large').click()
  await expectTextSize(page, 'Large')
  await themeToggle(page).click()
  await expect(page.locator('html')).toHaveClass(deviceIsDark ? /^(?!.*dark)/ : /dark/)
  await page.keyboard.press('Control+b')
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
})

// ---------------------------------------------------------------------------------------------------------------
// Focus

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

/**
 * What draws focus on a control: its outline, and the colour of what is around it (the first solid background up from its parent). `shown` is the element that draws it, when that
 * is not the control itself (a radio button is invisible, and the word beside it is drawn).
 */
async function focusIndicator(page: Page, control: Locator, shown: Locator = control) {
  await page.keyboard.press('Shift') // a key, so focus is drawn as it is for the keyboard
  await control.focus()
  await settle(page)
  const found = await shown.evaluate((el) => {
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
  /** One of each kind of control the shell has, as the header and the sidebar show it: what takes focus, and what draws it when that is another element. */
  const controls = (page: Page): Record<string, [Locator, Locator?]> => ({
    'a button (the theme toggle)': [themeToggle(page)],
    'a button that looks like a link (Sign out)': [signOutLink(page)],
    'the sidebar toggle': [toggleButton(page)],
    'a text size button': [textSizeButton(page, 'Small'), textSizeLabel(page, 'Small')],
    'a group of the sidebar': [navGroup(page, 'Reports')],
    'a page of the sidebar': [navLink(page, 'Import')],
    'the app title': [sidebarTitle(page).getByRole('link')],
  })

  test('is drawn as a 2px outline that is 3:1 against what is behind it, on every kind of control, in this theme', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.goto('/import')
    await expect(navLink(page, 'Import')).toBeVisible()
    for (const [what, [control, shown]] of Object.entries(controls(page))) {
      const focus = await focusIndicator(page, control, shown)
      expect(focus.style, `${what}: outline style`).toBe('solid')
      expect(focus.width, `${what}: outline width`).toBeGreaterThanOrEqual(2)
      expect(focus.contrast, `${what}: ${focus.colour} on ${focus.behind}`).toBeGreaterThanOrEqual(3)
    }
  })

  test('is still drawn in Windows high contrast, as an outline in the reader\'s colour', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/import')
    await expect(navLink(page, 'Import')).toBeVisible()
    for (const [what, [control, shown]] of Object.entries(controls(page))) {
      const focus = await focusIndicator(page, control, shown)
      expect(focus.style, `${what}: outline style`).toBe('solid')
      expect(focus.width, `${what}: outline width`).toBeGreaterThanOrEqual(2)
    }
    // The outline is a colour the reader chose, not the app's: it is not drawn in the theme's ring colour.
    expect((await focusIndicator(page, themeToggle(page))).colour).toBe(await systemColour(page, 'Highlight'))
  })

  test('shows the current page and the chosen text size in Windows high contrast, with the reader\'s highlight', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/import')
    await expect(navLink(page, 'Import')).toBeVisible()
    const highlight = await systemColour(page, 'Highlight')
    const fill = (control: Locator) => control.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await fill(navLink(page, 'Import'))).toBe(highlight) // the current page...
    expect(await fill(navLink(page, 'Uncategorised'))).not.toBe(highlight) // ...and not the rest
    expect(await fill(textSizeLabel(page, 'Medium'))).toBe(highlight) // the chosen size...
    expect(await fill(textSizeLabel(page, 'Small'))).not.toBe(highlight)
    await navGroup(page, 'Transactions').click() // a shut group that holds the current page is current too
    await expect(navGroup(page, 'Transactions')).toHaveAttribute('aria-expanded', 'false')
    expect(await fill(navGroup(page, 'Transactions'))).toBe(highlight)
    expect(await fill(navGroup(page, 'Reports'))).not.toBe(highlight)
    // The breadcrumb's current page is not a link and is left as it is.
    expect(await fill(siteHeader(page).locator('[aria-current="page"]'))).not.toBe(highlight)
  })

  // The link home at the top of the sidebar is current on the Dashboard too (aria-current), but it is a link to the page and not a row for it: only the row is marked.
  test('does not fill the link home in Windows high contrast on the Dashboard, only the Dashboard\'s own row', { tag: '@theme' }, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/')
    await expect(navLink(page, 'Dashboard')).toBeVisible()
    const highlight = await systemColour(page, 'Highlight')
    const fill = (control: Locator) => control.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await fill(navLink(page, 'Dashboard'))).toBe(highlight)
    expect(await fill(sidebarTitle(page).getByRole('link'))).not.toBe(highlight)
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

test('the phone menu and the sidebar sheet have no WCAG 2.2 AA violations at Xtra Large, when open', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await chooseTextSize(page, 'Xtra Large')
  await openHeaderControls(page)
  await noAxeViolations(page)
  await closeHeaderControls(page)
  await openNavGroup(page, 'Set up')
  await noAxeViolations(page)
})
