# The Paid Plan lifts the app's own daily caps, and nothing else

Fernledger runs within the Cloudflare Workers Free plan ([ADR 0004](0004-runs-on-workers-free-plan.md)), and that stays the default. On Free, D1 allows 5 million rows read and 100,000 rows written a day, and once either runs out D1 refuses everything until 00:00 UTC. So the app keeps caps of its own that share the day out: the Members' daily read limit, the Rules re-run's share of the day, and Import's warning that a big replace takes more than a day's writes. A Cloudflare account on the Workers Paid plan has no daily allowance (it has monthly included usage, then pays per use), and those caps only hold it back.

**The Admin says which plan the account is on, with a switch on Settings ("Cloudflare Paid Plan", the Setting `cloudflare_plan`, off by default). On Paid, the daily caps are lifted, and the per-request limits are not.**

- **Lifted on Paid:** the Members' daily read limit (`worker/member-read-limit.ts`: a Member's reads are neither counted nor refused, and no `member_read_usage` row is written), the re-run's daily share (`worker/rule-rerun.ts` `isPaused`: a run never pauses for the allowance), and the words that name the Free Plan's day: Import's daily-writes sentences, the D1 usage bar's bars and badges against 5 million and 100,000 (it shows today's figures alone), and the header's "Free allowance left today", which isn't shown.
- **Kept on Paid:** the 50 D1 queries a request, the 47 Accounts a chart draws, Sync's query budget, the CPU-sized caps on Reports and the chunk sizes of Imports and steps. Workers Paid raises those limits too, but every one of them shapes code paths (Sync, charts, Reports), and lifting them is a larger change, with its own decision if it is wanted.
- **The Worker learns the plan in queries it already makes.** `PAID_PLAN` (`worker/settings.ts`) is a subquery on the Settings' primary key, one row read. The Members' limit asks it in the statements it runs on Free (its reservation holds nothing on Paid, and the state it then reads says why), and the re-run carries it on every read of the job. So a request makes no more queries on either plan, and net worth at its 47 Accounts still fits in 50.
- **The switch is the Admin's word, and Fernledger can't check it.** Turned on in a Free account, the caps are gone and the day's allowance can run out, after which Fernledger stops working until 00:00 UTC. The switch's description says so. D1's own "daily limit exceeded" answer is still handled wherever it was.

## What was rejected, so it is not re-litigated

- **Finding out the plan from Cloudflare.** It would need an API token that can read the account's subscriptions, a secret the Deployer must make, and an outbound call ([ADR 0010](0010-outbound-calls.md)) for one fact the Admin already knows.
- **Paid lifting the per-request limits too.** See above: a larger change, kept apart so this one stays small.
- **Higher caps instead of none on Paid.** Paid has no daily allowance to share, so any figure would be made up. Per-use cost on Paid is the Deployer's to watch, in Cloudflare's own billing.

## Consequences

- A Free site is exactly as it was. Every cap is still tested on Free, and on Paid.
- A site that switches to Paid mid-day stops counting from that moment. Switching back starts the day's counts from what was kept before, which may be behind, so a Member may read more than the limit that day.
