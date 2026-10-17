# The Worker contacts no one but Akahu and your own Cloudflare account

Fernledger holds a family's bank data, so what leaves the Worker is a promise, not a detail. The Worker makes three kinds of outbound call and no others (the third was added on 2026-10-14, [below](#amendment-2026-10-14-the-d1-usage-bar)):

- **Akahu**, only if you use Sync (ADR 0008). With CSV Imports alone the Worker never contacts Akahu.
- **Your own Cloudflare Access team domain**, to fetch the public keys that verify a sign-in (`<team>.cloudflareaccess.com/cdn-cgi/access/certs`). That is the Deployer's own sign-in service (ADR 0002), not a third party.
- **Your own Cloudflare account's usage figures**, only if you set a token for them (`https://api.cloudflare.com/client/v4/graphql`), for the Rules page's D1 usage bar. That is the Deployer's own account, read with the Deployer's own token, not a third party.

Nothing else: no update check, analytics, telemetry or email, and nothing to GitHub. The wording used in the docs and standards is: no one but Akahu (only if you use Sync) and your own Cloudflare account: its Access, to check a sign-in, and, only if you add a token for it, its D1 usage figures.

## Consequences

- The browser is held to the same promise by the Content Security Policy (`connect-src 'self'`, `worker/security-headers.ts`), and the page loads nothing from another host.
- Tests enforce it: `worker/outbound.test.ts` runs every route and cron with `fetch` replaced by a recorder, and `scripts/outbound-calls.test.mjs` scans `worker/` and `src/` for any other way of calling out. A new call extends both rather than widening what they allow.
- The Worker cannot check for updates, because that would mean contacting GitHub. Updates arrive through the Deployer's own repository (README [Updating](../../README.md#updating)).

## Amendment, 2026-10-14: the D1 usage bar

D1 Free allows 5 million rows read a day (ADR 0004), and a household's first set-up (about 7,000 Transactions) reached it, from creating Rules, checking how many Transactions they match and applying them. Cloudflare shows the figure in its dashboard and in its GraphQL Analytics API, and nowhere the Worker can see without asking. So the Rules page shows the Admin how much of the day the account has used, and for that the Worker makes one more call.

- **What it is.** One `POST https://api.cloudflare.com/client/v4/graphql` to the GraphQL Analytics API, for the `d1AnalyticsAdaptiveGroups` dataset: the whole account's `rowsRead` and `rowsWritten` for today (UTC, which is D1's day) (`worker/d1-usage.ts`). It is made when the Admin's browser asks for the figures (`GET /api/d1-usage`): when the question the Rules page asks before it applies the Rules opens, when the progress of a run that is paused for the allowance is shown (the question cannot be opened while a run is going), and when the Admin chooses Check again. It is not made on a timer or by a cron.
- **Only if the Deployer turns it on.** It needs two Worker secrets, `CF_ANALYTICS_TOKEN` (an account API token whose only permission is Account Analytics: Read) and `CF_ACCOUNT_ID`. Without both there is no call: the route answers "Not set up" and the page shows Setup needed, as for Akahu (ADR 0008; `worker/features.ts`). The product works fully without it.
- **It sends and reads nothing of Fernledger's.** The request carries the token, the account ID and a date. The answer is two numbers. No Transaction, Account, Note, Category or email is in either.
- **Why that keeps the promise.** The promise is that the Worker sends a family's data to no one else. This call goes to the Deployer's own Cloudflare account, which already hosts the Worker, the database and Access, with a key that can only read that account's usage. The "no analytics" in the README means the Worker sends none; this reads D1's own usage figures. It is held to that: the call is to exactly that address, from exactly that file, once for each request, and only with both secrets set.
- **It can fail without harm.** The figures run a few minutes behind. If Cloudflare is unreachable, slow (5 seconds at most), refuses the token or the account ID, finds no such account or answers with something else, the page says "Usage unavailable", with one of four fixed reasons and what to check, and none of Cloudflare's own words. The log records an event name and an error class, never a message, because a message can echo the token. The request never touches D1, so it still answers when the day's allowance is gone.
