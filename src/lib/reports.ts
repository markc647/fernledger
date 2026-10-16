import { NOT_COUNTED_AS_SPENDING_OR_INCOME } from './budgets'

/**
 * The six Reports, in the order the sidebar lists them (src/lib/report-nav.ts). Each has a page of its own at `to` (src/routes/reports_.*.tsx), where its form and the Report are together.
 * `name` is what the Report is called everywhere (the page, the sidebar, the breadcrumb, the list of kept Reports, the Report's own title); `choices` are the address's search
 * parameters the Report reads (a Budget has no Account), and `about` is the paragraph under the page's heading, which says what the Report holds.
 */
export const REPORTS = {
  spending: {
    to: '/reports/spending',
    choices: ['account', 'from', 'to'],
    name: 'Spending by Category',
    about: "What each Category spent in the dates you choose, the most spent first, with the total. Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted.",
  },
  incomeVsSpending: {
    to: '/reports/income-vs-spending',
    choices: ['account', 'from', 'to'],
    name: 'Income vs spending by month',
    about: `What came in and what was spent in each month of the dates you choose, with the difference and the totals. ${NOT_COUNTED_AS_SPENDING_OR_INCOME}`,
  },
  loans: {
    to: '/reports/loans',
    choices: ['category', 'from', 'to'],
    name: 'Loans',
    about: "How much each person owes, or is owed, on a loan, with the lending and the repayments listed, in the dates you choose. Loans aren't counted as spending or income.",
  },
  transactions: {
    to: '/reports/transactions',
    choices: ['account', 'from', 'to'],
    name: 'Transaction listing',
    about: 'Every Transaction in the dates you choose, with its Category and Note, Account by Account, oldest first.',
  },
  balances: {
    to: '/reports/balances',
    choices: ['account', 'from', 'to'],
    name: 'Balances over time',
    about: "Each Account's balance at the end of every month in the dates you choose, with the balance when they begin and when they end, and any Balance Check differences.",
  },
  budgetVsActual: {
    to: '/reports/budget-vs-actual',
    choices: ['from', 'to'],
    name: 'Budget vs actual',
    about: "Each Category's Budget against what it spent, month by month, for the months your dates touch, with the months that have ended added together.",
  },
} as const

export type ReportInfo = (typeof REPORTS)[keyof typeof REPORTS]
