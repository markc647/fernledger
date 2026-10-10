# Fernledger

A self-hosted tracker for NZ bank accounts, synced via Akahu, that one Admin manages and a small group of Members can view. A common use is a family overseeing an elderly parent's finances.

## People

**Admin**:
The one Member who can change Categories, Rules, Budgets, Overrides and Notes, and who owns the Akahu connection.
_Avoid_: Super user, owner, editor

**Member**:
A person granted access to the dashboard; read-only unless they are the Admin.
_Avoid_: User, viewer, household

**Deployer**:
The person who deploys and operates a Fernledger instance in their own Cloudflare account; responsible for its data, upgrades and backups. Often, but not always, the Admin.
_Avoid_: Host, operator, owner

## Money

**Account**:
A bank account being tracked.
_Avoid_: Bank account, wallet

**Transaction**:
A settled movement of money in or out of an Account.
_Avoid_: Record, entry, line

**Pending Transaction**:
A Transaction the bank has reported but not yet settled; it may still change or disappear.
_Avoid_: Unsettled, provisional

**Transfer**:
A Transaction moving money between two tracked Accounts, found as one of a pair in different Accounts or marked by a Rule; it is not spending and is excluded from Budgets. The other Transaction of a pair is its matching Transaction. How pairs are found is in README [How it works](README.md#how-it-works).
_Avoid_: Internal payment, sweep, other half

## Sources

**Import**:
A load of Transactions from bank-exported files; used for history older than Akahu provides, and as the regular source for Accounts not linked to Akahu.
_Avoid_: Upload, migration

**Bank Time**:
The time of day of a Transaction, shown only when the bank actually supplied one; most Transactions have a date only.
_Avoid_: Timestamp, posted time

**First-seen time**:
When Akahu first reported a Transaction to Sync, shown in its details as "First seen by Akahu". Only Transactions that come through Sync have one: an Import's details say Akahu hasn't reported it. Not Bank Time, which is the time of day the bank supplied, and not the Transaction's date.
_Avoid_: Created time, import time

**Sync**:
The daily pull of new Transactions and Pending Transactions from Akahu.
_Avoid_: Refresh, update, fetch

**Account Link**:
The association between an Account and its account in Akahu; it can break when a bank reconnects or migrates, and is then re-linked by the Admin.
_Avoid_: Mapping, connection

**Balance Check**:
The comparison, after each Import, between an Account's balance as reported by the bank and the balance calculated from its Transactions; it will also run after each Sync.
The rules are in README [Correct](README.md#correct).
_Avoid_: Reconciliation, audit

**Cutover Date**:
For an Account linked to Akahu, the date before which Transactions come only from Imports and on or after which they come only from Sync.
Today any Account can have one; limiting it to linked Accounts will ship with the Account Link ticket, because no link exists yet to check (ADR 0008).
_Avoid_: Switchover, boundary

## Organising

**Category**:
A label grouping Transactions by purpose, such as Groceries or Care Fees.
_Avoid_: Tag, type, bucket

**Category kind**:
What a Category is for, which the Admin sets: Spending, Income or Loans. It decides how the Category's Transactions are totalled; the rules are in [ADR 0012](docs/adr/0012-spending-and-category-kinds.md).
_Avoid_: Type (that is Change type), group

**Spending**:
What the Spending Categories took out of the Accounts in a month, less what came back, such as a refund; Uncategorised counts as Spending. Transfers, Pending Transactions and Loans are not Spending. See [ADR 0012](docs/adr/0012-spending-and-category-kinds.md).
_Avoid_: Expenses, outgoings

**Income**:
What the Income Categories brought into the Accounts in a month, less what went out of them. See [ADR 0012](docs/adr/0012-spending-and-category-kinds.md).
_Avoid_: Earnings

**Loans**:
The Category kind for money lent or borrowed, such as a loan between family: neither Spending nor Income, and left out of Budgets. The Loans Report lists them. See [ADR 0012](docs/adr/0012-spending-and-category-kinds.md).
_Avoid_: Debt

**Uncategorised**:
What a Transaction is when no Override, Rule or Akahu suggestion gives it a Category in use, so a removed Category counts as none; the Admin has a list of them. A Transfer is not Uncategorised and is left off that list. Removing a Category takes away its Overrides, and those Transactions fall back to their Rule or Akahu category, or are Uncategorised if neither applies.
_Avoid_: Unassigned, unknown

**Rule**:
An Admin-defined pattern that gives matching Transactions a Category, or marks them as Transfers. How Rules match and take precedence is in README [How it works](README.md#how-it-works).
_Avoid_: Filter, mapping

**Re-run**:
Applying the Rules as they are now to every Transaction already on file, in steps that keep their place, so a Rule change reaches the past as well as new Imports. It gives each Transaction the result of the first Rule that matches, or none, and never touches an Override or a Note. The Rules page's button for it says "Apply the Rules to all Transactions", which is the same thing in the words an Admin would use. How it runs is in README [How it works](README.md#how-it-works).
_Avoid_: Reapply, backfill, refresh

**Override**:
A Category the Admin sets by hand on a single Transaction; it outranks any Rule or Akahu suggestion.
_Avoid_: Manual category, exception

**Note**:
Free text the Admin attaches to a single Transaction.
_Avoid_: Comment, memo

**Carry over (Overrides and Notes)**:
What replacing an Account's imported history does with the Admin's Overrides and Notes: each goes to the re-imported Transaction with the same bank unique ID (the bank's own number for it; ASB makes it from the date and a count for the day). One with no match is lost; one that went to a Transaction with a different amount is counted, since the bank may have numbered that day differently. An Import that stops part way leaves them held until a replace completes or the Admin discards them. Not the Budget sense of the words: unspent Budget amounts do not carry over from month to month.
_Avoid_: Migrate, restore, reapply

**Budget**:
A planned monthly Spending amount for a Spending Category, effective from a given month onward; unspent amounts do not carry over. Budget vs actual compares it each month with what the Category spent.
_Avoid_: Limit, allowance, envelope

## Accountability

**Change Log**:
The record of every change the Admin makes: who, what and when; visible to all Members.
_Avoid_: Audit trail, history

**Change type**:
The kind of thing a Change Log entry changed, such as Settings, Import, Account, Category, Rule, Budget or Transaction; Members can filter the Change Log by it. Not a Category.
_Avoid_: Type, kind

**Report**:
A print-formatted view of Transactions over a date range, which any Member can print or save as PDF.
_Avoid_: Statement, export

**CSV export**:
A spreadsheet file of the Transactions that match the Transactions page's filters.
_Avoid_: Report

## Viewing

**Summary**:
The page every Member lands on: the balance of each Account, Budget vs actual for this month, the newest Transactions and any Balance Check warnings.
_Avoid_: Dashboard, home page

## Configuration

**Setting**:
A value the Admin chooses in the app, such as the app title or the About your data text; the Admin themselves is not a Setting.
_Avoid_: Preference, option, config

**Setup needed**:
What the Admin is shown for a feature that is switched off until the Deployer adds configuration it requires, with what to add and how; Members see only that the feature isn't set up. For an optional feature such as Akahu Sync, it can be ignored.
_Avoid_: Misconfigured, disabled, error
