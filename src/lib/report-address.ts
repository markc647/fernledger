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

/** What a page's search says, as its choices in a fixed order, so the same choices written in another order, or with a blank one (an earlier form sent `account=`), are the same. */
const choicesIn = (search: URLSearchParams) =>
  JSON.stringify([...search].filter(([, value]) => value !== '').sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)))

/** Whether `href` (from `reportHref`) is the Report that is open now: the same page with the same choices. Asking for it again is a request to read it again. */
export function isSameReport(href: string, open: { pathname: string; search: string }): boolean {
  const [page = '', search = ''] = href.split('?')
  return page === open.pathname && choicesIn(new URLSearchParams(search)) === choicesIn(new URLSearchParams(open.search))
}
