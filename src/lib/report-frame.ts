import { formatDate, formatDateAtTime } from './format'

// The words a Report puts in the margin of every page after the first (src/components/report-frame.tsx), and how a page hands
// them to CSS: a page margin box can only be filled by CSS, so the text travels as a custom property on the document.

/** "Thu 1 Oct 2026 to Sat 31 Oct 2026", or one date when the range is a single day. Both ends included. */
export const describeRange = (from: string, to: string) => (from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`)

/** "Generated Thu 8 Oct 2026 at 3:42 pm by admin@example.com". The reader of a printout sees who printed it and when. */
export const generatedLine = (generatedAt: Date | number, email: string) => `Generated ${formatDateAtTime(generatedAt)} by ${email}`

/** The longest running head, in characters. The margin is a few lines deep; a long title and Account list must not outgrow it. */
const MAX_HEAD = 200

/** The head of every page after the first: the app title, the Report, the Account(s) and the dates, so a loose page still says what it is. */
export function runningHead({ appTitle, name, accounts, range }: { appTitle: string; name: string; accounts: string; range: string }) {
  const characters = Array.from(`${appTitle} · ${name} · ${accounts} · ${range}`)
  return characters.length <= MAX_HEAD ? characters.join('') : `${characters.slice(0, MAX_HEAD - 1).join('')}…`
}

/**
 * `text` as a CSS string token, to use as a custom property's value for `content:`. The Admin's title and a bank's wording can
 * hold anything, so a quote or backslash is escaped (it can't end the string and add CSS), and a line break, which a CSS string
 * can't hold, becomes a space.
 */
export const cssString = (text: string) => `"${text.replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]+/g, ' ')}"`
