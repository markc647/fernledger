# Cloudflare Access handles sign-in; the app only authorises

The app has no login, passwords or sessions of its own. Cloudflare Access sits in front of the whole Worker: email one-time PIN, 24-hour session, with an allowlist of Member emails. The app reads the Access-verified email to decide whether the request comes from the Admin (can edit) or another Member (read-only). We chose this to keep credentials out of a system holding an elderly person's financial data. It also means adding or removing a Member is a dashboard change, not a code change.

## Consequences

- The app must validate the Access JWT on every request, not just trust the email header, so that a misconfigured route can't bypass it.
- Anyone deploying the open-source version needs a Cloudflare Zero Trust account (free tier is enough).
- When the session ends, Access answers every request for the app's host, API calls included, with a redirect to its sign-in page on the team's domain, which the browser's Content Security Policy refuses to follow (ADR 0010). So the page asks its API calls not to follow redirects, reads one as "your sign-in has expired" and offers **Sign in again** (`src/lib/session.ts`); a 401 from the Worker is "Not signed in", a different thing, since signing in again does not mend it. The page's own document is `Cache-Control: no-store` (`public/_headers`), so a tab, Reload or Back asks Access and is not answered from the browser's copy.
