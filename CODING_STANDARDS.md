# Coding standards

Reviewers apply these to every diff. They're judgement calls. Anything mechanical is enforced by `npm run check` and CI, not listed here.

## Domain language
- Code, tests, docs and messages use `GLOSSARY.md` terms, not its _Avoid_ synonyms ("Member", not "user").
- Fields that come straight from a bank or Akahu are prefixed so they can't be mistaken for a glossary concept (`bankMemo`, not `memo`, which would read as a Note).

## ADR conformance
- A diff that contradicts an ADR in `docs/adr/` says so explicitly in its PR or commit message.
- These ADRs are the ones most often broken in passing:
  - **0004, free plan:** each invocation gets 10 ms of CPU and 50 subrequests / D1 queries. Loops over Transactions run as SQL or in chunks, and writes are batched.
  - **0005, plain D1 SQL:** no ORM or query builder.
  - **0007, data location:** Oceania is a location hint, never "stored in Sydney" or a residency guarantee.
  - **0008, Akahu optional:** anything about Akahu (tokens, revoking, Sync) is conditional on using Akahu Sync.
  - **0009, add-only migrations.**

## Structure
- Business logic lives in pure functions with their own tests. Worker handlers stay thin: authenticate, validate, call the logic, respond.
- Every `/api` request is authenticated via the Access JWT and fails closed.

## Docs
- Each meaning has one home. `README.md` carries every decision for prospective users. Other docs link to README sections rather than restating them, and add only detail the README lacks.
- Describe what exists in the present tense and what's coming in the future tense ("will ship"). Never promise a process that doesn't exist yet.

## Security and privacy
- Every trust boundary has negative tests, not just the happy path: a wrong issuer, an expired token, a spoofed `Host`, a Member attempting a write, a missing setting (fail closed).
- Error messages and logs identify a problem by line number, field name, ID, count or error class. They never echo a transaction value, email or token.
- Secret-scan allowlists match specific fake values (bank code 99), never whole paths or whole rules.

## Tests
- Test behaviour at three seams: the Worker boundary, the bank CSV adapters, and the browser (Playwright, kept small). Worker tests go through the real request path (`exports.default.fetch`). Call `worker.fetch` directly only when the test must change the Worker's env.
- Fixtures are made up and follow the hard rule in `AGENTS.md`. See `docs/bank-formats/` for each layout.
- A test proves something only if it would fail when the code it protects is removed. Reviewers check this for security tests.

## Dependencies
- Add one only when a few lines can't do the job. Prefer the smallest entry point (`zod/mini`, not `zod`).

## UI
- shadcn/ui components, WCAG 2.2 AA, plain NZ English ("Money in" / "Money out").
- Amounts are signed, right-aligned NZD with fixed-width digits. Dates read like "Tue 8 Oct 2026".
- Colour is never the only signal: pair it with an icon or words.
