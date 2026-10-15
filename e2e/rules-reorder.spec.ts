import type { Locator, Page } from '@playwright/test'
import { expect, noAxeViolations, test } from './fixtures'
import { pageOrder, ruleActions, ruleGrip, ruleIds, runningJob, withRules } from './rule-helpers'
import { menuAction, noAxeViolationsFromTop, OPEN_MENU, openActions } from './row-actions-helpers'

// Putting the Rules in order by dragging (src/components/sortable-rows.tsx): with a mouse, with a finger, and with the keyboard, and what the page does when the Worker does not take the order.
// The Rules page's other specs, and the Move up and Move down items of the Actions menu (the way to do it without dragging), are in rules.spec.ts. A spec works only with the Rules it makes,
// and takes them away again: the order of the Rules is the same for every spec and both themes.

const INSTRUCTIONS = 'To move a Rule, press Space or Enter on its handle. Use the up and down arrow keys to choose its new place, then press Space or Enter to drop it. Press Escape to cancel.'

/** The centre of an element, once it is in the window. */
async function centreOf(target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * A pointer drag of one Rule's handle to another's place. dnd-kit starts a drag once the pointer has moved a few pixels, and works out which row it is over as it moves, so the pointer goes
 * in steps and not in one jump. `hold` is what is looked at while the Rule is held, before it is dropped.
 */
async function dragHandle(page: Page, from: number, to: number, hold?: () => Promise<void>) {
  await ruleGrip(page, to).scrollIntoViewIfNeeded()
  const start = await centreOf(ruleGrip(page, from))
  const end = await centreOf(ruleGrip(page, to))
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x, start.y + (end.y > start.y ? 8 : -8), { steps: 4 })
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await hold?.()
  await page.mouse.up()
}

const status = (page: Page, text: RegExp) => page.getByRole('status').filter({ hasText: text })

/** What the page sends to put the Rules in order, each time it does. */
const watchOrders = (page: Page) => {
  const puts: string[] = []
  page.on('request', (request) => request.method() === 'PUT' && request.url().endsWith('/api/rules/order') && puts.push(request.postData() ?? ''))
  return puts
}

test.describe.configure({ mode: 'serial' })

test('the Admin drags a Rule to a new place with the mouse, up as well as down, and the Worker has the new order', async ({ page, context, baseURL }, testInfo) => {
  await withRules(context, baseURL!, testInfo, ['FIRST', 'SECOND', 'THIRD'], async ([a, b, c]) => {
    const mine = (ids: number[]) => ids.filter((id) => id === a || id === b || id === c)
    const puts = watchOrders(page)
    await page.goto('/rules')
    const all = await ruleIds(context)
    const total = all.length
    await expect(ruleGrip(page, a)).toHaveAccessibleName(`Drag to reorder Rule ${all.indexOf(a) + 1}`)

    // Pressing the handle and letting go where it was is not a move, and sends nothing (the first drag below is the first order sent, which it would not be if this had sent one).
    await ruleGrip(page, a).click()
    expect(puts).toEqual([])
    await expect(page.getByRole('status').filter({ hasText: /^Moved/ })).toHaveCount(0)

    // First onto third: it takes the third's place, and the other two move up. While it is held it is lifted from the others.
    await dragHandle(page, a, c, async () => {
      await expect(page.locator('tr[data-dragging="true"]')).toHaveCount(1)
      await expect(ruleGrip(page, a)).toHaveAttribute('aria-pressed', 'true')
    })
    await expect(status(page, /^Moved Rule/)).toContainText(`Moved Rule ${all.indexOf(a) + 1} to position ${all.indexOf(c) + 1} of ${total}.`)
    await expect(status(page, /^Moved Rule/)).toContainText('To use the change on the Transactions you already have, choose Apply the Rules to all Transactions')
    expect(mine(await ruleIds(context))).toEqual([b, c, a])
    expect(await pageOrder(page, a, b, c)).toEqual([b, c, a])
    expect(puts).toHaveLength(1)
    expect(JSON.parse(puts[0]!)).toEqual({ ids: await ruleIds(context) }) // the whole new order, as the Worker's own list has it
    await expect(page.locator('tr[data-dragging="true"]')).toHaveCount(0)

    // And back up: the last (now the third) takes the first's place (now the first).
    await dragHandle(page, a, b)
    await expect(status(page, /^Moved Rule/)).toContainText(`Moved Rule ${all.indexOf(c) + 1} to position ${all.indexOf(a) + 1} of ${total}.`)
    await expect.poll(async () => mine(await ruleIds(context))).toEqual([a, b, c])
    expect(await pageOrder(page, a, b, c)).toEqual([a, b, c])
    expect(puts).toHaveLength(2)
  })
})

