import { isSameReport } from './report-address'

// "Print" on the Reports page opens the Report and starts the browser's print once the Report is there. The two pages are not in the same place in the app, so the request waits here
// between them. It is for one Report, which it names by its address, and for a short time: a Report that never arrives (it could not be read, or the reader went elsewhere) must not
// print some other Report later.

/** How long a request to print lasts. Reading a Report takes seconds; this is long enough for a slow one and short enough that a forgotten request is gone. */
export const PRINT_REQUEST_LASTS_MS = 60_000

let asked: { href: string; at: number } | null = null

/** Asks for the Report at `href` (a Report's address with its choices, `reportHref`) to be printed when it is shown. */
export function askToPrint(href: string, now = Date.now()) {
  asked = { href, at: now }
}

/** Forgets a request to print. A Report opened without one calls this, so a Print whose Report never arrived (it could not be read) does not print this one, or another, later. */
export function clearPrintRequest() {
  asked = null
}

/**
 * Whether the Report shown now is the one asked to be printed, once: the request is used up by this call, whatever the answer. `choices` are the search parameters the Report reads
 * (src/lib/reports.ts), so the same Report written another way (its choices in another order) is the same one.
 */
export function takePrintRequest(open: { pathname: string; search: string }, choices: readonly string[], now = Date.now()): boolean {
  const request = asked
  asked = null
  return request !== null && now - request.at <= PRINT_REQUEST_LASTS_MS && isSameReport(request.href, open, choices)
}
