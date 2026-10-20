# Kiwibank CSV exports

Kiwibank has **two** CSV layouts: one for bank accounts, which the `kiwibank` adapter parses, and one for credit cards, which nothing parses yet. Every value below is made up and uses bank code 99. Never copy a real export into this repo. Kiwibank also offers JSON, OFX, QIF and PDF; Fernledger imports CSV only.

## Bank accounts

There is no header block. Line 1 is the column header and every row carries its own account number and the account's balance after that Transaction. The rows run oldest first.

```text
Account number,Effective Date,Transaction Date,Description,Transaction Code,Particulars,Code,Reference,Other Party Name,Other Party Account Number,Other Party Particulars,Other Party Code,Other Party Reference,Amount,Balance
99-9999-9999999-00,2026-09-01,2026-09-01,TRANSFER TO SAVINGS,TRANSFER,SAVING,MONTHLY,SEP,EXAMPLE SAVINGS,99-9999-9999999-01,FROM EVERYDAY,TFR,SEP,-250.00,1750.00
99-9999-9999999-00,2026-09-02,2026-09-02,EXAMPLE CAFE TOWN,POS,,,,,,,,,-8.20,1741.80
99-9999-9999999-00,2026-09-30,2026-09-30,CREDIT INTEREST,INTEREST,,,,,,,,,0.92,1614.02
```

| Column | Used for |
|---|---|
| Account number | Matching the Account. `BB-bbbb-AAAAAAA-SS`; a three-digit suffix is normalised as everywhere else |
| Effective Date | The Transaction's date |
| Transaction Date | Not used. Equal to the Effective Date in every sample seen |
| Description | `bank_memo`, and the payee when there is no other party |
| Transaction Code | `bank_type` (`POS`, `TRANSFER`, `DIRECT DEBIT`, `INTEREST`, …) |
| Particulars, Code | **Not imported yet**: `ImportRow` has no field for them |
| Reference | `bank_reference`, through `ImportRow`'s `chequeNumber`, which is the column the Worker writes there |
| Other Party Name | The payee, when it is not empty |
| Other Party Account Number | **Not imported yet** |
| Other Party Particulars, Code, Reference | **Not imported yet** |
| Amount | Integer cents; negative is money out |
| Balance | The account's balance after this Transaction. The file's ledger balance is the last row's |

Dates are `YYYY-MM-DD`. Amounts are plain decimals with no thousands separator and no currency symbol.

### Which date

**Effective Date.** The two dates were identical in all 179 rows of the three sample files, so the data does not choose between them. The Effective Date wins because the running balance is ordered by it, and the Balance Check (README: Balance check after every import) depends on the balance and the date agreeing.

### The unique ID Kiwibank does not give

ASB's export numbers every row, and `transactions.bank_unique_id` is what lets an Import recognise rows it already holds, so an overlapping re-import adds nothing twice (ADR 0003). **Kiwibank's export has no such column**, so the adapter makes one:

```text
<Effective Date>:<amount in cents>:<balance in cents>
2026-09-01:-25000:175000
```

Why those three fields:

- **The balance is what makes it unique.** Two Transactions of the same amount on the same day leave the account at different balances, because each one moves it. Within an Account the three together repeat only for a row that is identical in every way that matters, which is a genuine duplicate the bank has issued twice.
- **The description, particulars and payee are left out on purpose.** They would add nothing to uniqueness, and they are what a bank is most likely to re-word between exports. A re-import would then look like new Transactions rather than the ones already held. The three fields used are arithmetic: the bank cannot restate them without its own balance history being wrong.
- **It is a composite, not a hash.** It cannot collide by chance, it needs no hash function for two versions to agree on, and when something goes wrong it can be read.

It follows that a file whose rows are not in the bank's own order, or whose balances have been edited, produces different IDs and therefore duplicates. The adapter does not re-sort rows: a file that is not as the bank wrote it is not one to trust.

### What is not imported yet

Kiwibank gives the payment's Particulars and Code and the other party's account number, particulars and code. The database has columns for the first three (`bank_particulars`, `bank_payment_code`, `bank_counterparty_account`, added in migration 1201) but `ImportRow` has no fields for them, because ASB's export has none of them and Import has never needed to carry them. Until `ImportRow` is extended, a Kiwibank import drops those columns.

## Credit cards

A different layout: four columns, no account number, no balance.

```text
Date,Description,Card,Amount
2026-09-02,EXAMPLE CAFE TOWN,9999,-8.20
```

| Column | Notes |
|---|---|
| Date | `YYYY-MM-DD` |
| Description | The only text the export gives |
| Card | The last four digits of the card used |
| Amount | Integer cents; negative is money out |

**No adapter parses this yet, and one cannot be written against the current contract.** `BankCsvResult` requires an `accountNumber` and a `ledgerBalance`, and this export has neither:

- **Nothing identifies the account.** The card number is not it: a card is reissued on fraud or expiry, and one sample file held three card numbers for one account over two years, so an Account keyed on a card number would split in two at the next reissue. The `Card` column belongs in `bank_card_suffix`, per Transaction, which is where it says which card was used — including across a reissue.
- **There is no balance**, so the Balance Check cannot run for a credit card Account imported from CSV.

Both need the decision about what identifies an Account when the bank prints no durable number. Until that is made, a credit card's Transactions can only reach Fernledger through Akahu Sync, which has a stable account ID of its own.
