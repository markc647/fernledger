import type { BrowserContext, Page } from '@playwright/test'
import { drawn, LINE, NET_WORTH, NET_WORTH_PATH, netWorth, pressShowNetWorth, showNetWorth, spyApi, spyNetWorth, stubNetWorth } from './chart-helpers'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { readPdf, textOf } from './pdf-text'
import { chooseTextSize, mainNav, navGroup, navLink, openNavGroup } from './shell-helpers'

// The Dashboard (where the Admin lands) and the Summary (where a Member does), which are the same grid of cards, and the Net worth page, which has net worth over time, against the
// real Worker. (The spending chart is on the Spending by Category Report: e2e/report-spending.spec.ts.) The light and dark projects share one local
// database, so each has two Accounts of its own, and its own months of Transactions (2004, which no other spec uses: June for light and September for dark,
// with the month before each for a second point on the net worth line), so the amounts below are the only ones in the dates a test asks about and nothing from
// another spec can pair with them as a Transfer. They are older than every other spec's Transactions on purpose: the Summary's newest five and the first
// page of the Transactions list belong to the specs that look for theirs there. Payees avoid "EXAMPLE", which other specs' Rules look for.
//
// Net worth adds up every Account in the shared database, and the Worker refuses more than 49 (worker/charts.test.ts holds it to that), which a long run of
// specs could reach. So a test that needs the net worth line drawn stubs the answer (`stubNetWorth`), and the one test that reads the real answer says what it
// finds, whichever it is.
const dataFor = (project: string) => {
  const dark = project === 'dark'
  const month = dark ? '2004-09' : '2004-06'
  return {
    month,
    earlier: dark ? '2004-08' : '2004-05',
    everyday: { number: `99-9999-9999999-${dark ? '66' : '64'}`, name: `Dashboard everyday ${project}` },
    savings: { number: `99-9999-9999999-${dark ? '67' : '65'}`, name: `Dashboard savings ${project}` },
    to: `${month}-30`,
  }
}

type Row = { day: string; id: string; payee: string; amountCents: number; earlier?: boolean }

/** A month of Transactions in the first Account (with one in the month before: a second month for the net worth line), and the other half of a Transfer in the second. */
const rowsFor = (project: string): { everyday: Row[]; savings: Row[] } => ({
  everyday: [
    { day: '28', id: 'E1', payee: 'DASHBOARD EARLIER', amountCents: -100, earlier: true },
    { day: '03', id: 'G1', payee: 'DASHBOARD GROCERY A', amountCents: -4000 },
    { day: '05', id: 'F1', payee: 'DASHBOARD FUEL', amountCents: -9000 },
    { day: '15', id: 'T1', payee: 'DASHBOARD MOVED OUT', amountCents: -50_000 }, // $500.00 to the savings Account: a Transfer
    { day: '20', id: 'W1', payee: 'DASHBOARD PAY', amountCents: 200_000 },
  ].map((row) => ({ ...row, id: `${project}${row.id}` })),
  savings: [{ day: '15', id: `${project}T2`, payee: 'DASHBOARD MOVED IN', amountCents: 50_000 }],
})

/** Imports the month's Transactions (a repeat is recognised and adds none), so there are two Accounts with balances. */
async function seed(context: BrowserContext, baseURL: string, project: string) {
  await signInAs(context, 'admin')
  const headers = { Origin: baseURL }
  const { month, earlier, everyday, savings, to } = dataFor(project)
  const rows = rowsFor(project)
  for (const [account, list, ledgerCents] of [[everyday, rows.everyday, 1_000_000], [savings, rows.savings, 50_000]] as const) {
    const imported = await context.request.post('/api/imports/chunks', {
      headers,
      data: {
        account,
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: list.length, skipped: 0, from: `${earlier}-01`, to, ledgerBalance: { cents: ledgerCents, date: to } },
        rows: list.map((r) => ({ date: `${r.earlier ? earlier : month}-${r.day}`, uniqueId: r.id, tranType: 'TFR', chequeNumber: null, payee: r.payee, bankMemo: '', amountCents: r.amountCents })),
      },
    })
    expect(imported.ok()).toBe(true)
  }
}

const dollars = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The cards of the Summary and the Dashboard, in the order they are read. */
const CARDS = ['Balances', 'Budget vs actual', 'Recent transactions']

