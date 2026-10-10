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
- Spending is every Transaction that isn't a Transfer. A query that lists, filters or totals spending (Budgets, Reports, the Summary, a Category total) builds from `effectiveCategory()` in `worker/effective-category.ts` and uses its `isTransfer`, never its own version of "paired, or a Rule marks it, unless the Admin said Not a Transfer", and a test proves a Transfer is left out.
- A Category shown to a reader (a page, a Report, a CSV file) comes from `effectiveCategory().shown`, never its `id`, `name` or `source`: a Transfer has none, and shows as a Transfer rather than as Uncategorised or under a Rule's Category.
- A batch that adds Transactions (Import today, Sync when it lands) puts `pairTransfersStatement` (`worker/transfers.ts`) in the same batch, after the insert and the Rules, so a Transfer is never missed. A batch that removes Transactions also lets go of their matching Transactions in the same batch, because a pair's pointer is deliberately not a foreign key (`migrations/1501_transfers.sql`).
- Every Admin change is written with `recordChange` (`worker/changelog.ts`), which batches it with its Change Log entry. Never write to the Change Log separately. Each entry has a `type` from `CHANGE_TYPES`; a new kind of Admin change adds its type there so Members can filter by it.
- Log with `logEvent` (`worker/log.ts`), not `console`: it takes only an event name, an ID, a count and an error, which it reduces to its class.
- A feature that needs optional configuration declares it in `worker/features.ts` and puts `requireFeature` in front of its routes, so it shows "Setup needed" rather than failing. Messages come from the declaration, never from a missing or present value.
- Change requests need the Admin, a same-origin `Origin` and a JSON body; the guard runs before any handler, so handlers don't re-check. It checks the JSON content type only; each handler validates the body's shape with zod. The exceptions are the row lists: Import rows and carry-preview rows (`worker/import-rows.ts`, `badRowField` and `badPreviewField`). 500 rows through a zod schema cost more than the 10 ms CPU budget (ADR 0004), so they are checked by hand and the request envelope around them still uses `zod/mini`. Don't hand-validate anything small.

## Migrations
- Files in `migrations/` are named `<ticket number × 100 + n>_<name>.sql`, n from 01 to 99, lower-case name. Ticket 8 owns `0801_…` to `0899_…`; ticket 2 owns `0201_…` to `0299_…`. Parallel tickets can't collide, and wrangler applies files in numeric order.
- Add a new file rather than editing one that has merged. Migrations are add-only (ADR 0009): new tables, nullable columns, indexes. `DROP` and `RENAME` wait for a later release.
- `npm run migrations:check`, part of `npm run check`, fails on a duplicate prefix, a badly named file, or any `DROP` or `RENAME`.
- `npm run check` also upgrades every sample database in `test/sample-dbs/` and fails if data is lost or a merged migration was edited ([docs/releasing.md](docs/releasing.md#sample-databases)). A migration that rewrites existing values needs its expected change written into that test.

## Outbound calls
- The app contacts no one but Akahu (only if you use Sync) and, to check a sign-in, your own Cloudflare Access ([ADR 0010](docs/adr/0010-outbound-calls.md)). Don't add a `fetch`, socket or beacon without Akahu Sync's reason for it: `worker/outbound.test.ts` and `scripts/outbound-calls.test.mjs` fail on one, and a new Akahu call extends both rather than widening what they allow.

## Docs
- Each meaning has one home. `README.md` carries every decision for prospective users. Other docs link to README sections rather than restating them, and add only detail the README lacks.
- Describe what exists in the present tense and what's coming in the future tense ("will ship"). Never promise a process that doesn't exist yet.

## Security and privacy
- Every trust boundary has negative tests, not just the happy path: a wrong issuer, an expired token, a spoofed `Host`, a Member attempting a write, a missing setting (fail closed).
- Error messages and logs identify a problem by line number, field name, ID, count or error class. They never echo a transaction value, email or token.
- Workers invocation logs stay off in `wrangler.jsonc` (`observability.logs.invocation_logs: false`): they record request URLs and headers, including the Access email. A script test fails if it's re-enabled.
- Secret-scan allowlists match specific fake values (bank code 99), never whole paths or whole rules.

## Tests
- Test behaviour at three seams: the Worker boundary, the bank CSV adapters, and the browser (Playwright, kept small). Worker tests go through the real request path (`exports.default.fetch`). Call `worker.fetch` directly only when the test must change the Worker's env.
- Fixtures are made up and follow the hard rule in `AGENTS.md`. See `docs/bank-formats/` for each layout.
- A test proves something only if it would fail when the code it protects is removed. Reviewers check this for security tests.

## Dependencies
- Add one only when a few lines can't do the job. Prefer the smallest entry point (`zod/mini`, not `zod`).

## UI
- shadcn/ui components and plain NZ English ("Money in" / "Money out"). The commitments (WCAG 2.2 AA, text sizes, touch targets, zoom, colour, high contrast) are in README [Accessibility](README.md#accessibility); a diff that breaks one fails review.
- Use the shared building blocks rather than formatting by hand: `formatAmount`, `formatBalance`, `formatDate` and `formatInstantDate` (`src/lib/format.ts`), `Amount`, `Status`, and `ResponsiveTable`. `/styleguide` shows them, and the browser tests scan it.
- Size text in `rem` so the A / A+ / A++ control scales it, and use `size="touch"` for interactive targets.
- Add a new page to the zoom test in `e2e/display.spec.ts`.
- A printout leaves out the app header (`print:hidden` in `src/routes/__root.tsx`), and with it the app title, so a printable page writes its own title, as How to sign in does.
- A Report goes inside `ReportFrame` (`src/components/report-frame.tsx`), which writes the title block and sets the page title and the page number's margin (in `src/index.css`; README [Reports](README.md#reports)). Don't write a Report's own title or `@page` rules.
- A Report's tables are `ResponsiveTable` with `className="print:text-[12pt]"` and `printHeading={useReportIdentity()(account)}`, so every printed page says what it is in every browser; nothing in a Report is under 12pt in print.
- A Report that lists rows reads them a page at a time from `/api/reports/…` (ADR 0004), through `loadListing` in `src/lib/report-transactions.ts` and its cap, and says what it did not read (never "nothing" for an Account it stopped before).
- A new Report adds its print layout (page count, repeated headings, type size) to `e2e/reports.spec.ts` and its page to the zoom test.
- Show state with a border or outline as well as a box-shadow or fill: Windows high contrast removes the latter.
