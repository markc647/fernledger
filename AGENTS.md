# Agent guide: Fernledger

Self-hosted NZ bank-account tracker on Cloudflare Workers (free plan) + D1 + R2, behind Cloudflare Access. `README.md` says what and why. The spec is issue #1.

## Where things are
- `GLOSSARY.md`: domain terms. Name things with these.
- `docs/adr/`: decisions. Read the ones touching your area before changing it.
- `CODING_STANDARDS.md`: what reviewers enforce. Read it when you're unsure how to do something.
- `docs/bank-formats/`: bank CSV layouts, with made-up examples. Real exports never enter this repo.

## Before reporting work done
- Run `npm run check` (lint, typecheck, tests, secret scan). It's green when it exits 0.

## Hard rules
- This repo is public. Data in it is made up (bank code 99 fixtures). Cloudflare resource IDs, names, emails and real account numbers stay out of it.
- Money is integer NZD cents. Dates are NZ dates (Pacific/Auckland).

## Agent skills

### Issue tracker
Issues and specs live in GitHub Issues on markc647/fernledger, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels
Default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
