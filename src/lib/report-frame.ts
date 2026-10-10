import { formatDate, formatDateAtTime } from './format'

// The words a Report writes about itself (src/components/report-frame.tsx): its dates, when and by whom it was generated, the
// one line that says what a page is, and the Account as the bank and the family know it.

/** "Thu 1 Oct 2026 to Sat 31 Oct 2026", or one date when the range is a single day. Both ends included. */
export const describeRange = (from: string, to: string) => (from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`)

/** "Generated Thu 8 Oct 2026 at 3:42 pm by admin@example.com". The reader of a printout sees who printed it and when. */
export const generatedLine = (generatedAt: Date | number, email: string) => `Generated ${formatDateAtTime(generatedAt)} by ${email}`

/** An Account by its name and the bank's number: "Example savings (99-9999-9999999-99)". */
export const accountLabel = ({ name, accountNumber }: { name: string; accountNumber: string }) => `${name} (${accountNumber})`

/**
 * The line that says what a page is: the app title, the Report, the Account and the dates. It is the browser's page title
 * (so "Save as PDF" names the file after it) and the first line of every printed table's heading, which a browser repeats at
 * the top of each page the table runs onto, in every browser, so a loose page still says what it is.
 */
export const reportHeading = ({ appTitle, name, accounts, range }: { appTitle: string; name: string; accounts: string; range: string }) =>
  `${appTitle} – ${name} – ${accounts} – ${range}`
