import type { Route } from '@playwright/test'

// Cloudflare Access's session ends after the length the Deployer chose (24 hours, docs/setup.md). After that, Access answers every request for the app's host, API calls included, with a 302
// to its sign-in page on the team's own domain, and says not to keep it. The page's Content Security Policy (connect-src 'self') would refuse to follow it, and Chrome reports that as an
// error, so the page asks not to follow any redirect and reads one as "your sign-in has expired" (src/lib/session.ts). Local development has no Access, so a spec makes the answer itself.
export const ACCESS_SIGN_IN = 'https://example.cloudflareaccess.com/cdn-cgi/access/login/localhost?kid=0123abcd&meta=made-up&redirect_url=%2Fapi%2Fme'

/** Answers a request as Access does once the session has run out. */
export const accessRedirect = (route: Route) => route.fulfill({ status: 302, headers: { Location: ACCESS_SIGN_IN, 'Cache-Control': 'private, no-store' } })
