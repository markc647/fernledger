# Pending Transactions live in their own table, replaced whole on every Sync

Pending Transactions are kept in `pending_transactions` (migration 2901), not as a flag on `transactions`. Every Sync asks Akahu once for the pending money of all its accounts (`GET /v1/transactions/pending`) and replaces what the linked Accounts hold with the answer (`worker/pending.ts`; Sync does the replacing, `worker/sync.ts`).

Pending money is what a bank is showing at the moment of asking: it may change, settle under a different amount, or disappear. Akahu's pending model carries no `_id` and no content hash, so there is no key to match one against between Syncs, and nothing to update even if there were.

- **A table of its own, so no total can count it.** Budgets, every Report, the Balance Check, the Uncategorised list, Rules, Transfers and the CSV export all read `transactions`, and none of them reads this table. Leaving pending money out is then not a rule each of them has to apply and could forget, but what the schema means. A `pending` flag on `transactions` would have put a `WHERE pending = 0` in every one of those queries, and the first one missed would be a wrong figure in a Report that nobody would notice.
- **Replaced whole, for the whole run, not merged per Account.** One call covers every account the user token can see, so one delete and one insert serve a run of any size (three D1 queries for the run, ADR 0004). Nothing is matched or updated: what the bank is showing now is the whole truth about pending money.
- **Pending Transactions are not Transactions.** They have no Category, no Override, no Note, no Transfer pairing and no detail page; they cannot be searched, filtered or sorted. They are listed above the Transactions table with the time of the Sync that read them. A row that settles arrives as an ordinary Synced Transaction in the same Sync, with Akahu's ID, and the Rules then apply to it as they do to any other.
- **A call that fails keeps what was held.** Deleting pending money because Akahu was unreachable for a minute is worse than showing money that may have settled: the list says when it was read, and the next Sync replaces it. Nothing about pending money can fail a Sync.
- **No history.** Yesterday's pending rows are not kept. Pending money is a view of the present, and the settled Transaction is the record.

## Consequences

- Unlinking or re-linking an Account deletes its pending rows in the same batch as the link itself (`worker/accounts.ts`): they came from the old link, and a Sync only ever replaces the rows of Accounts that are linked, so rows left behind would be shown for good. The list also reads only Accounts that are still linked, so a row that somehow outlives its link is not shown.
- Nothing in the app can give a Pending Transaction a Category or a Note, and no Report will ever list one. If that is wanted, it is a new ticket, and it means moving them into `transactions` behind a flag, with the `WHERE` clause in every query above.
- A backup holds the pending rows like any other table, and a restore brings back the pending money as at the backup. The next Sync replaces it.
- The Transactions page makes one more read, which returns a handful of rows and is not paged.
