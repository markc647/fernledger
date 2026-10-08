# Custom build on Cloudflare Workers + D1, not a fork of Actual or Sure

We build our own app on Workers + D1 instead of forking an existing self-hosted finance app. Every candidate failed a hard requirement. Actual Budget has no read-only role and no print reports. Its server needs a persistent disk, and its bank sync only runs while a client is open. Sure has the closest feature set (Akahu, guest role, budgets), but it needs Postgres, Redis and a background worker. On Cloudflare that means an always-on Container plus external paid services, and its read-only enforcement and PDF reports are incomplete. Firefly III and ezBookkeeping can't share data with read-only users.

## Considered Options

- **Actual Budget, unmodified or forked.** Rejected: no read-only role, local-first CRDT sync is costly to add permissions to, and its disk-based server doesn't fit Workers.
- **Sure on a Container or VPS.** Rejected: too many moving parts for one household, and the two hardest requirements (read-only, Reports) would still need fixing.

## Consequences

- Sure's domain model (accounts, budgets, rules, guest role) may inform the design, but none of its code may be copied: it is AGPL, and we intend an open-source release under a licence of our choosing.
- corrin/akahu_to_budget is GPL-3.0, so it's for reading only. scottmckendry/akahu-actual is MIT and may be borrowed from with attribution.
