import { formatDate, formatDateAtTime } from './format'
import { isGeneratedKey } from './account-key'

// The words a Report writes about itself (src/components/report-frame.tsx): its dates, when it was generated, the
// one line that says what a page is, and the Account as the bank and the family know it.

/** "Thu 1 Oct 2026 to Sat 31 Oct 2026", or one date when the range is a single day. Both ends included. A Report with no start date begins at the first Transaction. */
export const describeRange = (from: string | null, to: string) =>
  from === null ? `From the first Transaction to ${formatDate(to)}` : from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`

/** "Generated Thu 8 Oct 2026 at 3:42 pm". The reader of a printout sees when the figures were worked out, not who asked for them. */
export const generatedLine = (generatedAt: Date | number) => `Generated ${formatDateAtTime(generatedAt)}`

/**
 * An Account by its name and the bank's number: "Example savings (99-9999-9999999-99)". An Account whose key Fernledger
 * generated, because its bank prints no number, is its name alone: the key is not a number the bank issued (ADR 0017).
 */
export const accountLabel = ({ name, accountNumber }: { name: string; accountNumber: string }) => (isGeneratedKey(accountNumber) ? name : `${name} (${accountNumber})`)

/**
 * The line that says what a page is: the app title, the Report, the Account and the dates. It is the browser's page title
 * (so "Save as PDF" names the file after it) and the first line of every printed table's heading, which a browser repeats at
 * the top of each page the table runs onto, in every browser, so a loose page still says what it is.
 */
export const reportHeading = ({ appTitle, name, accounts, range }: { appTitle: string; name: string; accounts: string; range: string }) =>
  `${appTitle} – ${name} – ${accounts} – ${range}`
