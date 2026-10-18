import { useSyncExternalStore } from 'react'

// What the page knows of the visitor's sign-in, learned from the API calls it makes. Cloudflare Access sits in front of the whole app (ADR 0002). When its session runs out it
// answers every request, API calls included, with a redirect to its sign-in page on another host, which the page's Content Security Policy refuses to follow (`connect-src
// 'self'`, ADR 0010). So every API call asks not to follow a redirect and reads one as "your sign-in has expired". A 401 is something else: the Worker was reached and
// does not accept the visitor's Access token (worker/auth.ts), which signing in again does not mend. Either lasts until a call works again, so a one-off does not stay.

export type SessionProblem = 'expired' | 'not-signed-in'

let problem: SessionProblem | null = null
/** A count of calls started and problems noted, so that a call that works clears only a problem that came before it was asked, not one that came while it was being answered. */
let ticks = 0
let notedAt = 0
const listeners = new Set<() => void>()

const changed = () => {
  for (const listener of listeners) listener()
}

const note = (next: SessionProblem) => {
  notedAt = ++ticks
  if (problem === 'expired' || problem === next) return // an expired sign-in is the more specific, and stays until a call works
  problem = next
  changed()
}

const worked = (startedAt: number) => {
  if (problem === null || startedAt < notedAt) return
  problem = null
  changed()
}

/** What an API call has found wrong with the sign-in, or null while none has (or once a call has worked since). */
export const sessionProblem = () => problem

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The sign-in problem the API calls have found, and re-renders when one is found or goes. */
export const useSessionProblem = () => useSyncExternalStore(subscribe, sessionProblem)

/**
 * True for Access's redirect to its sign-in page: a browser hands back an opaque redirect (status 0) when it was told not to follow one, and the Worker's own answers are never
 * a 3xx. (A 304 is not a redirect.)
 */
export const isAccessRedirect = ({ type, status }: Pick<Response, 'type' | 'status'>) => type === 'opaqueredirect' || (status >= 300 && status < 400 && status !== 304)

/**
 * `fetch` for the typed API client (src/lib/api.ts): the same call, but a redirect is not followed and what the answer says of the sign-in is noted. The answer is handed back
 * as it is (a redirect is `ok: false`, status 0), so a caller that treats any failure as one still does; the page says what is wrong with the sign-in (a banner over the page, or
 * in its place when nothing has loaded yet) and a call that works afterwards takes that away.
 * It only wraps the browser's own `fetch` for the API client's own-origin calls: nothing here names an address (ADR 0010). Its default is the one place `fetch` is named in `src/`, as a
 * value and not a call, which scripts/outbound-calls.test.mjs does not read as one (its known limits say so).
 */
export const sessionAwareFetch =
  (inner: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    const startedAt = ++ticks
    const res = await inner(input, { ...init, redirect: 'manual' })
    if (isAccessRedirect(res)) note('expired')
    else if (res.status === 401) note('not-signed-in')
    else if (res.ok) worked(startedAt)
    return res
  }

/** The query Fernledger adds when it sends the visitor to sign in again, and removes once the page has loaded. Its value only has to be new each time. */
const SIGN_IN_PARAM = '_signin'

/**
 * A path as a path of this site: one slash at the start, never two, which an address to go to would read as another site's (`//evil.test/x`, and `/\evil.test`, which a browser reads
 * the same way). `location.pathname` can begin with `//` for an address that someone else wrote.
 */
const ownPath = (path: string) => `/${path.replace(/^[\\/]+/, '')}`

const queryParts = (search: string) => search.replace(/^\?/, '').split('&').filter((part) => part !== '')
const isSignInPart = (part: string) => part === SIGN_IN_PARAM || part.startsWith(`${SIGN_IN_PARAM}=`)

/**
 * Where "Sign in again" goes: the page the visitor is on, with a value added to its query that is new each time. A navigation to an address the browser has never fetched
 * can't be answered from its cache, so it reaches Access, which sends the visitor to its sign-in page and back to this address; `withoutSignInParam` takes the value off then.
 * The rest of the query is kept exactly as it was.
 */
export function signInAgainUrl({ pathname, search, hash }: { pathname: string; search: string; hash: string }, now: number) {
  const kept = queryParts(search).filter((part) => !isSignInPart(part))
  return `${ownPath(pathname)}?${[...kept, `${SIGN_IN_PARAM}=${now}`].join('&')}${hash}`
}

/** The address (path, query and hash) without the value `signInAgainUrl` added, or as it was if it has none. */
export function withoutSignInParam(address: string) {
  const { pathname, search, hash } = new URL(ownPath(address), 'http://localhost')
  const parts = queryParts(search)
  const kept = parts.filter((part) => !isSignInPart(part))
  return kept.length === parts.length ? address : `${pathname}${kept.length ? `?${kept.join('&')}` : ''}${hash}`
}
