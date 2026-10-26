// A Report lives in its address (`/reports/spending?account=2&from=2026-01-01&to=2026-12-31`, the Account left out for all of them), so it can be reopened, bookmarked or sent on.
// A Report's form builds that address from its fields, the way a plain form would send them, and shows the Report on the same page.

/** The address of a Report's page with what was chosen on its form: the fields in the order the form has them, a blank one (All Accounts, a From left empty) left out. */
export function reportHref(page: string, fields: Iterable<[string, FormDataEntryValue]>): string {
  const query = new URLSearchParams()
  for (const [name, value] of fields) {
    if (typeof value === 'string' && value !== '') query.append(name, value)
  }
  const search = query.toString()
  return search === '' ? page : `${page}?${search}`
}

/** What a page's search says of the choices the Report reads (`choices`), in a fixed order: the same choices in another order, a blank one (an earlier form sent `account=`) and one the Report does not read are the same. */
function choicesIn(search: URLSearchParams, choices: readonly string[]) {
  const read = new URLSearchParams([...search].filter(([name, value]) => value !== '' && choices.includes(name)))
  read.sort()
  return read.toString()
}

/**
 * Whether `href` (from `reportHref`) is the Report that is open now: the same page with the same choices, of the `choices` that Report reads (src/lib/reports.ts), so a Budget
 * address with an `account` in it, which a Budget leaves out, is the same Report. Asking for it again is a request to read it again.
 */
export function isSameReport(href: string, open: { pathname: string; search: string }, choices: readonly string[]): boolean {
  const [page = '', search = ''] = href.split('?')
  return page === open.pathname && choicesIn(new URLSearchParams(search), choices) === choicesIn(new URLSearchParams(open.search), choices)
}
