# Fernledger

**A private, self-hosted tracker for New Zealand bank accounts.** It will sync daily from your bank through [Akahu](https://www.akahu.nz) (until then you import your bank's CSV files), and runs on your own Cloudflare account, on the free plan. One person manages it, and a small group of family members can view it read-only.

> **Status: early development.** The design is settled and the code is being built. Nothing here is ready for real data yet. This README records each decision as it is made, so you can judge whether Fernledger suits you before you use it.

---

## Contents

- [Who it's for](#who-its-for)
- [What it does](#what-it-does)
- [What it doesn't do](#what-it-doesnt-do)
- [What you need](#what-you-need)
- [What it costs](#what-it-costs)
- [How it works](#how-it-works)
- [Reports](#reports)
- [Security and privacy](#security-and-privacy)
- [Where your data is stored](#where-your-data-is-stored)
- [Reliability](#reliability)
- [Accessibility](#accessibility)
- [Getting your history in](#getting-your-history-in)
- [Setting it up](#setting-it-up)
- [Updating](#updating)
- [Technology choices](#technology-choices)
- [Project status and roadmap](#project-status-and-roadmap)
- [Contributing](#contributing)
- [Licence and disclaimer](#licence-and-disclaimer)

---

## Who it's for

- **Families overseeing someone else's money.** This is the case Fernledger was built for: an elderly parent's accounts, managed by an attorney under Enduring Power of Attorney, with siblings able to see everything but change nothing. Every change is logged, and printable reports support the attorney's record-keeping.
- **Households** who want one shared, private view of their accounts.
- **Individuals** who want their own finance dashboard without handing bank data to a third-party app.

Fernledger is **one family per deployment**. You run your own copy, nobody else's data is in it, and the project's authors never see yours.

## What it does

- **Daily sync** will bring in transactions from your NZ bank accounts through Akahu, including **pending transactions**, which will be shown as pending until they settle.
- **Imports your bank's CSV exports:** years of history older than Akahu can provide, or as your regular source if you'd rather not use Akahu at all. Fernledger works without Akahu: you import a CSV each month instead of syncing.
- **Bank Time:** a transaction's time of day is shown only when the bank actually supplied one, which is rare, because most banks give a date only. Fernledger never invents a time. Once Akahu Sync ships it will also record when Akahu first saw each transaction, and a transaction's details will show it. A transaction from a bank file has none.
- **Full transaction detail for record-keeping:** open any transaction to see its note and category and everything the bank supplied about it. That way you can show exactly where money went. ASB's CSV export carries none of the payment details but a cheque number, so the counterparty's account number, card suffix, and payment particulars, code and reference will come with Akahu Sync, which is planned.
- **Search and filter:** the Transactions page finds any transaction by text (in the description, the bank's memo, the note, or the payment details the bank gave: cheque number or reference, counterparty account, particulars, code and card), account, category (or Uncategorised), transfers (all, only transfers, or leaving them out) and date range, sorts by date, account, description, category or amount, and pages through years of history. The search is kept in the page's address, so it survives a reload and the Back button.
- **Your own categories**, from a starter list the Admin can add to, rename and remove. The Admin can override any single transaction's category and add a note, and a list of uncategorised transactions shows what's left. **Rules** categorise automatically: the Admin sets text to look for in the description or memo, a bank transaction type and an amount range, chooses a category (or marks the transaction as a transfer), puts the rules in order, and sees how many transactions a rule matches before saving it. Rules are used for new transactions as they're imported, and one button, "Apply the Rules to all Transactions", brings the transactions you already have into line with them.
- **Transfers between your own accounts** are detected and left out of spending: money out of one account and the same amount in to another on the same day are paired as a transfer, and the Transactions page says where it went or came from. A payment to an account Fernledger doesn't track still counts as spending. If two unrelated transactions were paired by coincidence, the Admin chooses "Not a Transfer" on either one and both go back to being spending.
- **Monthly budgets** per category. Unspent amounts don't carry over, and changing a budget doesn't rewrite past months.
- **A Summary for every Member:** the balance of each account, the newest transactions and any balance warnings, on the page Members land on.
- **Dashboard:** balances, net worth over time, spending by category, budget vs actual.
- **Printable reports:** the full transaction listing, with each transaction's category and note, for any date range, laid out for paper: print it or save it as a PDF from your browser ([how Reports work](#reports)). Spending by category, budget vs actual, income vs spending by month and balances over time will join it.
- **CSV export** for any date range: the Transactions page's **Download CSV** button saves the Transactions that match the filters you last searched with (text, account, category, dates), oldest first, to open in a spreadsheet.
  - **Columns:** date, account, description, category, note, amount, and everything the bank supplied: its type, memo, reference, counterparty account, particulars, code and card suffix. A bank file has no counterparty account, particulars, code or card, so those columns are empty until Akahu Sync fills them, and the layout stays the same. An amount is dollars as a plain number, with a minus sign for money out, so a spreadsheet can add it up. A transaction with no category says "Uncategorised".
  - **Totals:** Money in, Money out, Net and the number of Transactions come after a blank line, in the second column and not the Amount column, so adding up the Amount column gives the Net. An export of all accounts counts both legs of a transfer between your own accounts in Money in and Money out until transfers ship; the Net is the same.
  - **Formulas are defused with an apostrophe:** a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return would run as a formula in a spreadsheet, so it gets an apostrophe in front. Amounts are numbers we write ourselves and are never changed.
  - **Opens correctly in Excel:** the file starts with a UTF-8 byte order mark, so macrons (Whāngārei) show properly. A program that reads the file as plain UTF-8 will see an invisible character before the first heading; Python's `utf-8-sig` drops it.
  - **Up to 5,000 Transactions a file** (fewer if Notes are long), because a file stops at about 0.75 MB of text and the free plan gives a request 10 ms of CPU ([ADR 0004](docs/adr/0004-runs-on-workers-free-plan.md)). A file can overshoot that by up to one chunk (about 0.25 MB), so about 1 MB at most. The Transactions page says how many match before you download, and the file says so when more matched. Export a year at a time to get a longer history. Both limits are estimates from timings, not measurements of CPU: if a request ever fails for CPU, lower the 5,000-row limit, the 0.75 MB limit or both.
- **Change Log** of every edit the Admin makes, visible to everyone: who changed what and when, with the values before and after, newest first. Filter it by type of change and by date.
- **Light and dark themes.**
- **Your own title:** for example "Mum's finances", which the Admin sets on the Settings screen. The header shows it, and so does the top of every report.
- **Add to Home Screen:** opens like an app on an iPad or phone, with its own icon. There's no offline mode and no push notifications. The icon's label comes from a fixed file, so it is normally "Fernledger" whatever title the Admin sets, though some iOS versions use the page title instead. You can rename it when you add it.

## What it doesn't do

These are deliberate choices. Each is recorded as an [architecture decision](docs/adr/):

- **It can't move money.** Akahu personal apps are read-only, with no payments.
- **No shared hosting.** There's no "Fernledger cloud". You host it yourself (ADR 0006).
- **NZD and NZ banks only.** It's NZ English only, too (ADR 0006).
- **No emails, no analytics, no telemetry.** The app contacts no one but Akahu (only if you use Sync) and, to check a sign-in, your own Cloudflare Access (ADR 0010). A test fails if any other outbound call appears.
- **No native mobile app.** The web app works in a phone browser.
- **No investment tracking or manually entered assets** in v1.

## What you need

| | Why |
|---|---|
| A **Cloudflare account** (free) | Hosts the app, database, backups and sign-in. We recommend a new account just for Fernledger (see [Security](#security-and-privacy)). |
| Optional: an **Akahu account** with a free **personal app** | Daily automatic sync. You create it at [my.akahu.nz](https://my.akahu.nz). Personal apps can connect only the accounts *you* can log in to. **We're confirming with Akahu that ongoing personal use is allowed under their terms** (see [docs/privacy.md](docs/privacy.md#akahus-developer-terms)). Without Akahu, use monthly CSV imports. |
| A **GitHub account** | Only if you use the Deploy button or want automatic updates. |
| Optional: your bank's **CSV exports** | For history older than Akahu provides. |

**If you manage someone else's accounts:** connect Akahu using *your own* bank login, the one your bank gave you as attorney or authorised third party. Never use the account holder's own password: that usually breaches your bank's terms, even with Power of Attorney.

## What it costs

**Nothing, for a typical household.** Fernledger is designed to run within Cloudflare's **Workers Free plan** (ADR 0004):

| Service | Free allowance | Fernledger's typical use |
|---|---|---|
| Workers | 100,000 requests/day | A few hundred |
| D1 database | 500 MB per database, 100k row writes/day | Years of transactions in a few MB |
| R2 (backups) | 10 GB | Weekly backups of a few MB each |
| Cloudflare Access | Free for up to 50 users | 1–6 people |
| Akahu personal app | Free | One app |

R2 may ask for a payment method on file even within the free allowance (unconfirmed). Fernledger has no paid tier and never will.

## How it works

```
 Your family's browsers
        │  sign in with an email code (or Google/Microsoft)
        ▼
 Cloudflare Access ── blocks anyone not on your list
        │  signed identity token
        ▼
 Fernledger Worker ── checks the token on every request
        │                  └─ once Sync ships, daily: pulls new transactions from Akahu
        ▼
 D1 database (your account, Oceania) ── weekly backup ──▶ R2 bucket
```

- **Admin and Members.** One Admin, set by email, can edit categories, rules, budgets, overrides and notes. Everyone else is a read-only Member who can view, print and export.
- **Sync** will run once a day, after Akahu's own daily refresh. A banner will show when data was last synced and turn red after 2 days, for example when a bank connection needs reconnecting.
- **Import and Sync never overlap.** Each account has a Cutover Date: imported CSV rows cover the period before it, and Akahu will cover it onwards. Nothing is guessed or fuzzy-matched across the two sources (ADR 0003). The Admin sets it in Settings, or takes up the offer of the last date in the file when importing (nothing is set unless the Admin ticks it); an Import then skips rows dated on or after it and says how many. Until accounts can be linked to Akahu, any account can have one; limiting it to linked accounts will ship with that feature.
- **A bad import can be replaced.** On the Import screen, "Replace imported history" removes an account's imported Transactions, never the ones from Sync, and imports the new file in their place, after the Admin confirms and is told how many will go. The Change Log records it. Overrides and Notes the Admin set on the removed Transactions are carried over to the Transactions that come back with the same number from the bank (ASB makes it from the date and a count for that day). Before the Admin confirms, Fernledger forecasts how many carry over and how many won't. Afterwards the finished screen and the Change Log say how many were carried over, list the first Transactions that lost theirs so they can be set again by hand, and say how many went to a Transaction with a different amount. That last count is the check on the match: if the bank has numbered a day differently since the old export, an Override or Note can land on a different Transaction. While an Import runs Fernledger holds the Overrides and Notes of the removed Transactions. If an Import stops part way they stay held: a plain Import of that account gives them to matching Transactions and leaves the rest waiting, and the Import screen says how many are waiting and lets the Admin discard them. Only a replace that completes clears them, and those with no match are then lost. A history of more than 5,000 imported rows is removed in final steps of 5,000. A row removed and its replacement imported cost 6 of the free plan's 100,000 database writes a day, or 9 if a rule gives the row a category (the rule's result and its entry in the category index are written on import and taken out again on removal), each Override or Note carried over up to 7 more, and each transfer more again (4 more to import, because both halves are written, and 3 more to remove, because its own entry in the transfer index goes and its matching transaction is let go). So one day covers about 16,000 rows replaced when few of them have a rule, anything to carry over or are transfers, about 7,000 when every one is a transfer, and about 4,000 when every one is a transfer with a rule's category and something to carry over. Beyond that Fernledger stops with "Daily limit reached" and says part of the old history has been removed; choose the same file again the next day to finish.
- **Category precedence:** a hand-set override beats a rule, which beats Akahu's suggestion. A rule never replaces an override.
- **Rules:** the first rule in the Admin's order that matches a transaction wins, and a rule whose category has been removed is skipped. Text matching looks in the description and the bank's memo and ignores capital letters A to Z; a letter with an accent or macron, such as Ā, has to match as typed. A transaction type matches in full (EFTPOS, not part of it). An amount range is on the size of the amount, so $50 covers $50 in and $50 out; the rule can also be limited to money in or money out. Saving, changing, reordering or removing a rule changes no stored transaction by itself: a rule's result is stored with each new transaction as an Import adds it, in the same step, and the Admin applies the rules to the transactions already on file with a button (next item). A rule can mark transfers instead of choosing a category, and applying the rules sets or clears that mark on the transactions already on file too.
- **Applying the rules to everything on file:** the Rules page has one button, "Apply the Rules to all Transactions", which gives every transaction the result of the rules as they are now: the category of the first rule that matches it, and none for a transaction that no rule matches any more. An override and a note are never touched. The free plan's 10 ms of processing and 50 database queries a request allow only a slice at a time, so Fernledger goes through the transactions in order, a step at a time (up to 1,000, fewer when there are many rules, so that a step reads about 25,000 rows), and keeps its place in the database. While the page is open it asks for the next step as soon as one finishes and shows how far it has got ("Looked at 4,000 of up to 20,000 Transactions (20%)"), about how many steps are left, and a Stop button; the Change Log records when a run starts, stops and finishes, with the counts. If the page is closed, the two daily crons already there carry the run on slowly (three steps each, one when they are also carrying a backup on), and opening the page again speeds it up from where it stopped. Only one run goes at a time. If a rule is added, changed, moved or removed (or a rule's category is removed) while one runs, it starts again from the first transaction, so that nothing keeps the old rules' result; the rule form says so before you save. Only a transaction whose result changes is written, because writes are the scarcer allowance: 1 write for a transfer mark, 2 for a category (the transaction and its entry in the category index), and the run budgets 3 in case the database bills a category that changes to another as a delete and an insert. A step reads about (the number of rules + 10) rows for each of its transactions. The run keeps to its own share of the free plan's day, 2.5 million rows read and 40,000 written, counted from what the database reports for each step on the plan's day (it changes at 00:00 UTC, around midday NZ time), and pauses until the day changes when the next step would pass it, so the family's use of the app, an Import and the backup keep the rest. 100,000 transactions and 30 rules read about 4 million rows, so that takes two days. The page says when the run is paused and that it carries on by itself after the day changes.
- **Transfers:** as an import adds transactions, Fernledger looks in your other accounts for one with the same date and the same amount the other way: money out of one account and the same money in to another. Each pair is a transfer, so moving money between your own accounts isn't counted as spending, and the Transactions page names the other account ("Transfer to Savings") and links to the matching transaction. The Import screen says how many pairs it matched. Only the date and amount decide: the bank's description isn't looked at, and two transactions in the same account never pair. Pairs are one to one, so three identical round-ups out on one day and three in make three transfers, and three out with only two in leave one unpaired until its matching transaction is imported. A payment to an account Fernledger doesn't track has nothing to pair with, so it counts as spending, whatever it's for. A rule that marks transfers makes a transaction a transfer even without a pair: if the banks date the two halves of a transfer on different days, write a rule that marks them as a transfer. If a pairing is wrong, or a rule marks something that isn't a transfer, the Admin chooses "Not a Transfer" on the transaction's page or in its edit panel, after a question that names the matching transaction. Both halves are unpaired in one step and count as spending, and Fernledger doesn't pair either of them again when a later import brings a new match (Sync will do the same). A rule that marks transfers stops applying to them too. "Undo: treat as a Transfer again" takes the mark off both and pairs them again if they still match, or pairs each with whatever matches now; the Change Log records both. The mark belongs to the transactions it was made on: replacing an account's imported history removes the mark with them (unlike overrides and notes, it isn't carried over), so a wrong pair can match again if both accounts' histories are replaced. The Admin can also count one half of a transfer as spending by setting a category on it (an override): the override outranks the pairing and the rule, but only on that one transaction, and its matching transaction stays a transfer, so "Not a Transfer" is the way to undo a pair. A transfer shows no category, whatever a rule would have given it. Transfers still count in balances, because the money did move, and the Uncategorised list leaves them out; budgets and reports will leave them out of their totals too. Replacing an account's imported history lets go of the transfers that history held and pairs the new rows with their matching transactions again.

## Reports

A report is a page laid out for paper. It opens in a new window from the Reports page, or from the Transactions page, which carries the account and dates you were looking at. Print it or save it as a PDF from your browser. Nothing is made on the server, and every Member can open every report.

- **Transaction listing.** Every transaction in the dates you choose, account by account (each with its bank number) and oldest first, with its category, its note and the amount in or out. Under each description is what the bank said about the payment, with what is missing left out: the cheque number or reference, the counterparty's account, the card, the particulars and the code. Each account has its totals, and so do all of them together. It is the record to hand to the family, a lawyer or the court. The other four reports will use the same layout. Transfers between your own accounts are listed like any other transaction; once Transfers ship, the money in and money out of all accounts together will mark them.
- **Every report says what it is, on every page.** The top of the first page has the app title, the report's name, the account and the dates, and "Generated Thu 8 Oct 2026 at 3:42 pm by" the email of the person who opened it. Each table's heading repeats those lines at the top of every page it runs onto, in every browser, so a loose page still says what it is and who made it. The page title is the same words, so "Save as PDF" names the file after them. Text is black on white and at least 12pt, and a row is never split across two pages.
- **Page numbers depend on the browser.** Chrome and Edge (version 131 and later) number each page "Page 2 of 5" in the page margin, using CSS "margin boxes". Firefox and Safari don't draw margin boxes, so they print the report without those numbers. They can number the pages in the browser's own header and footer if that is turned on in the print window, and the report says so on screen. Everything else on this list is the same in every browser.
- **A report lists at most 10,000 transactions.** It reads them 200 at a time, the largest page the Transactions page uses, so no single request is large (ADR 0004), and it stops at 10,000 across all accounts, which is about 27 a day for a year. The form says so before you open a report. If a range has more, the report says so at the top and again before the end, marks the account where it stopped as partly listed and every account after it as not listed (never as having nothing in the dates), and its totals count only what it lists. Choose a shorter range, or one account, to see the rest.

## Security and privacy

We're as clear about the limits as about the protections. The full threat model is in [docs/security.md](docs/security.md).

### What protects your data

- **It lives in your own Cloudflare account.** There's no Fernledger server. The authors can't see your data, lose it, or be breached for it.
- **No passwords in the app.** Sign-in is handled by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) with email one-time codes, or Google/Microsoft with MFA. The app checks Access's signed token (signature, issuer, audience) on **every** request. If configuration is missing, it refuses all requests rather than allowing them (ADR 0002).
- **Only people you list can reach the app at all.** Anyone else stops at Cloudflare's login page. The example policy also limits sign-in to New Zealand.
- **Read-only by default.** Only the Admin can change anything, and every change goes in a Change Log that all Members can see, including the Admin's email address (see [docs/privacy.md](docs/privacy.md#what-a-deployment-holds)).
- **Read-only bank access.** If you use Akahu Sync, its personal-app tokens can't make payments. A leaked token exposes history, not money.
- **Encrypted** in transit (TLS) and at rest (D1, R2). If you use Akahu Sync, its tokens are stored as encrypted Worker secrets, never in code or the database.
- **Protection against cross-site attacks:** changes must come from the app's own address with a JSON body. Strict security headers are set: a Content Security Policy, no framing, no referrer.
- **Safe exports:** CSV cells that would run as spreadsheet formulas, such as a payee named `=HYPERLINK(…)`, are defused with an apostrophe (see CSV export under [What it does](#what-it-does)).
- **Quiet logs:** logs contain only IDs, counts and error types, never transactions, tokens or emails. A test enforces this.
- **Nothing calls home:** no analytics, telemetry, email or third-party scripts.

### If something goes wrong

The breach checklist is in [docs/security.md](docs/security.md#if-something-goes-wrong).

### What it can't protect against

- **Your Cloudflare account is the master key.** Anyone who controls it controls your data. The setup guide requires two-factor authentication on it, and as few account members as possible.
- **Each Member's email is their key.** If someone's inbox is compromised, so is their access. Use Google or Microsoft sign-in with MFA for stronger protection.
- **No app-level encryption.** We rely on Cloudflare's encryption at rest. Encrypting inside the app wouldn't add real protection, because the key would live in the same Worker as the data, and it would make search and reports much harder.
- **Cloudflare can technically access data in your account,** as with any cloud host. See Cloudflare's [privacy policy](https://www.cloudflare.com/privacypolicy/).
- **A file you download is on your own.** Once a CSV export is saved, it has no sign-in, can be read by anyone who has it, and isn't in the Change Log. Keep it somewhere private, and delete it when you're done.

### How the code is kept safe

- Open source, so anyone can audit it.
- Every change goes through a pull request with automated checks:
  - type checks and tests
  - [gitleaks](https://github.com/gitleaks/gitleaks) secret scanning, with extra rules that block NZ bank account numbers and bank CSV exports from ever being committed
  - GitHub CodeQL code scanning
- Dependabot keeps dependencies patched, and we use few of them on purpose.
- An independent security audit runs before the first public release, and its findings and fixes will be published.
- To report a vulnerability, see [SECURITY.md](SECURITY.md). Please don't open a public issue.

### Privacy and the law

Read **[docs/privacy.md](docs/privacy.md)** for the details: what the Privacy Act, the PPPR Act and Akahu's terms mean for you, with sources, and the questions to take to a lawyer. In short, and as our understanding rather than legal advice:

- **You're responsible for your deployment, not the project.** Fernledger's maintainers collect nothing.
- **Your own household's finances** are very likely outside most of the Privacy Act (s 27, "personal or domestic affairs").
- **Attorneys sharing a parent's finances with family** are in a grey area. There's no guidance either way, so get advice.
- **Akahu's terms apply regardless:** security, data minimisation, deletion on request, and telling Akahu about breaches.
- **Every Member sees an "About your data" page** saying what's held, who can see it, where it's stored, how long it's kept and who to ask.
- **Nothing is deleted automatically.** Attorneys must keep records of every transaction, and tax rules set minimums, not maximums. You decide when to delete, using the teardown.

### Leaving Fernledger

The teardown (`npm run teardown`) takes a new final backup of everything and downloads it to a folder you choose, then deletes your database. Your data is yours, and you can take it with you or destroy it at any time.

- **The final backup comes first, and is checked.** It is always a new backup, never an older one, and the script checks that every table in the database is in it with the same row count, once after the backup and again right after you confirm, before deleting anything. If it can't be made, downloaded and verified, or the database changed meanwhile, nothing is deleted. Row counts can't see a row edited in place, so don't use the app during teardown. A table the backup can't hold (the manifest lists these) is deleted only if you type its name as well.
- **Deleting needs you to type the database's name.** It is never done on a default answer, and `CI=true` doesn't skip it.
- **You empty the backup bucket yourself, last.** Wrangler can't empty an R2 bucket, so the script deletes the database, then prints how to empty and delete the bucket. Emptying it destroys every backup in it, not only the final one, so download any older backup you want first.
- **If you used Akahu Sync, revoke your Akahu access yourself** (ADR 0008): remove the personal app Fernledger used, or disconnect the bank connections it syncs, in your Akahu account. Deleting the Worker removes Fernledger's copy of the token but doesn't revoke it. With CSV Imports only, there is nothing to revoke.
- [docs/setup.md](docs/setup.md#leaving-fernledger-teardown) has the steps, including the few things only you can delete (the Worker and the Access application).

## Where your data is stored

- **The database and backups are created in Oceania by default** (`REGION=oc`). Cloudflare doesn't say which city within Oceania, and has no New Zealand storage region. You can choose another region when you set up (ADR 0007).
- **This is a location *hint*, not a legal residency guarantee.** Cloudflare offers guaranteed jurisdictions only for the EU and FedRAMP.
- **Requests arrive at your nearest Cloudflare location,** such as Auckland. Smart Placement then runs the app next to its database.
- **Read replication is off,** so your data isn't copied to other regions.
- **Region is fixed at creation.** Changing it later means exporting and re-importing.

## Reliability

Fernledger aims to keep your data **correct, current and recoverable**.

### Correct

- **Balance check after every import.** Each bank CSV export states the account's balance at the top. Fernledger compares it with the balance it calculates from its own transactions since the previous export. If they differ, a warning reads, for example, "Balance differs from bank by $5.00 since Wed 30 Sept 2026": the amount, and the date of the previous bank balance it was compared with (that balance may itself have differed). Missing or duplicated transactions can't go unnoticed. The same check will run after every sync, against the balance Akahu reports.
  - The first balance an account has is not checked, because there is nothing to compare it with. The next import is checked against it.
  - A balance dated on or after the account's Cutover Date is not checked, because those days are meant to come from sync. Neither is a balance in a file that ends before that balance's date.
  - A transaction the bank adds late to the last day of an earlier export doesn't raise a false alarm. Pending transactions are never counted.
  - A transaction backfilled with the same date as an older balance (from a file that was missing it) isn't counted by that balance until that date's file is imported again.
  - If the Admin ticks "set the Cutover Date to the last date in this file" when importing (it is offered, never set unless ticked), the file's own balance is dated on or after that Cutover Date and isn't checked. Choose a later Cutover Date, or import a file that runs past it, for that balance to be checked.
  - "Since" is the date of the earlier balance the difference was checked against, not the date it was first seen ([ADR 0011](docs/adr/0011-balance-check-since-date.md)).
- **Syncs will be safe to repeat.** Transactions will be matched by Akahu's ID. Each sync will also re-check the last 30 days, because banks sometimes delete and re-issue a transaction.
- **Transactions are never deleted because a bank link changed.** If your bank reconnects or changes systems and Akahu issues a new account ID, Fernledger will flag "Account link broken". The Admin will re-link it in one step.

### Current

- **Sync will run daily, with an automatic retry** a few hours later if it failed. A sync will only count as successful when every account has finished.
- **The status banner will say what's wrong and what to do.** For example: "ASB needs reconnecting in Akahu (Admin)", "Akahu unavailable — retrying" or "Akahu token invalid (Admin)". Members will see the status, and the Admin will see the action. It will turn red after 2 days without a successful sync.

### Recoverable

- **Weekly full backups** go to your own R2 bucket and are all kept. They're a few MB each, so years of them fit in the free allowance. Each backup includes a manifest of row counts and checksums.
- **Point-in-time restore:** Cloudflare D1 can restore your database to any point in the last **7 days** on the free plan, or 30 days on paid plans.
- **Restore is tested:** CI tests the restore script, and you should do a restore practice run twice a year ([docs/setup.md](docs/setup.md#restore-practice-run-twice-a-year)).
- **Safe upgrades:** before a release changes the database, the deploy script takes a complete backup, then records a restore point. If the backup fails, it stops before changing anything. If an upgrade goes wrong, roll back by redeploying the previous release, and restore the restore point only if the data needs it ([docs/setup.md](docs/setup.md#rolling-back)).

### If the Admin becomes unavailable

The Admin also owns the Akahu connection. If they can't continue, viewing and backups keep working, but edits and syncing stop. The docs include a **succession procedure**: who else should hold access to the Cloudflare account, how to change the Admin, and how a new Admin connects their own Akahu app. If you act under Power of Attorney, plan this early.

### What we don't promise

- **No failover.** If Cloudflare or Akahu has an outage, Fernledger is unavailable or out of date until it ends.
- **Nothing is lost during an outage.** Your bank remains the source of truth, and the next sync catches up.

## Accessibility

Fernledger is often used by families where some members are older, and by people managing their own money in later life. It's built to be easy to read and use.

- **Standard:** every release meets [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/). Automated accessibility checks (axe) run on every page in both themes in CI. Before each release we test by keyboard only, with a screen reader (VoiceOver/NVDA), and at 200% zoom.
- **Readable text:** an in-app text-size control (**A / A+ / A++**) is remembered on each device. Body text starts at 16px, and table text is never smaller than 15px. Everything works at 200% browser zoom with no sideways scrolling.
- **Plain language:** "Money in" and "Money out", not debit and credit. Dates like "Thu 8 Oct 2026", amounts like "−$1,234.56". Technical settings, such as cutover dates and account links, appear only in the Admin's settings, each with a one-line explanation.
- **Colour is never the only signal.** Amounts carry a sign, and statuses carry an icon and words. Red and green are chosen to stay distinguishable for colour-blind users. Contrast meets AA in both light and dark themes.
- **Respects your device:** follows your light/dark setting, reduced-motion preference and Windows high-contrast mode.
- **A calm home page for Members:** read-only Members land on a simple Summary. It shows each account's balance, recent transactions and any balance warnings; this month's spending against budget and when the data was last updated will join them. Charts and filters are one click away.
- **Phones and tablets:** large touch targets (at least 44px), and tables become cards on narrow screens. Tested on iPad Safari and Android.
- **Printed reports for any reader:** at least 12pt text, black on white, page numbers ("Page 2 of 5"), table headings repeated on every page, and a header showing the account, date range and who generated the report and when. Page numbers ("Page 2 of 5") are printed by Chrome and Edge 131 and later; other browsers number pages only in their own header and footer, if that is turned on (see [Reports](#reports)).
- **Help signing in:** a one-page printable "How to sign in" guide for family members.

## Getting your history in

Akahu's history is limited:

| | History available when you first connect |
|---|---|
| Akahu personal apps | Up to 2 years |
| ASB | About 12 months |
| Kiwibank credit cards | About 180 days |
| SBS | About 6 months |

For anything older, export CSVs from your internet banking and **import** them. Fernledger parses the file in your browser and uploads it in chunks, so even 7 years of history stays within the free plan. **ASB CSV** is supported first. Other banks' formats will follow, and contributions are welcome.

## Setting it up

*The full guide arrives with the first release.* In outline:

1. **Before you start:** create an Akahu personal app and note its two tokens. Create a new Cloudflare account and turn on two-factor authentication.
2. **Deploy:** run `npm run setup`, which creates the database and backup bucket in your chosen region, then `npm run deploy`. Both ask you to confirm the Cloudflare account first, and take `--yes` to skip that prompt when there is no terminal. [docs/setup.md](docs/setup.md) has the steps. Or use the **Deploy to Cloudflare** button (coming before the public release).
3. **Lock it down:** turn on Cloudflare Access for the app's address, add your Members' emails, and paste the two Access values into the app's secrets. Until you do, the app refuses every request.
4. **Load your data:** import your CSV history, link each account to Akahu, and let the first sync run.

**Choosing public names:** your app's address (`fernledger.<subdomain>.workers.dev`) and sign-in page (`<team>.cloudflareaccess.com`) are visible to anyone who sees the link. Use neutral names, not the account holder's name.

## Updating

**How you hear about updates:**
- If you used the Deploy button (still Planned, see Status), a small GitHub Action in your copy checks weekly for a new Fernledger release. When it finds one, it opens a pull request with the release notes. Review it and click **Merge**, then run `npm run deploy` from the merged commit: that is the step that takes the pre-deploy backup, records the restore point and applies database migrations. If your Cloudflare build already deploys on merge, it skips those, so run `npm run deploy` as well (or instead). The action needs one setting turned on in your copy ([docs/setup.md](docs/setup.md#update-pull-requests)).
- **You are trusting upstream.** A merged update runs upstream's code in your build and deploy (package scripts, `.githooks`, `scripts/`), so read the pull request as you would any dependency update. The setting above lets Actions approve pull requests as well as create them, and pull requests opened with `GITHUB_TOKEN` don't trigger `pull_request` checks, so no CI runs on them.
- You can also **Watch → Releases** on this repo, and subscribe to its security advisories.
- The app itself never checks for updates. That would mean contacting GitHub, and Fernledger contacts no one but Akahu (only if you use Sync) and, to check a sign-in, your own Cloudflare Access (ADR 0010).

How releases are made and tested is in [docs/releasing.md](docs/releasing.md).

**Command-line deployments:** check out the new release tag, then run `npm run deploy`. It needs `npm run setup` to have been run once for this Cloudflare account. Add `--yes` to skip the confirmation prompt when there is no terminal ([docs/setup.md](docs/setup.md)).

**What version numbers mean** ([semver](https://semver.org)):

| Release | Example | What to expect |
|---|---|---|
| Patch | 1.2.**3** | Fixes only, and an add-only migration if the fix needs one. Security fixes ship this way immediately, with a GitHub Security Advisory |
| Minor | 1.**3**.0 | New features, no manual steps |
| Major | **2**.0.0 | Manual steps, explained in the upgrade notes |

Only the latest release receives fixes. Please stay current.

**Your data during an upgrade:**
- Before any database change, the deploy script takes a complete backup and records a restore point. If the backup fails, nothing changes.
- Database changes only ever **add** at first. Anything is removed only in a later release, once nothing uses it, so **rolling back to the previous version always works** (ADR 0009).
- You can skip versions: CI upgrades a sample database from each earlier minor release to the latest and checks the data is intact ([docs/releasing.md](docs/releasing.md#sample-databases)). No minor release has shipped yet, so the one sample is a placeholder that is replaced when v0.1.0 is released.
- Large data changes run in chunks and resume where they left off, so they stay within the free plan's daily limits.
- If a release needs a new setting, the Settings screen shows the Admin **"Setup needed"** and switches off just that feature until it's done. A feature you don't use, such as Akahu Sync, can stay off. Everything else keeps working.

## Technology choices

| Area | Choice | Why |
|---|---|---|
| Hosting | Cloudflare Workers + D1 + R2 | Free plan, no servers to run, built-in sign-in (ADR 0001, 0004) |
| Sign-in | Cloudflare Access | No passwords in the app (ADR 0002) |
| Database access | Plain SQL, no ORM | The app is mostly reports, which are best written as SQL (ADR 0005) |
| API | [Hono](https://hono.dev) + [zod](https://zod.dev) | Small, Workers-native, typed, validates input at the boundary |
| UI | React, [shadcn/ui](https://ui.shadcn.com), Tailwind | Clean neutral look, light/dark, accessible components |
| Tables | [TanStack Table](https://tanstack.com/table) | Sorting, filtering and paging for transaction lists |
| Charts | [Recharts](https://recharts.org) via shadcn Charts | Matches the UI theme |
| Routing/data | TanStack Router + Query | Typed routes, caching |
| Tests | Vitest + Cloudflare's Workers test pool | Business logic and SQL tested against a real local D1 |
| Browser tests | [Playwright](https://playwright.dev) | Accessibility (axe), print layouts, and phone/tablet layouts in a real browser |
| Accessibility checks | [axe-core](https://github.com/dequelabs/axe-core) in CI | WCAG 2.2 AA on every page, in both themes |
| Deploy | Wrangler | Standard Cloudflare tooling |

**Conventions:**
- Money is stored as integer cents, and dates are NZ dates.
- Business logic lives in pure, tested functions.
- Amounts are right-aligned in fixed-width digits, and always shown with a sign as well as a colour, so they read correctly for colour-blind users and on paper.

Why not build on Actual Budget, Sure or Firefly III? Each was evaluated in [ADR 0001](docs/adr/0001-custom-build-on-workers-d1.md).

## Project status and roadmap

| Milestone | Status |
|---|---|
| Design, decisions, glossary | Done |
| Skeleton, CI, sign-in and roles, guardrails, setup and deploy scripts | Done |
| Settings screen and "Setup needed" | Done |
| Change Log page | Done |
| Member pages (About your data, How to sign in) and Home Screen app | Done |
| Database, CSV import (ASB) | In progress |
| Balances, balance check after every import, the Summary | Done |
| Akahu sync | Planned |
| Categories, overrides and notes | Done |
| Transaction search and details | Done |
| Rules for new transactions | Done |
| Transfers | Done (imports) |
| Rules over existing history | Done |
| Budgets | Planned |
| Dashboard | Planned |
| CSV export | Done |
| Reports | In progress: the print layout and the transaction listing are done; the other four reports are planned |
| Backups and teardown | Done |
| Release process, update pull requests, upgrade tests | Done |
| Security audit, Deploy button, v1.0 | Planned |
| Receipt attachments, more bank CSV formats | After v1 |

## Contributing

Contributions are welcome once v1 lands. A code of conduct (Contributor Covenant), issue templates (bug report, request a bank's CSV format) and a pull request template will be added before the public announcement.
- [GLOSSARY.md](GLOSSARY.md) defines the project's terms. Please use them in code, issues and PRs.
- [docs/adr/](docs/adr/) explains why things are the way they are.
- **Never commit real bank data.** Use the made-up fixtures in `test/fixtures/`. CI will reject commits containing NZ account numbers.
- AI coding agents: see `AGENTS.md`.

To develop locally:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## Licence and disclaimer

[MIT](LICENSE).

Fernledger isn't financial, legal or tax advice. It isn't affiliated with Akahu, Cloudflare or any bank. Check bank and Akahu figures against your official statements. If you act under a Power of Attorney, your record-keeping obligations are yours. Fernledger helps, but doesn't replace professional advice.