test('the Admin moves a Rule with the keyboard, hears where it is, and can change their mind', async ({ page, context, baseURL }, testInfo) => {
  await withRules(context, baseURL!, testInfo, ['FIRST', 'SECOND', 'THIRD'], async ([a, b, c]) => {
    const mine = (ids: number[]) => ids.filter((id) => id === a || id === b || id === c)
    const puts = watchOrders(page)
    await page.goto('/rules')
    const all = await ruleIds(context)
    const total = all.length
    const number = (id: number) => all.indexOf(id) + 1
    const handle = ruleGrip(page, b)

    // The handle says how it works, in words, and what it is: a movable Rule, and not a "sortable".
    const described = await handle.getAttribute('aria-describedby')
    await expect(page.locator(`[id="${described}"]`)).toHaveText(INSTRUCTIONS)
    await expect(handle).toHaveAttribute('aria-roledescription', 'movable Rule')

    // Space picks it up, an arrow key moves it, and Space drops it where it is.
    await handle.focus()
    await page.keyboard.press('Space')
    await expect(status(page, /Picked up/)).toHaveText(`Picked up Rule ${number(b)} of ${total}.`)
    await expect(page.locator('tr[data-dragging="true"]')).toHaveCount(1)
    await noAxeViolations(page) // in the middle of a move, with its words in the page
    await page.keyboard.press('ArrowDown')
    await expect(status(page, /is over position/)).toHaveText(`Rule ${number(b)} is over position ${number(c)} of ${total}.`)
    await page.keyboard.press('Space')
    await expect(status(page, /Dropped/)).toHaveText(`Dropped Rule ${number(b)} in position ${number(c)} of ${total}.`)
    await expect(status(page, /^Moved Rule/)).toContainText(`Moved Rule ${number(b)} to position ${number(c)} of ${total}.`)
    await expect(handle).toBeFocused() // the Rule is somewhere else in the list, and so is its handle
    expect(mine(await ruleIds(context))).toEqual([a, c, b])
    expect(await pageOrder(page, a, b, c)).toEqual([a, c, b])
    expect(puts).toHaveLength(1)

    // Escape puts it down where it was picked up, and saves nothing.
    const now = number(c) // it is where the third was
    await page.keyboard.press('Space')
    await expect(status(page, /Picked up/)).toHaveText(`Picked up Rule ${now} of ${total}.`)
    await page.keyboard.press('ArrowUp')
    await expect(status(page, /is over position/)).toHaveText(`Rule ${now} is over position ${now - 1} of ${total}.`)
    await page.keyboard.press('Escape')
    await expect(status(page, /was cancelled/)).toHaveText(`Moving Rule ${now} was cancelled. It is still in position ${now} of ${total}.`)
    await expect(handle).toBeFocused()
    expect(mine(await ruleIds(context))).toEqual([a, c, b]) // asked after the cancel, so an order sent by it would be in `puts` by now
    expect(puts).toHaveLength(1)
  })
})

// The Worker refuses the order, or cannot save it (stubbed: worker/rules.test.ts holds the real answers). The page showed the new order as soon as the Rule was dropped; it must not
// go on showing an order the Worker does not have. Each answer is a failed request, which Chrome logs.
test.describe('an order the Worker does not take', () => {
  test.use({ expectedStatuses: [409, 500] })

  for (const { name, status: code, body, message } of [
    {
      name: 'refused because the Rules changed meanwhile',
      status: 409,
      body: { error: 'This changed while your request was being handled. Try again.', reason: 'changed' },
      message: 'The Rules have changed since this page loaded. The list is up to date now; try again.',
    },
    { name: 'not saved', status: 500, body: { error: 'Something went wrong' }, message: 'That did not work. Try again.' },
  ]) {
    test(`is ${name}: the order before comes back, and the page says so`, async ({ page, context, baseURL }, testInfo) => {
      await withRules(context, baseURL!, testInfo, ['FIRST', 'SECOND', 'THIRD'], async ([a, b, c]) => {
        await page.goto('/rules')

        // A move that works first, so that there is something said of it (the Moved line) for the failure to take away.
        await dragHandle(page, a, b)
        await expect(status(page, /^Moved Rule/)).toBeVisible()
        await expect.poll(async () => pageOrder(page, a, b, c)).toEqual([b, a, c])

        let held = true
        let release = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        await page.route(/\/api\/rules\/order$/, async (route) => {
          if (route.request().method() !== 'PUT') return route.fallback()
          await gate // the new order is on the page while the Worker is still being asked
          held = false
          await route.fulfill({ status: code, json: body })
        })
        const before = await ruleIds(context)
        await dragHandle(page, a, c)
        await expect.poll(async () => pageOrder(page, a, b, c)).toEqual([b, c, a]) // shown at once
        expect(held).toBe(true)
        release()
        await expect(page.getByRole('alert').filter({ hasText: message })).toHaveText(message)
        await expect.poll(async () => pageOrder(page, a, b, c)).toEqual([b, a, c]) // and taken back
        expect(await ruleIds(context)).toEqual(before) // nothing was saved
        await expect(page.getByRole('status').filter({ hasText: /^Moved/ })).toHaveCount(0) // and what was said of the move before is not said of this one
        await noAxeViolationsFromTop(page)

        // It can be tried again, and this time the Worker takes it.
        await page.unroute(/\/api\/rules\/order$/)
        await dragHandle(page, a, c)
        await expect(status(page, /^Moved Rule/)).toBeVisible()
        await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0) // the problem is cleared when the next move works
        await expect.poll(async () => (await ruleIds(context)).filter((id) => [a, b, c].includes(id))).toEqual([b, c, a])
      })
    })
  }
})

