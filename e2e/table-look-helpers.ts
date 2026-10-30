import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures'

// The one look every table has (`ResponsiveTable`, src/components/responsive-table.tsx), and the paper layout it gives way to in print. `table-look.spec.ts` tests the style once; a page's own spec calls
// `expectTableLook` on its table, which is the cheap check that the page uses it and has not drawn a table of its own.

/** The colour a token is, as the browser computes it for a background, so it is compared in whichever colour space the theme writes it. */
const resolvedBackground = (page: Page, value: string) =>
  page.evaluate((value) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = value
    document.body.append(probe)
    const colour = getComputedStyle(probe).backgroundColor
    probe.remove()
    return colour
  }, value)

/**
 * The table has the shared look on screen: in a rounded box (with a border, or without one `inCard`, where the card is the box), a heading row in the muted fill, a divider under every
 * row but the last, every word in the size of the page's text, and every heading on one line. A row whose details follow it in a row of their own (`detail`, the Accounts screen) is the one exception: the divider
 * goes under the details, so the pair reads as one row. The table has two rows or more, so there is a divider to look at, unless the data is only ever one (`single`).
 */
export async function expectTableLook(table: Locator, { inCard = false, single = false }: { inCard?: boolean; single?: boolean } = {}) {
  await expect(table).toBeVisible()
  const muted = await resolvedBackground(table.page(), 'var(--muted)')
  const look = await table.evaluate((element) => {
    const frame = element.closest('[data-slot="table-frame"]')
    if (!frame) return null
    const box = getComputedStyle(frame)
    return {
      border: parseFloat(box.borderTopWidth),
      radius: parseFloat(box.borderTopLeftRadius),
      heading: getComputedStyle(element.querySelector('thead')!).backgroundColor,
      dividers: Array.from(element.querySelectorAll('tbody tr'))
        .slice(0, -1)
        .filter((row) => row.nextElementSibling?.getAttribute('data-slot') !== 'table-detail')
        .map((row) => parseFloat(getComputedStyle(row).borderBottomWidth)),
      sizes: Array.from(new Set(Array.from(element.querySelectorAll('th, td')).map((cell) => getComputedStyle(cell).fontSize))),
      pageSize: getComputedStyle(document.body).fontSize,
      // A text node that wraps has a box for each line it is on.
      wrapped: Array.from(element.querySelectorAll('th'))
        .filter((heading) => {
          const words = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
          for (let node = words.nextNode(); node; node = words.nextNode()) {
            const range = document.createRange()
            range.selectNodeContents(node)
            if (range.getClientRects().length > 1) return true
          }
          return false
        })
        .map((heading) => heading.textContent),
    }
  })
  expect(look, 'the table is in ResponsiveTable\'s frame').not.toBeNull()
  expect(look!.radius).toBeGreaterThan(0)
  expect(look!.border > 0, inCard ? 'a table in a card has no border of its own' : 'the table has a border').toBe(!inCard)
  expect(look!.heading).toBe(muted)
  if (!single) expect(look!.dividers.length, 'a table with a divider to look at has two rows or more').toBeGreaterThan(0)
  expect(look!.dividers.every((width) => width > 0)).toBe(true)
  expect(look!.sizes).toEqual([look!.pageSize])
  expect(look!.wrapped, 'every heading is on one line').toEqual([])
}

/** With print media emulated: the Report's table has none of the screen look and has the paper layout the Reports have always had (a rule under the headings, a divider under every row, text at the top of its cell). */
export async function expectPaperTable(page: Page) {
  const paper = await page.evaluate(() => {
    const table = document.querySelector('.report-frame table')!
    const style = (selector: string) => getComputedStyle(table.querySelector(selector)!)
    const box = getComputedStyle(table.closest('[data-slot="table-frame"]')!)
    const headings = table.querySelectorAll('thead tr')
    return {
      box: [box.borderTopWidth, box.borderTopLeftRadius, box.overflowX],
      shaded: style('thead').backgroundColor,
      // The rule is under the column headings and not under the identity line a printed table has above them.
      rules: Array.from(headings).map((row) => getComputedStyle(row).borderBottomWidth),
      lastRow: style('tbody tr:last-child').borderBottomWidth,
      cellAt: style('tbody td').verticalAlign,
    }
  })
  expect(paper.box).toEqual(['0px', '0px', 'visible'])
  expect(paper.shaded).toBe('rgba(0, 0, 0, 0)')
  expect(paper.rules.at(-1)).toBe('2px')
  expect(paper.rules.slice(0, -1).every((width) => width === '0px')).toBe(true)
  expect(paper.lastRow).toBe('1px')
  expect(paper.cellAt).toBe('top')
}
