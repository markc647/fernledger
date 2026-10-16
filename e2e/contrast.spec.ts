import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { netWorth, SPENT, showNetWorth, showSpending, stubNetWorth, stubSpending } from './chart-helpers'
import { dateField, pickDate, thisMonth } from './date-helpers'
import { expect, noAxeViolations, settle, signInAs, test } from './fixtures'
import { ensureCategory, forgetKeptReportsAfterEach, importRows, restoreAppTitleAfterEach, signInToOpen, transactionId, type SeedRow } from './report-helpers'
import { arrowTo, menuAction, OPEN_MENU, openActions } from './row-actions-helpers'
import { categoryId, ruleActions, runningJob, usageFigures, usageOn, withRules } from './rule-helpers'
import { navGroup, openHeaderControls, openNavGroup, siteHeader } from './shell-helpers'

// Colour contrast, measured once for the whole app, in both themes (CODING_STANDARDS.md#tests). Every page is scanned with `contrast: true`, as the Admin and as a Member where the page differs,
// in the state that shows the most colour, and what opens over a page is scanned open.
//
// The light and dark projects share one local database, so each has two Accounts and three Categories of its own, dated this NZ month and last (the Budgets page and the Summary are about this month).

const lastMonth = (() => {
  const index = Number(thisMonth.slice(0, 4)) * 12 + Number(thisMonth.slice(5, 7)) - 2
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
})()
/** The dates of the Reports: from the first of last month to the 28th of this one, which has a month that is not over and dates that are part of a month. */
const RANGE = `from=${lastMonth}-01&to=${thisMonth}-28`
const DATES = { from: `${lastMonth}-01`, to: `${thisMonth}-28` } // the same dates, as the Admin's showing a Report keeps them
const PHONE = { width: 390, height: 844 }

const dataFor = (project: string) => {
  const dark = project === 'dark'
  return {
    project,
    everyday: { number: `99-9999-9999999-${dark ? '22' : '20'}`, name: `Contrast everyday ${project}` },
    savings: { number: `99-9999-9999999-${dark ? '23' : '21'}`, name: `Contrast savings ${project}` },
    // Names that no other spec's name is part of. The food Budget is $100.00 and $150.00 is spent (Over Budget); the petrol Budget is $200.00 and $20.00 is spent (Under Budget).
    food: `Contrast food ${project}`,
    petrol: `Contrast petrol ${project}`,
    loan: `Contrast lent ${project}`,
    search: `CONTRAST ${project}`,
  }
}

const everydayRows = (project: string): SeedRow[] => [
  { date: `${thisMonth}-01`, payee: `CONTRAST ${project} SHOP`, amountCents: -15_000, category: dataFor(project).food },
  { date: `${thisMonth}-01`, payee: `CONTRAST ${project} PUMP`, amountCents: -2_000, category: dataFor(project).petrol },
  { date: `${thisMonth}-02`, payee: `CONTRAST ${project} MYSTERY`, amountCents: -1_234 }, // Uncategorised
  { date: `${thisMonth}-02`, payee: `CONTRAST ${project} LENT`, amountCents: -5_000, category: dataFor(project).loan }, // money lent: a Loans Category, so not spending
  { date: `${thisMonth}-02`, payee: `CONTRAST ${project} TO SAVINGS`, amountCents: -31_741 }, // the Transfer's first half; an amount no other spec uses, so nothing else pairs with it
]

const seeded = new Set<string>()

