# Agent guide: Fernledger

Self-hosted NZ bank-account tracker on Cloudflare Workers (free plan) + D1 + R2, behind Cloudflare Access. Read README.md for what and why.

## Before you change anything
- Use the terms in `GLOSSARY.md` in code, tests, issues and PRs. Don't use the synonyms it marks _Avoid_.
- Read the ADRs in `docs/adr/` that touch your area. If your change contradicts one, say so explicitly.

## Conventions
- Money is integer NZD cents. Dates are NZ dates (Pacific/Auckland). Show a Bank Time only if the bank supplied one.
- Business logic lives in pure functions with Vitest tests. Worker handlers stay thin.
- Plain D1 SQL, no ORM (ADR 0005). Migrations only add things; drops and renames come in a later release (ADR 0009).
- Stay inside the Workers Free plan: 10 ms CPU, 50 queries/subrequests per invocation, batched writes (ADR 0004).
- Every /api request is authenticated via the Access JWT. Members are read-only. Fail closed.
- Never log transactions, tokens or emails, only IDs, counts and error types.
- UI: shadcn/ui, WCAG 2.2 AA, plain NZ English, amounts signed and right-aligned with fixed-width digits.

## Never
- Commit real bank data, names, emails, account numbers or Cloudflare resource IDs. This repo is public. Use the made-up fixtures in `test/fixtures/`.
- Add a dependency for something a few lines can do.

## Agent skills

### Issue tracker
Issues and specs live in GitHub Issues on markc647/fernledger, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels
Default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
