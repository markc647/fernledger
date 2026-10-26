# Kiwibank CSV exports

Kiwibank has **two** CSV layouts: one for bank accounts, which the `kiwibank` adapter parses, and one for credit cards, which the `kiwibank-card` adapter parses. Every value below is made up and uses bank code 99. Never copy a real export into this repo. Kiwibank also offers JSON, OFX, QIF and PDF; Fernledger imports CSV only.

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
| Particulars, Code | `bank_particulars` and `bank_payment_code` |
| Reference | `bank_reference`, through `ImportRow`'s `chequeNumber`, which is the column the Worker writes there |
| Other Party Name | The payee, when it is not empty |
| Other Party Account Number | `bank_counterparty_account` |
| Other Party Particulars, Code, Reference | Not kept: what the other party wrote on their side of the payment, which Fernledger has no column for |
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

### The payment details

Kiwibank prints the payment's Particulars and Code and the other party's account number. The database has had columns for them since migration 1201, where they were added for Akahu Sync to fill, because ASB's export has none of them. `ImportRow` carries them as optional fields, so an Import fills them too: an adapter with nothing to put in one leaves it out and the column stays NULL, exactly as ASB's rows always have.

The other party's own Particulars, Code and Reference are read and discarded. They are what the other party wrote on their side of the payment, and Fernledger has no column for them.

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

The `kiwibank-card` adapter parses it (`src/lib/bank-csv/kiwibank-card.ts`). It has neither of the two things every other export gives, and [ADR 0017](../adr/0017-account-number-is-the-accounts-key.md) is what made it writable:

- **Nothing identifies the account.** The card number is not it: a card is reissued on fraud or expiry, and one sample file held three card numbers for one account over two years, so an Account keyed on a card number would split in two at the next reissue. So the file carries no `accountNumber` at all, and the Import asks the Admin which Account it is for. The `Card` column goes to `bank_card_suffix`, per Transaction, which is where it says which card was used — including across a reissue.
- **There is no balance**, so the file states no ledger balance and such an Account gets no Balance Check from a CSV. Through Akahu it is checked from Akahu's own balance like any other ([ADR 0014](../adr/0014-akahu-balance-is-a-bank-balance.md)).

### The unique ID, without a balance to use

The bank-account adapter's `<date>:<cents>:<balance>` cannot be used here, because there is no balance column. This adapter uses the date, the amount in cents, the card, and **which occurrence of those three the row is in the file**:

```text
<Date>:<amount in cents>:<Card>:<occurrence>
2026-09-02:-820:9999:1
```

The first three are what the bank cannot restate without being wrong about the money. The occurrence separates a day's identical purchases, which a card really does have — two $4.50 coffees at the same shop — so both survive instead of one being taken for a duplicate of the other, and a re-import of an overlapping range still adds nothing twice. A later export that has gained a row of some other amount does not shift them, because only rows sharing all three are counted. As in the bank-account adapter, the description is left out: it is the part a bank is most likely to re-word between exports.

It follows that a file whose rows are not in the bank's own order produces different IDs for a day's identical purchases, and therefore duplicates of them. The adapter does not re-sort rows, for the same reason as the other one: a file that is not as the bank wrote it is not one to trust.

The export prints no transaction type, so `bank_type` holds `''` for these rows, as it does for any row a bank gives none for.

## The EFTPOS time in Akahu's description

Not part of either CSV. Through Akahu, Kiwibank's `date` is a date only, but the description of an EFTPOS purchase ends in the time it was made, such as `POS W/D Example Store-12:07`. Fernledger does not read it: the description and the bank memo are kept exactly as the bank wrote them, the time stays in those words, and a Transaction gets a Bank Time only where Akahu's own `date` carries a time of day. Mark decided this on 2026-10-23, having first had the time read out (ticket 43): what Akahu sends is recorded and shown, and nothing is parsed out of a description to make a field.