/** The project's Categories, Budgets, two Accounts and their Transactions, with a Balance Check that differs by $5.00 and a Transfer. Safe to repeat, as the other specs' seeds are. */
async function seed(context: BrowserContext, baseURL: string, project: string) {
  if (seeded.has(project)) return
  const { everyday, savings, food, petrol, loan } = dataFor(project)
  await signInAs(context, 'admin')
  const categories = {
    [food]: await ensureCategory(context, baseURL, food, 'spending'),
    [petrol]: await ensureCategory(context, baseURL, petrol, 'spending'),
    [loan]: await ensureCategory(context, baseURL, loan, 'loans'),
  }
  for (const [name, amountCents] of [[food, 10_000], [petrol, 20_000]] as const) {
    expect((await context.request.put(`/api/budgets/${categories[name]}`, { headers: { Origin: baseURL }, data: { effectiveFrom: thisMonth, amountCents } })).ok()).toBe(true)
  }

  // Last month's file ends at $1,000.00; this month's adds up to $549.75 less, and the bank says $5.00 more than that.
  const rows = everydayRows(project)
  const spent = rows.reduce((total, row) => total + row.amountCents, 0)
  await importRows(context, baseURL, {
    account: everyday,
    from: `${lastMonth}-15`,
    to: `${lastMonth}-15`,
    rows: [{ date: `${lastMonth}-15`, payee: `CONTRAST ${project} EARLIER`, amountCents: -500 }],
    idPrefix: `CXA${project}`,
    ledger: { date: `${lastMonth}-15`, cents: 100_000 },
  })
  await importRows(context, baseURL, { account: everyday, from: `${thisMonth}-01`, to: `${thisMonth}-02`, rows, idPrefix: `CXB${project}`, ledger: { date: `${thisMonth}-02`, cents: 100_000 + spent + 500 } })
  // The other half of the Transfer, imported second so that the two are paired.
  await importRows(context, baseURL, { account: savings, from: `${thisMonth}-02`, to: `${thisMonth}-02`, rows: [{ date: `${thisMonth}-02`, payee: `CONTRAST ${project} FROM EVERYDAY`, amountCents: 31_741 }], idPrefix: `CXC${project}` })

  for (const row of rows) {
    if (!row.category) continue
    expect((await context.request.put(`/api/transactions/${await transactionId(context, row.payee)}/override`, { headers: { Origin: baseURL }, data: { categoryId: categories[row.category] } })).ok()).toBe(true)
  }
  seeded.add(project)
}

/** The ID of the Account called `name`, which the Reports are asked about. */
async function accountIdOf(context: BrowserContext, name: string) {
  const accounts = (await (await context.request.get('/api/accounts')).json()) as { id: number; name: string }[]
  return accounts.find((account) => account.name === name)!.id
}

/** An ASB file of two new Transactions for the project's everyday Account, to choose on the Import screen and look at as a preview (it is never imported). */
function previewFile({ project, everyday }: ReturnType<typeof dataFor>) {
  const [year, month] = thisMonth.split('-')
  const monthName = new Date(`${thisMonth}-01T00:00:00Z`).toLocaleString('en-NZ', { month: 'long', timeZone: 'UTC' })
  return [
    `Created date / time : 3 ${monthName} ${year} / 09:00:00`,
    `Bank 99; Branch 9999; Account 9999999-${everyday.number.slice(-2)} (Contrast example)`,
    `From date ${year}${month}03`,
    `To date ${year}${month}03`,
    `Avail Bal : 10.00 as of ${year}${month}03`,
    `Ledger Balance : 10.00 as of ${year}${month}03`,
    'Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount',
    '',
    `${year}/${month}/03,CXP${project}1,EFTPOS,,"CONTRAST ${project} PREVIEW ONE","EFTPOS",-3.00`,
    `${year}/${month}/03,CXP${project}2,D/C,,"CONTRAST ${project} PREVIEW TWO","WAGES",4.00`,
  ].join('\n')
}

type Role = 'admin' | 'member'
const ROLES: Role[] = ['admin', 'member']

/** What a page's visit has to work with: the project's data, whether it is on a phone, and `scan` for each state of the page that is to be looked at (a label says which, for a failure that must be found from its message alone; `within` for an overlay). */
type Visit = {
  page: Page
  context: BrowserContext
  baseURL: string
  role: Role
  phone: boolean
  data: ReturnType<typeof dataFor>
  scan: (state?: string, options?: { within?: string }) => Promise<void>
}

/** The scan of one state of a page: with colour contrast on, once the project's theme is showing (or the scan would not be testing it). A failure says which page, who and which state, as a CI run keeps no trace to look at. */
const scanner = (page: Page, project: string, path: string, role: Role) => async (state = 'as it opens', options: { within?: string } = {}) => {
  await expect(page.locator('html')).toHaveClass(project === 'dark' ? /dark/ : /^(?!.*dark)/)
  try {
    await noAxeViolations(page, { contrast: true, ...options })
  } catch (error) {
    throw new Error(`${path} as the ${role} (${state}, ${project} theme): ${(error as Error).message}`, { cause: error })
  }
}