// A Rule being changed makes a run that is going start again, so while a move is being saved the run waits (the Rules page's ApplyToHistory `holding`), and goes on when it is saved. Another
// move cannot start until then.
test('while an order is being saved the handles and Move up and Move down are off and the run waits, and the message says the run starts again', async ({ page, context, baseURL }, testInfo) => {
  await withRules(context, baseURL!, testInfo, ['FIRST', 'SECOND', 'THIRD'], async ([a, b, c]) => {
    let steps = 0
    await page.route('**/api/rules/rerun/step', (route) => {
      steps++
      return route.fulfill({ json: { job: runningJob() } })
    })
    await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob() } }) : route.fallback()))
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    await page.route(/\/api\/rules\/order$/, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      await gate
      await route.fallback()
    })

    await page.goto('/rules')
    await expect.poll(() => steps).toBeGreaterThan(2) // asking for step after step...

    await dragHandle(page, a, b)
    await expect(page.getByText('Waiting while you change a Rule.')).toBeVisible() // ...until the order is being saved: the run is told to wait
    await expect.poll(async () => pageOrder(page, a, b, c)).toEqual([b, a, c])
    for (const id of [a, b, c]) await expect(ruleGrip(page, id)).toHaveAttribute('aria-disabled', 'true')
    const whenSaving = steps
    await openActions(ruleActions(page, c))
    await expect(menuAction(page, 'Move up')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    expect(steps - whenSaving).toBeLessThanOrEqual(1) // at most the one already out

    release()
    await expect(status(page, /^Moved Rule/)).toContainText('The run that is going starts again from the first Transaction, so that it uses the change.')
    await expect.poll(() => steps).toBeGreaterThan(whenSaving + 2) // and then on again
    await expect(ruleGrip(page, a)).not.toHaveAttribute('aria-disabled', 'true')
    expect((await ruleIds(context)).filter((id) => [a, b, c].includes(id))).toEqual([b, a, c])
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('each Rule is a card with a handle and an Actions button, both 44px, and the menu and a finger move it', async ({ page, context, baseURL }, testInfo) => {
    await withRules(context, baseURL!, testInfo, ['FIRST', 'SECOND', 'THIRD'], async ([a, b, c]) => {
      const mine = (ids: number[]) => ids.filter((id) => id === a || id === b || id === c)
      await page.goto('/rules')
      const cards = page.getByRole('list', { name: 'Rules, in the order they are checked' })
      await expect(cards.getByRole('listitem').first()).toBeVisible()
      await expect(page.getByRole('table')).toHaveCount(0)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

      // The same handle and the same menu as the table's, at least 44px each way, and a handle that a finger drags (it has no touch-action, so the page does not scroll under it instead).
      for (const id of [a, b, c]) {
        for (const target of [ruleGrip(page, id), ruleActions(page, id)]) {
          const box = (await target.boundingBox())!
          expect(box.width).toBeGreaterThanOrEqual(44)
          expect(box.height).toBeGreaterThanOrEqual(44)
        }
        expect(await ruleGrip(page, id).evaluate((element) => getComputedStyle(element).touchAction)).toBe('none')
      }
      await expect(ruleGrip(page, a)).toHaveAccessibleName(/^Drag to reorder Rule \d+$/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      await noAxeViolationsFromTop(page)

      // The menu moves a card.
      await ruleActions(page, b).scrollIntoViewIfNeeded()
      await ruleActions(page, b).tap()
      await expect(page.getByRole('menu')).toBeVisible()
      for (const item of await page.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await noAxeViolations(page, { within: OPEN_MENU })
      await menuAction(page, 'Move down').tap()
      await expect(status(page, /^Moved Rule \d+ down/)).toBeVisible()
      expect(await pageOrder(page, a, b, c)).toEqual([a, c, b])
      await expect.poll(async () => mine(await ruleIds(context))).toEqual([a, c, b])

      // A finger on a handle drags the card (touch events, as a phone sends them), and the page does not scroll with it.
      const cdp = await context.newCDPSession(page)
      await ruleGrip(page, a).scrollIntoViewIfNeeded()
      const scrolled = await page.evaluate(() => window.scrollY)
      const start = await centreOf(ruleGrip(page, a))
      const end = await centreOf(ruleGrip(page, b))
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
      await touch('touchStart', start.x, start.y)
      for (let step = 1; step <= 16; step++) await touch('touchMove', start.x, start.y + ((end.y - start.y) * step) / 16)
      expect(await page.evaluate(() => window.scrollY)).toBe(scrolled) // the finger moved the card and not the page (the message that follows the drop may move the page, which is not this)
      await touch('touchEnd', end.x, end.y)
      await expect(status(page, /^Moved Rule/)).toContainText('to position')
      await expect.poll(async () => mine(await ruleIds(context))).toEqual([c, b, a])
      expect(await pageOrder(page, a, b, c)).toEqual([c, b, a])
    })
  })
})
