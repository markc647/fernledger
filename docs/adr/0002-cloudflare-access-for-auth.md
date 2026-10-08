# Cloudflare Access handles sign-in; the app only authorises

The app has no login, passwords or sessions of its own. Cloudflare Access sits in front of the whole Worker: email one-time PIN, 24-hour session, with an allowlist of Member emails. The app reads the Access-verified email to decide whether the request comes from the Admin (can edit) or another Member (read-only). We chose this to keep credentials out of a system holding an elderly person's financial data. It also means adding or removing a Member is a dashboard change, not a code change.

## Consequences

- The app must validate the Access JWT on every request, not just trust the email header, so that a misconfigured route can't bypass it.
- Anyone deploying the open-source version needs a Cloudflare Zero Trust account (free tier is enough).