const heading = (page: Page, name: string) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

// `roles` is who looks at the page: both, unless the page is the same for a Member as for the Admin. `phone` adds a pass at 390px wide, as the Admin, where a table becomes cards.
const PAGES: {
  path: string
  roles?: Role[]
  phone?: boolean
  setup?: (setup: { page: Page; request: APIRequestContext; baseURL: string }) => Promise<void>
  visit: (visit: Visit) => Promise<void>
}[] = [
  {
    path: '/styleguide',
    visit: async ({ page, scan }) => {
      await page.goto('/styleguide')
      await heading(page, 'Styleguide')
      await scan()
    },
  },
  {
    // The Dashboard and the Summary, with both charts drawn and net worth's figures open. The charts are stubbed, as in shell.spec.ts: net worth is refused for more than 49 Accounts, which the specs that share this database can reach.
    path: '/',
    phone: true,
    setup: async ({ page }) => {
      await stubNetWorth(page)
      await stubSpending(page, SPENT, 16_050)
    },
    visit: async ({ page, role, scan }) => {
      await page.goto('/')
      await heading(page, role === 'admin' ? 'Dashboard' : 'Summary')
      await expect(page.getByRole('region', { name: 'Balance checks' }).getByRole('listitem').first()).toBeVisible()
      await showNetWorth(page)
      await showSpending(page, /^Bar chart of the 3 Categories/)
      await netWorth(page).getByText('Show the figures').click()
      await expect(netWorth(page).getByRole('table').or(netWorth(page).getByRole('list', { name: /Net worth at the end of each month/ }))).toBeVisible()
      await scan()
    },
  },
  {
    // The list, and for the Admin the edit panel of the Transfer's first half (it points to Not a Transfer), and the question that button asks (nothing is changed: the question is not answered).
    path: '/transactions',
    phone: true,
    visit: async ({ page, role, phone, data, scan }) => {
      await page.goto(`/transactions?q=${encodeURIComponent(data.search)}`)
      await heading(page, 'Transactions')
      if (phone) {
        await expect(page.getByText('TO SAVINGS').first()).toBeVisible() // cards, not rows
        await scan()
        return
      }
      const rows = page.getByRole('row').filter({ has: page.getByRole('cell') })
      await expect(rows).toHaveCount(7) // the six of this Account (last month's, and this month's five) and the Transfer's other half
      await expect(rows.filter({ hasText: 'TO SAVINGS' })).toContainText('Transfer')
      await scan()
      if (role === 'member') return
      await rows.filter({ hasText: 'TO SAVINGS' }).getByRole('button', { name: /^Edit Category and Note/ }).click()
      await expect(page.getByText('If the pairing is wrong, use Not a Transfer instead.')).toBeVisible()
      await scan('with the edit panel open')
      await page.getByRole('button', { name: 'Not a Transfer', exact: true }).click()
      await expect(page.getByRole('group', { name: 'Mark as Not a Transfer?' })).toBeVisible()
      await scan('with the Not a Transfer question')
    },
  },
  {
    // A Transaction's details: the Admin has the button to edit its Category and Note.
    path: '/transactions/:id',
    visit: async ({ page, context, data, scan }) => {
      await page.goto(`/transactions/${await transactionId(context, `CONTRAST ${data.project} SHOP`)}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Transaction', exact: true })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Summary' })).toContainText(data.food)
      await scan()
    },
  },
  {
    // Nothing is imported: the preview is of a file the Admin has chosen, and a file that is not a bank export is explained. A Member is told the screen is the Admin's.
    path: '/import',
    visit: async ({ page, role, data, scan }) => {
      await page.goto('/import')
      await heading(page, 'Import')
      if (role === 'member') {
        await expect(page.getByText('Only the Admin can import files.')).toBeVisible()
        await scan()
        return
      }
      await scan('as it opens')
      await page.getByLabel('Bank export file').setInputFiles({ name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Thing\n2026/10/01,Something\n') })
      await expect(page.getByRole('alert')).toContainText('not a supported bank export')
      await scan('with an error')
      await page.getByLabel('Bank export file').setInputFiles({ name: 'contrast.csv', mimeType: 'text/csv', buffer: Buffer.from(previewFile(data)) })
      await expect(page.getByRole('heading', { level: 2, name: 'Preview' })).toBeVisible()
      await expect(page.getByText('2 transactions to import')).toBeVisible()
      await scan('with a preview')
    },
  },
  {
    path: '/accounts',
    visit: async ({ page, data, scan }) => {
      await page.goto('/accounts')
      await heading(page, 'Accounts')
      await expect(page.getByText(data.everyday.name).first()).toBeVisible()
      await scan()
    },
  },
  {
    // The Admin's list of Transactions with no Category. A Member is told it is the Admin's.
    path: '/uncategorised',
    visit: async ({ page, role, scan }) => {
      await page.goto('/uncategorised')
      await heading(page, 'Uncategorised')
      if (role === 'member') await expect(page.getByText('Only the Admin can use this list.')).toBeVisible()
      else await expect(page.getByRole('row').filter({ has: page.getByRole('cell') }).first()).toBeVisible()
      await scan()
    },
  },
  {
    // The same for a Member as for the Admin. Its date filters open a calendar, scanned open with no date and then with one chosen (the first of this month, so today is on the same page).
    path: '/change-log',
    roles: ['admin'],
    visit: async ({ page, scan }) => {
      await page.goto('/change-log')
      await heading(page, 'Change Log')
      await expect(page.getByRole('listitem').filter({ hasText: 'change by' }).first()).toBeVisible()
      await scan()
      await dateField(page, 'From').click()
      await expect(page.getByRole('dialog').getByLabel('Choose the Year')).toBeVisible() // the calendar's code is fetched when the first one is opened
      await scan('with the calendar open', { within: '[data-slot="popover-content"]' })
      await page.keyboard.press('Escape')
      await pickDate(page, 'From', `${thisMonth}-01`)
      await dateField(page, 'From').click()
      await expect(page.getByRole('dialog').getByLabel('Choose the Year')).toBeVisible()
      await scan('with the calendar open and a date chosen', { within: '[data-slot="popover-content"]' })
    },
  },
  {
    // The Admin is told what to set up until the fields are filled in; a Member has neutral lines. Another spec may have left them filled (the Change Log's), so they are emptied first, as the defaults are.
    path: '/about-your-data',
    setup: async ({ request, baseURL }) => {
      expect((await request.patch('/api/settings', { headers: { Origin: baseURL }, data: { about_contact: '', about_retention: '' } })).ok()).toBe(true)
    },
    visit: async ({ page, role, scan }) => {
      await page.goto('/about-your-data')
      await heading(page, 'About your data')
      await expect(page.getByText(role === 'admin' ? 'Setup needed' : 'Ask the person who invited you').first()).toBeVisible()
      await scan()
    },
  },
  {
    // The Admin is told to print it for each Member.
    path: '/how-to-sign-in',
    visit: async ({ page, scan }) => {
      await page.goto('/how-to-sign-in')
      await heading(page, 'How to sign in')
      await scan()
    },
  },
  {
    // The table of the kept Reports (cards on a phone), with the Loans Category on a muted line under its Report. It is looked at as it opens, with a row's "⋯" menu open (Open and Print, and Save and Share
    // dimmed, with "Coming later" beside them) and, for the Admin, with the question Delete asks. Delete is not answered.
    path: '/reports',
    phone: true,
    visit: async ({ page, context, baseURL, role, phone, data, scan }) => {
      await signInToOpen(context, baseURL, role, { report: 'transactions', accountId: await accountIdOf(context, data.everyday.name), ...DATES })
      await signInToOpen(context, baseURL, role, { report: 'loans', categoryId: await categoryId(context, data.loan), ...DATES })
      await page.goto('/reports')
      await heading(page, 'Reports')
      const kept = phone ? page.getByRole('list', { name: 'Kept Reports' }) : page.getByRole('table', { name: 'Kept Reports' })
      await expect(kept).toContainText(data.loan) // the muted line under "Loans"
      await expect(kept).toContainText(data.everyday.name)
      await scan()
      const actions = page.getByRole('button', { name: new RegExp(`^Actions for Loans, ${data.loan},`) })
      await openActions(actions)
      await expect(page.getByRole('menuitem', { name: /^Save\s*Coming later$/ })).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByRole('menuitem', { name: /^Share\s*Coming later$/ })).toHaveAttribute('aria-disabled', 'true')
      await scan('with a row menu open, and Save and Share dimmed', { within: OPEN_MENU })
      if (role === 'member') return
      await menuAction(page, 'Delete').click()
      await expect(page.getByRole('group', { name: new RegExp(`^Delete Loans, ${data.loan},`) })).toBeVisible()
      await scan('with the Delete question open')
    },
  },
  {
    // The Everyday Account's Reports, each with a result: the listing of its Transactions with their Categories. Each is kept first, as the Admin's showing it keeps it, so that a Member may open it.
    path: '/reports/transactions',
    visit: async ({ page, context, baseURL, role, data, scan }) => {
      const accountId = await accountIdOf(context, data.everyday.name)
      await signInToOpen(context, baseURL, role, { report: 'transactions', accountId, ...DATES })
      await page.goto(`/reports/transactions?account=${accountId}&${RANGE}`)
      const report = page.getByRole('article', { name: 'Transaction listing' })
      await expect(report.getByRole('table').first()).toBeVisible()
      await expect(report).toContainText(data.food)
      await scan()
    },
  },
  {
    // Its balances month by month, with the $5.00 the bank disagrees by.
    path: '/reports/balances',
    visit: async ({ page, context, baseURL, role, data, scan }) => {
      const accountId = await accountIdOf(context, data.everyday.name)
      await signInToOpen(context, baseURL, role, { report: 'balances', accountId, ...DATES })
      await page.goto(`/reports/balances?account=${accountId}&${RANGE}`)
      const report = page.getByRole('article', { name: 'Balances over time' })
      await expect(report.getByRole('table').first()).toBeVisible()
      await expect(report.getByText('Balance differs from bank by $5.00').first()).toBeVisible()
      await scan()
    },
  },
  {
    path: '/reports/spending',
    visit: async ({ page, context, baseURL, role, data, scan }) => {
      const accountId = await accountIdOf(context, data.everyday.name)
      await signInToOpen(context, baseURL, role, { report: 'spending', accountId, ...DATES })
      await page.goto(`/reports/spending?account=${accountId}&${RANGE}`)
      const report = page.getByRole('article', { name: 'Spending by Category' })
      await expect(report.getByRole('table', { name: 'Spending in each Category' })).toContainText(data.food)
      await scan()
    },
  },
  {
    // The months, with the one that is not over yet and a notice for dates that are part of a month.
    path: '/reports/income-vs-spending',
    visit: async ({ page, context, baseURL, role, data, scan }) => {
      const accountId = await accountIdOf(context, data.everyday.name)
      await signInToOpen(context, baseURL, role, { report: 'income-vs-spending', accountId, ...DATES })
      await page.goto(`/reports/income-vs-spending?account=${accountId}&${RANGE}`)
      await expect(page.getByRole('article', { name: 'Income vs spending by month' }).getByRole('table', { name: 'Income and spending by month' })).toBeVisible()
      await scan()
    },
  },
  {
    // What is owed on the money lent from the Everyday Account.
    path: '/reports/loans',
    visit: async ({ page, context, baseURL, role, data, scan }) => {
      const loan = await categoryId(context, data.loan)
      await signInToOpen(context, baseURL, role, { report: 'loans', categoryId: loan, ...DATES })
      await page.goto(`/reports/loans?category=${loan}&${RANGE}`)
      await expect(page.getByRole('article', { name: 'Loans', exact: true }).getByRole('table', { name: `Transactions in ${data.loan}` })).toBeVisible()
      await scan()
    },
  },
  {
    // A Report with a result: the Budget vs actual Report has a status on every row, and a notice for a month that is not over and for dates that are part of a month.
    path: '/reports/budget-vs-actual',
    visit: async ({ page, context, baseURL, role, data, scan }) => {
      await signInToOpen(context, baseURL, role, { report: 'budget-vs-actual', from: `${thisMonth}-01`, to: `${thisMonth}-28` })
      await page.goto(`/reports/budget-vs-actual?from=${thisMonth}-01&to=${thisMonth}-28`)
      const report = page.getByRole('article', { name: 'Budget vs actual' })
      await expect(report.getByText(data.food).first()).toBeVisible()
      await expect(report.getByText('Over Budget').first()).toBeVisible()
      await scan()
    },
  },
  {
    path: '/categories',
    phone: true,
    visit: async ({ page, data, scan }) => {
      await page.goto('/categories')
      await heading(page, 'Categories')
      await expect(page.getByText(data.food, { exact: true }).first()).toBeVisible() // a cell, or a card on a phone
      await scan()
    },
  },
  {
    path: '/budgets',
    visit: async ({ page, data, scan }) => {
      await page.goto('/budgets')
      await heading(page, 'Budgets')
      await expect(page.getByRole('row').filter({ hasText: data.food })).toContainText('$100.00 a month')
      await expect(page.getByRole('row').filter({ hasText: data.petrol })).toContainText('$200.00 a month')
      await scan()
    },
  },
  {
    // The Settings are the Admin's: a Member is told so. The Admin's page is looked at as it opens, after a Save ("Settings saved"), and with an error (a blank title).
    path: '/settings',
    visit: async ({ page, role, scan }) => {
      await page.goto('/settings')
      await heading(page, 'Settings')
      if (role === 'member') {
        await expect(page.getByText('Only the Admin can change settings.')).toBeVisible()
        await scan()
        return
      }
      await expect(page.getByRole('region', { name: 'Setup needed' })).toBeVisible()
      await scan('as it opens')
      await page.getByLabel('App title').fill('Nan')
      await page.getByRole('button', { name: 'Save settings' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible()
      await scan('after Save')
      await page.getByLabel('App title').fill('')
      await page.getByRole('button', { name: 'Save settings' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await scan('with an error')
    },
  },
]

restoreAppTitleAfterEach() // the Settings page is saved from, and the Settings are shared by every test and both themes
forgetKeptReportsAfterEach() // a Report is kept for a Member to open (and the Admin's showing one keeps it), and the list is shared by every spec and both themes

test.describe('colour contrast of the main pages', { tag: '@theme' }, () => {
  for (const { path, roles = ROLES, phone, setup, visit } of PAGES) {
    for (const onPhone of phone ? [false, true] : [false]) {
      const who: Role[] = onPhone ? ['admin'] : roles
      const title = `${path} has no colour contrast violations${onPhone ? ' on a phone' : ''}, as ${who.length === 1 ? 'the Admin' : 'the Admin and as a Member'}`
      test(title, async ({ page, context, request, baseURL }, testInfo) => {
        const project = testInfo.project.name
        const data = dataFor(project)
        await seed(context, baseURL!, project)
        await setup?.({ page, request, baseURL: baseURL! })
        if (onPhone) await page.setViewportSize(PHONE)
        for (const role of who) {
          await signInAs(context, role)
          await visit({ page, context, baseURL: baseURL!, role, phone: onPhone, data, scan: scanner(page, project, onPhone ? `${path} on a phone` : path, role) })
        }
      })
    }
  }

  // The Rules page: the table of Rules (cards on a phone) and the D1 usage bar (switched on, with the Medium and High levels showing). A Member is told it is the Admin's. The Admin's Rule has its "⋯"
  // menu opened with the keyboard, as far as Remove, whose words are red on a pale red when it is highlighted; and the page is looked at again with a run of the Rules that is paused.
  for (const onPhone of [false, true]) {
    test(`/rules has no colour contrast violations${onPhone ? ' on a phone' : ''}, as ${onPhone ? 'the Admin' : 'the Admin and as a Member'}`, async ({ page, context, baseURL }, testInfo) => {
      const project = testInfo.project.name
      await seed(context, baseURL!, project)
      if (onPhone) await page.setViewportSize(PHONE)
      await page.route('**/api/features', (route) => route.fulfill({ json: usageOn }))
      await page.route('**/api/d1-usage', (route) => route.fulfill({ json: usageFigures({ rowsRead: 2_750_000, rowsWritten: 105_000 }) }))
      await withRules(context, baseURL!, testInfo, ['CONTRAST'], async ([rule]) => {
        try {
          for (const role of onPhone ? (['admin'] as const) : ROLES) {
            await signInAs(context, role)
            await page.goto('/rules')
            await heading(page, 'Rules')
            if (role === 'admin') {
              await expect(ruleActions(page, rule)).toBeVisible()
              await expect(page.getByRole('region', { name: 'Free database allowance' }).getByRole('progressbar')).toHaveCount(2)
            } else {
              await expect(page.getByText('Only the Admin can use this page.')).toBeVisible()
            }
            const scan = scanner(page, project, onPhone ? '/rules on a phone' : '/rules', role)
            await scan()
            if (role === 'admin') {
              await ruleActions(page, rule).focus()
              await page.keyboard.press('Enter')
              await expect(menuAction(page, 'Edit')).toBeFocused()
              await arrowTo(page, 'Remove')
              await scan('with the row menu open and Remove highlighted', { within: OPEN_MENU })
              await page.keyboard.press('Escape')

              await page.route('**/api/rules/rerun/step', (route) => route.fulfill({ json: { job: runningJob({ paused: true }) } }))
              await page.route('**/api/rules/rerun', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { job: runningJob({ paused: true }) } }) : route.fallback()))
              await page.goto('/rules')
              await expect(page.getByRole('status').filter({ hasText: 'Paused until the daily allowance resets, around midday NZ time.' })).toBeVisible()
              await scan('with a paused run')
            }
          }
        } finally {
          await signInAs(context, 'admin') // withRules takes the Rule away as the Admin
        }
      })
    })
  }

  // What opens over a page on a phone, as the Admin: the sidebar (a sheet, with the group that has Settings open) and the menu of the display settings and Sign out. Each is scanned where it is.
  test('the phone\'s sidebar sheet has no colour contrast violations, open, as the Admin', async ({ page, context }, testInfo) => {
    await signInAs(context, 'admin')
    await page.setViewportSize(PHONE)
    await page.goto('/reports')
    await heading(page, 'Reports')
    await openNavGroup(page, 'Set up')
    await scanner(page, testInfo.project.name, 'the phone\'s sidebar sheet', 'admin')('open', { within: '[data-slot="sidebar"][data-mobile="true"]' })
  })

  test('the phone\'s display settings and sign out menu has no colour contrast violations, open, as the Admin', async ({ page, context }, testInfo) => {
    await signInAs(context, 'admin')
    await page.setViewportSize(PHONE)
    await page.goto('/reports')
    await heading(page, 'Reports')
    await openHeaderControls(page)
    await scanner(page, testInfo.project.name, 'the phone\'s display settings menu', 'admin')('open', { within: '[data-slot="popover-content"]' })
  })

  // The sidebar as the icon rail, with the tooltip of the group that has focus showing.
  test('the sidebar rail with a tooltip showing has no colour contrast violations, as the Admin', async ({ page, context }, testInfo) => {
    await signInAs(context, 'admin')
    await page.goto('/reports')
    await heading(page, 'Reports')
    await siteHeader(page).getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(page.locator('[data-slot="sidebar"]:not([data-mobile])')).toHaveAttribute('data-state', 'collapsed')
    await settle(page)
    await navGroup(page, 'Help').focus()
    await page.keyboard.press('Shift') // a key, so that focus is drawn as it is for the keyboard
    await expect(page.getByRole('tooltip')).toHaveText('Help')
    await scanner(page, testInfo.project.name, 'the sidebar rail', 'admin')('with the tooltip showing')
  })

  // That the sweep's own scan asks for colour contrast: it reports pale words on white (shell.spec.ts has the shared check's own option).
  test('the sweep\'s scan reports pale text, so it does ask for colour contrast', async ({ page, context }, testInfo) => {
    await signInAs(context, 'admin')
    await page.goto('/styleguide')
    await heading(page, 'Styleguide')
    await page.evaluate(() => {
      const faint = document.createElement('p')
      faint.textContent = 'Pale grey words on white'
      faint.style.cssText = 'color: #ddd; background: #fff'
      document.querySelector('main')!.append(faint)
    })
    await expect(scanner(page, testInfo.project.name, '/styleguide', 'admin')()).rejects.toThrow('color-contrast')
  })
})
