# Nothing is parsed out of a description to make a field

A Transaction's fields are the fields Akahu sends, kept as Akahu sent them and shown as they are. Nothing reads the words inside a description to produce a field of its own.

Ticket 43 did the opposite for one field: Kiwibank gives Akahu a date and no time of day, but writes the time of an EFTPOS purchase at the end of its description (`POS W/D Example Store-12:07`), so `worker/kiwibank-time.ts` read that `-HH:MM`, combined it with the Transaction's NZ date and stored it in `bank_time_from_memo`, and the Transaction detail showed it as the Bank Time. Mark withdrew that on 2026-10-23, with the canvas thread that would have hidden the `-HH:MM` from the description: *"You are supposed to be recording the fields as we get them from Akahu and displaying them"*, and *"I don't want to parse the description to try and create a time field for a transaction at this time."*

- **A parsed field is a guess wearing a field's clothes.** `-12:07` at the end of a description is Kiwibank's habit, not a contract: a bank that changes its wording, or a merchant whose name ends that way, turns a reading into a wrong answer, and nothing downstream can tell the difference between a time the bank supplied and one Fernledger inferred.
- **One date, not a date and a time.** Akahu's model carries a single `date` (an ISO 8601 instant). Where the bank supplied a time of day the instant carries it, and `has_bank_time` records that; where it did not, the instant is midnight and the Transaction has no time of day. That is the whole of it.
- **The words are kept whole.** `description` and `bank_memo` hold what Akahu sent, `-12:07` included, on the detail page as in every list, Report and export. A reader who wants the time can read it where the bank wrote it.
- **This is the rule, not an exception.** It holds for any bank and any field: a counterparty, a card number or a reference that appears only inside a description stays there until Akahu sends it as a field of its own.

## Consequences

- `bank_time_from_memo` (migration 4301) is no longer written. Migrations are add-only (ADR 0009), so the column stays in the schema, unread; the handful of rows an earlier Sync wrote it to keep their value and are ignored. `has_bank_time` is still written and shown.
- The Transaction detail's Bank Time is Akahu's own date carrying a time, or "Not sent". For Kiwibank EFTPOS rows that means no Bank Time at all, which is what the bank gave Akahu.
- `worker/kiwibank-time.ts` and its test are gone, and with them the only use of Akahu's connection name in `toRow`. `docs/bank-formats/kiwibank.md` records the `-HH:MM` as a thing the bank writes into its description and that Fernledger leaves alone.
- If a time of day for EFTPOS purchases is wanted later, it is a new ticket and it starts with Akahu: a field Akahu sends, not a reading of a description.
