import { NOT_COUNTED_AS_SPENDING_OR_INCOME } from './budgets'
import { MAX_INCOME_MONTHS } from './income-vs-spending'
import { MAX_REPORT_MONTHS } from './report-budget'
import { REPORT_ROW_CAP } from './report-transactions'

/**
 * The six Reports, in the order the sidebar lists them (src/lib/report-nav.ts). Each has a page of its own at `to` (src/routes/reports_.*.tsx), where its form and the Report are together.
 * `name` is what the Report is called everywhere (the page, the sidebar, the breadcrumb, the list of kept Reports, the Report's own title); `choices` are the address's search
 * parameters the Report reads (a Budget has no Account). `about` and `note` are the page's words, in its help sheet (the "?" beside its heading: src/components/report-gate.tsx):
 * `about` says what the Report holds, and `note` what the Admin's form will make of the choices, which a Member, who has no form, is not told.
 */
export const REPORTS = {
  spending: {
    to: '/reports/spending',
    choices: ['account', 'from', 'to'],
    name: 'Spending by Category',
    about: "What each Category spent in the dates you choose, the most spent first, with the total. Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted.",
    note: 'A Report has one row for each Category with spending in your dates, the most spent first, and one for Uncategorised when there is any.',
  },
  incomeVsSpending: {
    to: '/reports/income-vs-spending',
    choices: ['account', 'from', 'to'],
    name: 'Income vs spending by month',
    about: `What came in and what was spent in each month of the dates you choose, with the difference and the totals. ${NOT_COUNTED_AS_SPENDING_OR_INCOME}`,
    note: `A Report has one row for each month in your dates, with the income, the spending and the difference between them, and the totals above, up to ${MAX_INCOME_MONTHS} months. Your dates are counted exactly: a month they begin or end part way through counts only those dates, and the row says so.`,
  },
  loans: {
    to: '/reports/loans',
    choices: ['category', 'from', 'to'],
    name: 'Loans',
    about: "How much each person owes, or is owed, on a loan, with the lending and the repayments listed, in the dates you choose. Loans aren't counted as spending or income.",
    note: 'A Report has a section for each Loans Category you choose: its lending and repayments, oldest first, with what is owed after each and on the last date. Name each Category for its person, like “Loan – Alice”: that is how the Report knows who owes whom.',
  },
  transactions: {
    to: '/reports/transactions',
    choices: ['account', 'from', 'to'],
    name: 'Transaction listing',
    about: 'Every Transaction in the dates you choose, with its Category and Note, Account by Account, oldest first.',
    note: `A Report lists up to ${REPORT_ROW_CAP.toLocaleString('en-NZ')} Transactions.`,
  },
  balances: {
    to: '/reports/balances',
    choices: ['account', 'from', 'to'],
    name: 'Balances over time',
    about: "Each Account's balance at the end of every month in the dates you choose, with the balance when they begin and when they end, and any Balance Check differences.",
    note: 'A Report has one balance for the end of each month, with the balance when your dates begin and when they end.',
  },
  budgetVsActual: {
    to: '/reports/budget-vs-actual',
    choices: ['from', 'to'],
    name: 'Budget vs actual',
    about: "Each Category's Budget against what it spent, month by month, for the months your dates touch, with the months that have ended added together.",
    note: `A Budget is for a whole month, so a Report shows every month your dates touch, in full, up to ${MAX_REPORT_MONTHS} months. It is of all Accounts together.`,
  },
} as const

export type ReportInfo = (typeof REPORTS)[keyof typeof REPORTS]

/** What every Report's help sheet says about printing: the button that does it sits with the form (or, for a Member, above the Report), and how the print window is used is said here once. */
export const PRINT_HELP =
  "In the print window, choose “Save as PDF” to keep a copy. Chrome and Edge (version 131 or later) number the pages (“Page 2 of 5”) themselves. Firefox and Safari may need you to turn on the browser's headers and footers in the print dialog."
