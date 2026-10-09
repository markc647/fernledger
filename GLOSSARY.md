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
A Transaction moving money between two tracked Accounts; it is not spending and is excluded from Budgets.
_Avoid_: Internal payment, sweep

## Sources

**Import**:
A load of Transactions from bank-exported files; used for history older than Akahu provides, and as the regular source for Accounts not linked to Akahu.
_Avoid_: Upload, migration

**Bank Time**:
The time of day of a Transaction, shown only when the bank actually supplied one; most Transactions have a date only.
_Avoid_: Timestamp, posted time

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

**Uncategorised**:
What a Transaction is when no Override, Rule or Akahu suggestion gives it a Category in use, so a removed Category counts as none; the Admin has a list of them. Removing a Category takes away its Overrides, and those Transactions fall back to their Rule or Akahu category, or are Uncategorised if neither applies.
_Avoid_: Unassigned, unknown

**Rule**:
An Admin-defined pattern that gives matching Transactions a Category, or marks them as Transfers. It matches on text in the description or bank memo, the bank's transaction type, and the size of the amount. Rules are checked in the order the Admin sets, and the first that matches is used. A Rule's result is stored on each new Transaction as an Import adds it. A Rule outranks Akahu's suggested category but never an Override.
_Avoid_: Filter, mapping

**Override**:
A Category the Admin sets by hand on a single Transaction; it outranks any Rule or Akahu suggestion.
_Avoid_: Manual category, exception

**Note**:
Free text the Admin attaches to a single Transaction.
_Avoid_: Comment, memo

**Budget**:
A planned monthly spending amount for a Category, effective from a given month onward; unspent amounts do not carry over.
_Avoid_: Limit, allowance, envelope

## Accountability

**Change Log**:
The record of every change the Admin makes: who, what and when; visible to all Members.
_Avoid_: Audit trail, history

**Change type**:
The kind of thing a Change Log entry changed, such as Settings, Import, Account, Category, Rule or Transaction; Members can filter the Change Log by it. Not a Category.
_Avoid_: Type, kind

**Report**:
A print-formatted view of Transactions over a date range, which any Member can print or save as PDF.
_Avoid_: Statement, export

## Viewing

**Summary**:
The page every Member lands on: the balance of each Account, the newest Transactions and any Balance Check warnings.
_Avoid_: Dashboard, home page

## Configuration

**Setting**:
A value the Admin chooses in the app, such as the app title or the About your data text; the Admin themselves is not a Setting.
_Avoid_: Preference, option, config

**Setup needed**:
What the Admin is shown for a feature that is switched off until the Deployer adds configuration it requires, with what to add and how; Members see only that the feature isn't set up. For an optional feature such as Akahu Sync, it can be ignored.
_Avoid_: Misconfigured, disabled, error