/**
 * A card's live region: the one status element it has, on the page before anything happens and empty, so that what it comes to say is a change a screen reader
 * announces. Returns it with its element, to check afterwards that it is still the same element and still on the page.
 */
const liveRegion = async (region: ReturnType<typeof netWorth>) => {
  const live = region.getByRole('status')
  await expect(live).toHaveCount(1)
  await expect(live).toHaveText('')
  return { live, element: (await live.elementHandle())! }
}
const LOADING_NET_WORTH = 'Loading net worth. It reads every Transaction, so it can take a moment.'

type Live = { __live: Record<string, string[]> }
/**
 * Records every text a card's status region comes to have, from the moment it is first on the page (the page's scripts run before anything is drawn). A card
 * that loads as soon as it is shown has no moment a test can stop at to see its region empty, so the test reads the history afterwards: empty, then loading, then loaded.
 * A page's commit and the effect that fills the region can run in one task (a bigger layout around the page does it), and an observer is told of both together, after the
 * region already has its words. So the first time it sees a region it looks for a change inside the region among the changes it is told of: that change is the words
 * arriving in a region that was on the page without them, so the region was empty first.
 */
const watchLiveRegions = (page: Page) =>
  page.addInitScript(() => {
    const seen: Record<string, string[]> = {}
    ;(window as unknown as Live).__live = seen
    new MutationObserver((records) => {
      for (const card of document.querySelectorAll('[role="region"][aria-labelledby]')) {
        const live = card.querySelector('[role="status"]')
        if (!live) continue
        const history = (seen[card.getAttribute('aria-labelledby')!] ??= [])
        if (history.length === 0 && records.some((record) => record.target === live || record.target.parentNode === live)) history.push('')
        if (history.at(-1) !== live.textContent) history.push(live.textContent ?? '')
      }
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
const liveHistory = (page: Page, heading: string) => page.evaluate((id) => (window as unknown as Live).__live[id], heading)

/**
 * Answers the requests the page makes for `pattern` only when the test lets each one go (`release`), oldest first. A test of what a section shows while it waits for its
 * answer must not race a timer in the stub: an answer that comes by itself after 400 or 700 ms is gone when a slow run reaches the assertion about the wait (a full run
 * did that once, at "Loading net worth"), and a timer long enough for the slowest run makes every run slow. `answer` is given the URL asked for.
 */
async function holdAnswers(page: Page, pattern: RegExp, answer: (url: URL) => object) {
  const asked: URL[] = []
  const waiting: Array<() => Promise<void>> = []
  await page.route(pattern, (route) => {
    const url = new URL(route.request().url())
    asked.push(url)
    waiting.push(() => route.fulfill({ json: answer(url) })) // not answered yet: the request stays with the test
  })
  return {
    asked,
    /** Answers the oldest request that is waiting, once the page has made one. */
    release: async () => {
      await expect.poll(() => waiting.length, { message: 'a request for the test to answer' }).toBeGreaterThan(0)
      await waiting.shift()!()
    },
  }
}
// The same API as the pages, so the tests can say what the pages should show.
const balancesNow = async (context: BrowserContext) => {
  const { accounts } = (await (await context.request.get('/api/balances')).json()) as { accounts: { balanceCents: number | null }[] }
  return accounts.reduce((sum, a) => sum + (a.balanceCents ?? 0), 0)
}

test.describe.configure({ mode: 'serial' })

// ---------------------------------------------------------------------------------------------------------------
// The Dashboard and the Summary

test('the Admin lands on the Dashboard: the Summary\'s cards and nothing else, with no signed-in line, no tools card and no chart', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()

  // The navigation calls the Admin's landing page the Dashboard, and has no separate Summary.
  const nav = mainNav(page)
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Summary' })).toHaveCount(0)

  // Who is signed in is in the sidebar's footer, and the page does not say it again. The Admin's tools are in the sidebar, so the page has no card of them.
  await expect(page.locator('[data-slot="sidebar-footer"]')).toContainText('admin@example.com')
  await expect(page.getByRole('main')).not.toContainText('Signed in as')
  await expect(page.getByRole('region', { name: 'Your tools' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Balance checks' })).toHaveCount(0) // a Balance Check warning is in the Balances table
  await expect(netWorth(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Spending by Category' })).toHaveCount(0)

  // The Summary's cards in the Summary's order, each a region named by its heading (an h2 under the page's h1).
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(CARDS)
  await noAxeViolations(page)
})

test('a Member lands on the Summary, which is the same cards as the Dashboard, with no signed-in line and none of the Admin\'s tools', async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible()
  const nav = mainNav(page)
  await expect(nav.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
  await expect(page.locator('[data-slot="sidebar-footer"]')).toContainText('Member (read-only)')
  await expect(page.getByRole('main')).not.toContainText('Signed in as')
  await expect(page.getByRole('region', { name: 'Your tools' })).toHaveCount(0)
  await expect(netWorth(page)).toHaveCount(0)
  // The Dashboard's cards, in the same order.
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(CARDS)
})

// ADR 0004: the landing page's reads must not go up. The charts read every Transaction, so they wait on pages of their own (the Net worth page, the Spending by Category Report) and the
// landing page asks for what it needs to say how the Accounts stand, this month against Budget and the newest Transactions, and for none of the charts' figures.
test('the Dashboard and the Summary ask the Worker for their three cards and no chart, and the Net worth page asks for nothing until it is asked', async ({ page, context }) => {
  for (const role of ['admin', 'member'] as const) {
    await signInAs(context, role)
    const asked = spyApi(page)
    await page.goto('/')
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(CARDS)
    for (const name of CARDS) await expect(page.getByRole('region', { name }).getByText('Loading…')).toHaveCount(0) // each card has its answer
    await page.waitForLoadState('networkidle')
    const paths = [...new Set(asked.map((address) => address.split('?')[0]!))].sort()
    expect(paths.filter((path) => path.startsWith('/api/charts')), `${role}: no chart is asked for`).toEqual([])
    expect(paths.filter((path) => path.startsWith('/api/reports')), `${role}: no Report is asked for`).toEqual([])
    // The one new request is whether Akahu Sync is set up, for the Balances table's Sync column: it is the Worker's secrets and reads no D1 row (ADR 0004).
    expect(paths, `${role}: what the landing page reads`).toEqual(['/api/balance-checks', '/api/balances', '/api/budgets/vs-actual', '/api/features', '/api/me', '/api/settings', '/api/transactions'])
    // Neither a Balance Check nor the balances are asked for twice by the table that now shows both.
    expect(asked.filter((address) => address.startsWith('/api/balances')), `${role}: balances`).toHaveLength(1)
    expect(asked.filter((address) => address.startsWith('/api/balance-checks')), `${role}: balance checks`).toHaveLength(1)
    expect(asked.filter((address) => address.startsWith('/api/features')), `${role}: features`).toHaveLength(1)
    asked.stop()
  }

  const net = await spyNetWorth(page)
  const more = spyApi(page)
  await page.goto(NET_WORTH_PATH)
  await expect(netWorth(page).getByRole('button', { name: 'Show net worth' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(net, 'opening the page reads no Transaction').toEqual([])
  expect(more.filter((address) => address.startsWith('/api/charts') || address.startsWith('/api/reports') || address.startsWith('/api/balances')), 'and no balance').toEqual([])
})

// The grid has no more than one column now that every card is a whole row, whatever the room or the text size. Small, Medium, Large and Xtra Large are 14px, 16px, 18px and 20px.
test('the cards are one column, each as wide as the page and under the one before, on a phone and on a wide screen, whatever the text size', async ({ page, context }) => {
  await signInAs(context, 'admin')
  type Box = { x: number; y: number; width: number; height: number }
  /**
   * Where each card is, every card read at the same moment and then again until the two readings agree. Reading them one after the other, as `boundingBox` does, can straddle a change
   * of the page that `settle` (it waits for CSS transitions) cannot see: after a resize the tables become cards a frame later, in script, and the sidebar then begins a 200ms width
   * transition. A Budget vs actual table on a phone is twice the height of its cards, so a card read before that and the next one after it overlapped. The reading waits for two frames, so
   * the page has drawn the width it is at, and for every card to have its answer.
   */
  const read = () =>
    page.evaluate(async (names) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const found: Record<string, (Box & { loading: boolean }) | null> = {}
      for (const name of names) {
        const card = [...document.querySelectorAll('main [role="region"][aria-labelledby]')].find((region) => document.getElementById(region.getAttribute('aria-labelledby')!)?.textContent === name)
        const { x, y, width, height } = card?.getBoundingClientRect() ?? { x: 0, y: 0, width: 0, height: 0 }
        found[name] = card ? { x, y, width, height, loading: card.textContent!.includes('Loading…') } : null
      }
      return found
    }, CARDS)
  const boxes = async () => {
    await settle(page)
    let before = ''
    await expect
      .poll(
        async () => {
          const now = await read()
          const text = JSON.stringify(now)
          const stopped = text === before && Object.values(now).every((card) => card && !card.loading)
          before = text
          return stopped
        },
        { message: 'the cards have their answers and have stopped moving' },
      )
      .toBe(true)
    return JSON.parse(before) as Record<string, Box>
  }
  /** Every card on a row of its own, as wide as the page, one under the next. */
  const expectOneColumn = async (what: string) => {
    const card = await boxes()
    for (const [index, name] of CARDS.entries()) {
      expect(Math.abs(card[name]!.x - card[CARDS[0]!]!.x), `${what}: ${name} starts where the first card does`).toBeLessThan(2)
      expect(Math.abs(card[name]!.width - card[CARDS[0]!]!.width), `${what}: ${name} is as wide as the first card`).toBeLessThan(2)
      if (index > 0) expect(card[name]!.y, `${what}: ${name} is under the card before it`).toBeGreaterThanOrEqual(card[CARDS[index - 1]!]!.y + card[CARDS[index - 1]!]!.height - 1)
    }
  }
  const settled = async (size: 'Medium' | 'Xtra Large') => {
    await chooseTextSize(page, size)
    for (const name of CARDS) await expect(page.getByRole('region', { name }).getByText('Loading…')).toHaveCount(0) // each card has its answer, with or without Accounts in the database
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await settled('Medium')
  await expectOneColumn('1440px wide')
  const wide = await boxes()
  expect(wide['Balances']!.width, 'Balances takes the whole row, with no card beside it').toBeGreaterThan(700)

  await settled('Xtra Large')
  await expectOneColumn('1440px wide at Xtra Large')

  await settled('Medium')
  await page.setViewportSize({ width: 800, height: 900 }) // the sidebar is the icon rail
  await expectOneColumn('800px wide')
  await page.setViewportSize({ width: 390, height: 844 })
  await expectOneColumn('a phone')
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
})

test('the old Charts address goes to the Net worth page, the chart that was there, for a Member and for the Admin, and is in no sidebar', async ({ page, context }) => {
  for (const role of ['member', 'admin'] as const) {
    await signInAs(context, role)
    await page.goto('/charts')
    await expect(page.getByRole('heading', { level: 1, name: 'Net worth' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(NET_WORTH_PATH)
    expect(new URL(page.url()).search).toBe('')
    await expect(netWorth(page)).toBeVisible()
    await openNavGroup(page, 'Reports')
    await expect(navLink(page, 'Charts')).toHaveCount(0)
    await expect(navLink(page, 'Net worth')).toHaveAttribute('aria-current', 'page')
  }
  // A bookmark with more on the end of it goes the same way, and Back does not trap the reader on the address that redirects.
  await page.goto('/transactions')
  await page.goto('/charts?range=5-years')
  await expect.poll(() => new URL(page.url()).pathname).toBe(NET_WORTH_PATH)
  expect(new URL(page.url()).search).toBe('') // what was asked of the old page means nothing to this one
  await page.goBack()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/transactions')
})

test('a Member\'s Summary and the Dashboard have the same Balances, so the Dashboard cannot disagree with the Summary', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  const balances = page.getByRole('region', { name: 'Balances' })
  // Read once the Accounts have arrived, or both would be "Loading…".
  const loaded = () => expect(balances.getByRole('row', { name: new RegExp(dataFor(testInfo.project.name).everyday.name) })).toBeVisible()
  await signInAs(context, 'member')
  await page.goto('/')
  await loaded()
  const asMember = await balances.innerText()
  await signInAs(context, 'admin')
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await loaded()
  expect(await balances.innerText()).toBe(asMember)
})

// ---------------------------------------------------------------------------------------------------------------
// The Net worth page

test('the Net worth page waits to be asked: net worth is not read when it opens, and one press reads it once, for the range chosen beside the button', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const requests = await spyNetWorth(page)
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto(NET_WORTH_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Net worth' })).toBeVisible()

  const region = netWorth(page)
  const show = region.getByRole('button', { name: 'Show net worth' })
  await expect(show).toBeVisible()
  const { live, element } = await liveRegion(region)
  await expect(region).toContainText('Net worth is not drawn until you ask for it, because working it out reads every Transaction of every Account.')
  await expect(region.getByLabel('Range', { exact: true })).toHaveValue('24-months')
  await expect(region.locator('svg.recharts-surface')).toHaveCount(0)
  expect(requests, 'net worth is asked for only when the button is pressed').toEqual([])
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(['Net worth over time'])
  await noAxeViolations(page) // the page with the button

  // Pressing it asks once, tells the reader what is happening, and draws the last 24 months, the range that was chosen beside the button.
  await show.click()
  await expect(region.getByRole('heading', { level: 2, name: 'Net worth over time' })).toBeFocused() // focus moves to the heading, as the button is gone
  await drawn(region, LINE)
  await expect(live).toHaveText('Net worth has loaded.') // the words arrive in the region that was already there, which is what is announced
  expect(await element.evaluate((el) => el.isConnected)).toBe(true)
  await expect(region.getByRole('button', { name: 'Show net worth' })).toHaveCount(0)
  await expect(region.getByLabel('Range', { exact: true })).toHaveValue('24-months') // the choice stays, to change
  expect(requests).toHaveLength(1)
  expect(new URL(requests[0]!).searchParams.get('range')).toBe('24-months')
  await noAxeViolations(page) // and with the chart
  expect(requests).toHaveLength(1) // nothing asked again
})

test('the button that shows net worth is a touch target with a clear name, works from the keyboard, and shows a busy cue while it loads', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const net = await holdAnswers(page, /\/api\/charts\/net-worth/, () => NET_WORTH) // the cue is there for as long as the test looks at it
  await page.goto(NET_WORTH_PATH)
  const region = netWorth(page)
  const show = region.getByRole('button', { name: 'Show net worth', exact: true })
  await expect(show).toBeVisible()
  expect((await show.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await chooseTextSize(page, 'Xtra Large')
  const { live, element } = await liveRegion(region)

  await show.focus()
  await page.keyboard.press('Enter')

  await expect(region).toHaveAttribute('aria-busy', 'true')
  await expect(live).toHaveText(LOADING_NET_WORTH) // said in the region that was already on the page...
  await expect(region.locator('p:not([role="status"])', { hasText: LOADING_NET_WORTH })).toBeVisible() // ...and shown on the screen
  await expect(region.getByRole('heading', { level: 2 })).toBeFocused() // not lost to the page when the button goes
  await net.release()
  await drawn(region, LINE)
  await expect(live).toHaveText('Net worth has loaded.') // the same region, its words changed
  expect(await element.evaluate((el) => el.isConnected)).toBe(true)
  await expect(region).toHaveAttribute('aria-busy', 'false')
  expect(net.asked).toHaveLength(1)
})

test('net worth, as the Worker adds it up from every Account, is the Balances\' total at its newest figure, whatever the range', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  const total = await balancesNow(context)
  const answer = (await (await context.request.get('/api/charts/net-worth?range=24-months')).json()) as { tooManyAccounts: { count: number; limit: number } | null }
  await signInAs(context, 'member')
  await page.goto(NET_WORTH_PATH)
  await pressShowNetWorth(page)

  if (answer.tooManyAccounts) {
    // Too many Accounts in the shared database for a total to be honest: the page says so and draws nothing, which is the Worker's rule (worker/charts.test.ts).
    await expect(netWorth(page)).toContainText(`It works for up to ${answer.tooManyAccounts.limit}, and this Fernledger has ${answer.tooManyAccounts.count}`)
    return
  }
  const figure = await drawn(netWorth(page), /^(Line chart of net worth by month|Net worth was)/)
  await netWorth(page).getByText('Show the figures').click()
  await expect(netWorth(page).getByRole('row').nth(1)).toContainText(dollars(total)) // newest first
  expect(await figure.getAttribute('aria-label')).toContain(dollars(total))
  // Every month there is ends on the same figure.
  await netWorth(page).getByLabel('Range', { exact: true }).selectOption('all')
  await expect(netWorth(page).getByText('Every month Fernledger holds, which can make a long line.')).toBeVisible()
  await expect(netWorth(page).getByRole('row').nth(1)).toContainText(dollars(total))
})

test('net worth is drawn as a line, and says what it is: only the money in these Accounts, with the months before an Account\'s history an estimate', async ({ page, context }) => {
  await signInAs(context, 'member')
  await stubNetWorth(page)
  await page.goto(NET_WORTH_PATH)

  const figure = await showNetWorth(page)
  await expect(figure.locator('path.recharts-line-curve')).toHaveAttribute('d', /^M[\d.]+/)
  expect(await figure.getAttribute('aria-label')).toContain('It was $10,000.00 at the end of August 2026 and $10,800.00 on Wed 7 Oct 2026.')
  await expect(netWorth(page)).toContainText("Only the money in these Accounts, added up at the end of each month from the bank balances Fernledger holds. A loan to or from someone whose account isn't tracked shows as a fall or a rise.")
  await expect(netWorth(page)).toContainText("Months before an Account's first Transaction use the balance it had when its Transactions begin, so they are an estimate")
  await expect(netWorth(page)).not.toContainText(/\bwe\b/i)
  await expect(netWorth(page)).not.toContainText('Loans Report')
})

test('the Net worth page lets the reader choose how far back net worth goes, before it is drawn or after, and the card is busy while it asks', async ({ page, context }) => {
  await signInAs(context, 'member')
  await watchLiveRegions(page)
  // Each answer waits for the test to let it go, so the cues are there for as long as the test looks at them, the first answer as well as the second.
  const net = await holdAnswers(page, /\/api\/charts\/net-worth/, (url) => ({ ...NET_WORTH, range: url.searchParams.get('range') }))
  const asked = () => net.asked.map((url) => url.searchParams.get('range'))
  await page.goto(NET_WORTH_PATH)
  const region = netWorth(page)
  const live = region.getByRole('status') // the one live region the card keeps on the page
  const element = (await live.elementHandle())!
  await expect(region).toHaveAttribute('aria-busy', 'false') // nothing is asked for until the button is pressed
  await expect(live).toHaveText('')
  await expect(region.getByLabel('Range', { exact: true })).toHaveValue('24-months')
  await expect(region.getByRole('option')).toHaveText(['Last 24 months', 'Last 5 years', 'All history'])
  // The range is chosen beside the button, before anything is asked: choosing first costs one read, for the range that was chosen, and not one for another range first.
  await region.getByLabel('Range', { exact: true }).selectOption('5-years')
  await expect(live).toHaveText('')
  expect(asked()).toEqual([])
  await pressShowNetWorth(page)
  await expect(region).toHaveAttribute('aria-busy', 'true') // the first load
  await expect(live).toHaveText(LOADING_NET_WORTH)
  await net.release()
  await drawn(region, LINE)
  await expect(live).toHaveText('Net worth has loaded.')
  await expect(region).toHaveAttribute('aria-busy', 'false')
  await expect(region.getByLabel('Range', { exact: true })).toHaveValue('5-years') // still there, to change
  expect(asked()).toEqual(['5-years'])

  await region.getByLabel('Range', { exact: true }).selectOption('all')
  await expect(live).toHaveText('Updating net worth…') // said in the region that was already there
  await expect(region.locator('p:not([role="status"])', { hasText: 'Updating…' })).toBeVisible() // the old range stays on the screen, marked as old
  await expect(region).toHaveAttribute('aria-busy', 'true')
  await net.release()
  await expect(live).toHaveText('Net worth has loaded.')
  await expect(region.locator('p:not([role="status"])', { hasText: 'Updating…' })).toHaveCount(0)
  await expect(region).toHaveAttribute('aria-busy', 'false')
  expect(await element.evaluate((el) => el.isConnected)).toBe(true)
  // The one element went from empty to loading to loaded, and on to updating and loaded again.
  expect(await liveHistory(page, 'net-worth-heading')).toEqual(['', LOADING_NET_WORTH, 'Net worth has loaded.', 'Updating net worth…', 'Net worth has loaded.'])
  expect(asked()).toEqual(['5-years', 'all'])
})

test('net worth\'s figures open from the keyboard, and the control is a touch target', async ({ page, context }) => {
  await signInAs(context, 'member')
  await stubNetWorth(page)
  await page.goto(NET_WORTH_PATH)
  await showNetWorth(page)
  const summary = netWorth(page).getByText('Show the figures')
  expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(netWorth(page).getByRole('table')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(netWorth(page).getByRole('table')).toBeHidden()
})

test('net worth\'s figures are in the printout, though the disclosure is closed on the screen', async ({ page, context }) => {
  await signInAs(context, 'member')
  await stubNetWorth(page)
  await page.goto(NET_WORTH_PATH)
  await showNetWorth(page)
  await expect(netWorth(page).getByRole('table')).toBeHidden()

  const pages = await readPdf(await page.pdf({ format: 'A4' }))

  const text = pages.map(textOf).join(' ')
  expect(text).toContain('Net worth over time')
  for (const figure of ['Mon 31 Aug 2026', '$10,000.00', 'Wed 30 Sept 2026', '$10,500.00', 'Wed 7 Oct 2026', '$10,800.00']) expect(text, figure).toContain(figure)
  await expect(netWorth(page).getByRole('table')).toBeHidden() // and the page is as it was after printing
})

test('the Net worth page has no WCAG 2.2 AA violations, with its data, at the largest text size, and on a phone', async ({ page, context, baseURL }, testInfo) => {
  await seed(context, baseURL!, testInfo.project.name)
  await signInAs(context, 'member')
  await stubNetWorth(page)
  for (const viewport of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto(NET_WORTH_PATH)
    await chooseTextSize(page, 'Xtra Large')
    await showNetWorth(page)
    await netWorth(page).getByText('Show the figures').click() // the table is part of what is scanned
    await expect(netWorth(page).getByRole('table').or(netWorth(page).getByRole('list', { name: /Net worth at the end of each month/ }))).toBeVisible()
    await noAxeViolations(page)
  }
})

test('the net worth line is the theme\'s colour, drawn in the text colour when Windows high contrast is on, and nothing moves', { tag: '@theme' }, async ({ page, context }) => {
  await signInAs(context, 'member')
  await stubNetWorth(page)
  await page.goto(NET_WORTH_PATH)
  const line = netWorth(page).locator('path.recharts-line-curve')
  await showNetWorth(page)
  await expect(line).toBeVisible()

  // Nothing is animating in a chart, whatever the reader's motion setting: it draws itself at once, and so does its tooltip.
  expect(await page.evaluate(() => document.querySelector('[data-slot="chart"]')!.getAnimations({ subtree: true }).length)).toBe(0)

  const stroke = (locator: typeof line) => locator.evaluate((el) => getComputedStyle(el).stroke)
  const themed = await stroke(line)
  const text = await page.locator('body').evaluate((el) => getComputedStyle(el).color)
  expect(themed).not.toBe(text) // the theme's own chart colour, not the page's text

  await page.emulateMedia({ forcedColors: 'active' })
  const canvasText = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'CanvasText'
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })
  expect(await stroke(line)).toBe(canvasText)
})

test('hovering a point says what it is, in the same words as the figures', async ({ page, context }) => {
  await signInAs(context, 'member')
  await stubNetWorth(page)
  await page.goto(NET_WORTH_PATH)
  await showNetWorth(page)
  const picture = netWorth(page).locator('svg.recharts-surface')
  const size = await picture.boundingBox()
  await picture.hover({ position: { x: size!.width - 40, y: size!.height / 2 } })
  await expect(netWorth(page).locator('.recharts-tooltip-wrapper')).toContainText('Wed 7 Oct 2026')
})

test.describe('when the answers are not the usual ones', () => {
  test('says so when net worth has more Accounts than can be added up, and when some are left out or stop early', async ({ page, context }) => {
    await signInAs(context, 'member')
    await stubNetWorth(page, { range: '24-months', counted: [], notCounted: [], points: [], tooManyAccounts: { count: 52, limit: 49 } })
    await page.goto(NET_WORTH_PATH)
    await pressShowNetWorth(page)
    await expect(netWorth(page)).toContainText("Net worth can't be drawn for this many Accounts. It works for up to 49, and this Fernledger has 52, so it shows nothing rather than a total that leaves some out.")
    await expect(netWorth(page).locator('svg.recharts-surface')).toHaveCount(0)
    await expect(netWorth(page)).not.toContainText(/\bwe\b/i)

    // The newest route is tried first, so this answer replaces the one above.
    await stubNetWorth(page, {
      range: '24-months',
      counted: [
        { accountId: 1, accountName: 'Example everyday', lastDate: '2026-10-07' },
        { accountId: 4, accountName: 'Example term deposit', lastDate: '2026-07-20' },
      ],
      notCounted: [
        { accountId: 2, accountName: 'Example credit card', latestStatus: null },
        { accountId: 3, accountName: 'Example savings', latestStatus: 'after-cutover' },
      ],
      points: [{ date: '2026-08-31', cents: 100_000 }, { date: '2026-09-30', cents: -50_000 }, { date: '2026-10-07', cents: 123_456 }],
      tooManyAccounts: null,
    })
    await page.reload()
    const region = netWorth(page)
    await pressShowNetWorth(page)
    await expect(region).toContainText('These Accounts are not in the total:')
    await expect(region.getByRole('listitem').filter({ hasText: 'Example credit card' })).toHaveText('Example credit card: No bank balance yet. The Admin can import a bank file to give it one.')
    await expect(region.getByRole('listitem').filter({ hasText: 'Example savings' })).toHaveText(
      'Example savings: The bank balance we have is after the Cutover Date. The Admin can import a file with a bank balance dated before the Cutover Date, or change the Cutover Date in Settings.',
    )
    await expect(region.getByRole('listitem').filter({ hasText: 'Example term deposit' })).toHaveText(
      'Example term deposit: its last Transaction is Mon 20 Jul 2026, and its balance stays the same after that. The Admin can import a newer bank file to bring it up to date.',
    )
    const figure = await drawn(region, LINE)
    expect(await figure.getAttribute('aria-label')).toContain('It was $1,000.00 at the end of August 2026 and $1,234.56 on Wed 7 Oct 2026.')
    await region.getByText('Show the figures').click()
    await expect(region.getByRole('row').nth(2)).toContainText('−$500.00') // a real minus sign, and the middle month
  })

  test('says so when there is nothing to draw', async ({ page, context }) => {
    await signInAs(context, 'member')
    await stubNetWorth(page, { range: '24-months', counted: [], notCounted: [], points: [], tooManyAccounts: null })
    await page.goto(NET_WORTH_PATH)
    await pressShowNetWorth(page)
    await expect(netWorth(page)).toContainText('There are no Accounts yet, so there is no net worth to draw.')
    await expect(netWorth(page).locator('svg.recharts-surface')).toHaveCount(0)
  })

  test.describe('when the Worker fails', () => {
    test.use({ expectedStatuses: [500] })

    test('tells the reader to try again instead of drawing nothing', async ({ page, context }) => {
      await signInAs(context, 'member')
      await page.route(/\/api\/charts\/net-worth/, (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
      await page.goto(NET_WORTH_PATH)
      await pressShowNetWorth(page)
      await expect(netWorth(page).getByRole('alert')).toHaveText("Fernledger couldn't load net worth. Reload the page to try again.")
    })
  })

  // A tab left open across a deploy asks for a chunk of code that is no longer there. The browser and React both log that, which is what this test expects of them; what it holds
  // the page to is that the chart's place says so and the rest of the page, which does not need the chunk, is still there (without a boundary the whole page goes).
  test.describe("when the chart's code cannot be loaded", () => {
    test.use({ expectedConsoleErrors: ['Failed to load resource: net::ERR_FAILED', 'dynamically imported module'] })

    test('says so where the chart would be, and leaves the rest of the page', async ({ page, context }) => {
      await signInAs(context, 'member')
      await page.route(/\/assets\/net-worth-chart-[^/]+\.js/, (route) => route.abort())
      await page.goto(NET_WORTH_PATH)
      await expect(page.getByRole('alert').filter({ hasText: "The net worth chart couldn't be loaded. Reload the page to try again." })).toBeVisible()
      await expect(netWorth(page)).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 1, name: 'Net worth' })).toBeVisible()
      await openNavGroup(page, 'Reports')
      await expect(navGroup(page, 'Reports')).toHaveAttribute('aria-expanded', 'true') // the shell is there too
    })
  })
})
