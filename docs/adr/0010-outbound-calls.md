# The Worker contacts no one but Akahu and your own Cloudflare Access

Fernledger holds a family's bank data, so what leaves the Worker is a promise, not a detail. The Worker makes two kinds of outbound call and no others:

- **Akahu**, only if you use Sync (ADR 0008). With CSV Imports alone the Worker never contacts Akahu.
- **Your own Cloudflare Access team domain**, to fetch the public keys that verify a sign-in (`<team>.cloudflareaccess.com/cdn-cgi/access/certs`). That is the Deployer's own sign-in service (ADR 0002), not a third party.

Nothing else: no update check, analytics, telemetry or email, and nothing to GitHub. The wording used everywhere is: no one but Akahu (only if you use Sync) and, to check a sign-in, your own Cloudflare Access.

## Consequences

- The browser is held to the same promise by the Content Security Policy (`connect-src 'self'`, `worker/security-headers.ts`), and the page loads nothing from another host.
- Tests enforce it: `worker/outbound.test.ts` runs every route and cron with `fetch` replaced by a recorder, and `scripts/outbound-calls.test.mjs` scans `worker/` and `src/` for any other way of calling out. A new Akahu call extends both rather than widening what they allow.
- The Worker cannot check for updates, because that would mean contacting GitHub. Updates arrive through the Deployer's own repository (README [Updating](../../README.md#updating)).
