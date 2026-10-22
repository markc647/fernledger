# Akahu's balance is a bank balance, recorded after each finished Sync

After a Sync of an Account finishes, Fernledger records the balance Akahu reports for it as a bank balance (`balance_checks`, source `sync`) and runs the Balance Check on it as it does for a file's balance (ADR 0011). The rules are `syncBalance` in `worker/balance-rules.ts`; Sync does the recording (`worker/sync.ts`).

A file's balance is a figure as at a date, with its Transactions in the file. Akahu's `balance.current` is a figure as at an instant (`refreshed.balance`), and a finished Sync holds the Transactions Akahu had read by `refreshed.transactions`. The two agree only if Akahu read them at the same moment, so:

- **Recorded only when the Sync finished and both refreshed times are the same moment.** If they differ, either side could hold a Transaction the other lacks, and the Balance Check would report that gap as a missing or duplicated Transaction. A balance Akahu did not send, or in a currency other than NZD, is not recorded either. No balance is better than one that cannot be compared honestly; the next Sync tries again. An Account whose two times never match never gets one; the log says `sync.balance.refreshed-apart`.
- **Dated the NZ day Akahu read the bank,** not the day of the Sync, so a second Sync of the same reading adds no row. Transactions dated that day and saved by the Sync count in it (`through_transaction_id`), as for a file.
- **The Cutover Date does not uncount it.** A file's balance dated on or after the Cutover Date is set aside because those days belong to Sync (ADR 0003), and this balance is what covers them. It is counted and anchors the Account's balance and history, and the Summary's As of date moves to the day Akahu read the bank. A file's balance already set aside stays set aside.
- **One a day, all kept.** The date is the key, so a second reading on the same NZ day replaces the first. Each balance is compared with the one before it, so a difference is dated to the day it appeared, and the Balances over time Report reads every stored result. Dropping old ones would lose that: the oldest left would become `alone`, and differences that offset across the gap would vanish.
- **A failed check does not fail the Sync.** The Account's Transactions and mark are committed first; the check is logged and runs again at the next Sync.

## Consequences

- An Account costs 11 D1 queries at most, not 8 (the balance statement joins the batch; the check is one read and one write, outside the batch as an Import's is). A run takes four linked Accounts, not five; a fifth waits for the next run, which takes the least recently synced first (ADR 0004). Overlapping Syncs (ADR 0013) record the same balance and give the same check result.
- "Bank balance" (GLOSSARY.md) is the latest of either source; `balance_checks.source` says which.
- A balance row a day grows the table by about 365 rows a year for each linked Account.
