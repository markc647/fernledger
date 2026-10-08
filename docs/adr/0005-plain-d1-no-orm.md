# Plain D1 and SQL migrations, no ORM

We query D1 directly with prepared statements and `batch()`, and manage the schema with plain `.sql` files applied by `wrangler d1 migrations`. Most of the app's queries are reports: spending by Category, budget vs actual with effective-from months, running balances, and Rules applied across years of history. Those are grouped and windowed SQL that an ORM such as Drizzle would end up wrapping in raw `sql` strings anyway. On the Workers Free plan (ADR 0004) we also need tight control of per-invocation query counts and batched writes, which D1's own API gives directly.

## Consequences

- Query results are typed with small hand-written row types, one per table, kept next to the queries. Business logic stays in pure, tested functions.
- Revisit if the app grows many simple CRUD screens and keeping the hand-written types in sync starts to hurt. Drizzle works on D1 and could be adopted gradually.
