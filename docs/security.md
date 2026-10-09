# Security

This page sets out what Fernledger protects, what it doesn't, and what to do if something goes wrong. For the law and Akahu's terms, see [privacy.md](privacy.md). To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Contents

- [Threat model](#threat-model)
- [If something goes wrong](#if-something-goes-wrong)

## Threat model

Each Deployer runs their own copy in their own Cloudflare account. There is no Fernledger server, so the authors can't see your data, lose it, or be breached for it.

### What is protected

| Threat | Protection |
|---|---|
| A stranger reaching the app | Only people you list can reach it. Anyone else stops at Cloudflare's login page. The example policy also limits sign-in to New Zealand. |
| Stolen or guessed passwords | The app has no passwords. [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) handles sign-in with email one-time codes, or Google/Microsoft with MFA. |
| A forged or missing sign-in token | The app checks Access's signed token (signature, issuer, audience) on **every** request. If configuration is missing, it refuses all requests rather than allowing them (ADR 0002). |
| A Member changing data | Read-only by default. Only the Admin can change anything, and every change goes in the Change Log, which all Members can see. |
| A leaked Akahu token (if you use Akahu Sync) | Akahu personal-app tokens can't make payments, so a leak exposes history, not money. Tokens are stored as encrypted Worker secrets, never in code or the database. |
| Interception or disk theft | Data is encrypted in transit (TLS) and at rest (D1, R2). |
| Cross-site attacks | Changes must come from the app's own address with a JSON body. Strict security headers are set: a Content Security Policy, no framing, no referrer. |
| Malicious spreadsheet formulas in exports | CSV cells that would run as spreadsheet formulas, such as a payee named `=HYPERLINK(…)`, are escaped. |
| Data leaking through logs | Logs contain only IDs, counts and error types, never Transactions, tokens or emails. A test enforces this. |
| Data leaving for third parties | Nothing calls home: no analytics, telemetry, email or third-party scripts. |
| Bank data in the repository | [gitleaks](https://github.com/gitleaks/gitleaks) secret scanning, with extra rules that block NZ bank account numbers and bank CSV exports from ever being committed. |

### What is not protected

See [What it can't protect against](../README.md#what-it-cant-protect-against) in the README.

## If something goes wrong

If you think your deployment has been breached, the Deployer should work through this checklist:

1. If you use Akahu Sync, revoke the Akahu token.
2. Change the app's secrets.
3. Review Cloudflare Access sign-in logs.
4. If you use Akahu Sync, tell Akahu, as its terms require.
5. Check whether you must notify the Privacy Commissioner and the people affected.

[privacy.md](privacy.md) explains the notification rules and Akahu's breach term, and when to get legal advice.

If the problem is a vulnerability in Fernledger itself, report it privately as described in [SECURITY.md](../SECURITY.md).

How the code itself is kept safe is described in the [README](../README.md#how-the-code-is-kept-safe).
