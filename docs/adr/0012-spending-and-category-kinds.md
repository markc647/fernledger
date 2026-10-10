# Spending and Income come from the Category's kind

Every Category has a kind, which the Admin sets: Spending, Income or Loans. A Transaction is totalled by the kind of its effective Category (override, then Rule, then Akahu; Uncategorised counts as Spending), and by the NZ calendar month of its date:

- **Spending**, for a Spending Category in a month, is money out minus money in, so a refund reduces it. A Category that took in more than it paid out is below zero.
- **Income**, for an Income Category, is money in minus money out.
- **Loans** are neither. A Loans Category is left out of Budgets and out of every Spending and Income total, as a Transfer is. Money lent or borrowed is not what the family spent or earned. The Admin makes one Loans Category for each person, such as "Loan – Alice", so that a Loans Report (#38) can list one person's loan and what is owed on its own.
- **Transfers** and **Pending Transactions** are left out of all of them, whatever their Category.
- **Budgets** can be set on Spending Categories only. A Budget kept for a Category that later stops being Spending is not deleted, but nothing uses it until the Category is Spending again.

The starter Categories Wages and salary, NZ Super and benefits, Interest and Other income are Income, a starter Loans Category is Loans, and everything else is Spending. The kind is a column of `categories` (`migrations/1602_category_kind.sql`), not stored on each Transaction, so changing a Category's kind re-totals every month, past ones included.

An Override outranks a Transfer, so a Transfer half the Admin gives a Category counts under that Category's kind, which is not always Spending. Lending to a child's tracked Account, with a Loans Category on both halves, is neither Spending nor Income.

`worker/spending.ts` is the only place these are written down in code: `buildSpending` reads money out and money in for a range of NZ dates, for all Accounts or one, `rollUp` turns the rows into Spending and Income by month and by Category, and `isLoan` picks out the Transactions in Loans Categories. Budget vs actual uses them now. The Dashboard (#18), Spending by Category (#21), the Budget vs actual Report (#22), Income vs spending (#23) and the Loans Report (#38) will, so none can disagree. A query that totals spending anywhere else is a bug.

## Consequences

- Money in that is not in an Income or Loans Category counts against Spending: a wage that is still Uncategorised makes Spending look smaller than it is. Categorising it fixes every month it is in. Budget vs actual shows Uncategorised on its own row, and the Uncategorised page says so, so it can be seen.
- Netting refunds means a Spending Category's figure is not the sum of its money out. A refund in a later month than the purchase reduces the later month. The Reports that need money out and money in apart read `outCents` and `inCents` from the rows before they are rolled up.
- What reading the Transactions costs is in [ADR 0004](0004-runs-on-workers-free-plan.md).
- A Pending Transaction is stored apart from Transactions, so spending never reads one. The Sync ticket must add a test that a Pending Transaction is left out (`worker/spending.test.ts` has it as a todo).
- A backup made before Category kinds restores every Category as Spending, because the backup has no kind to restore. The Admin sets the Income and Loans Categories again (`scripts/backup-restore.test.mjs` tests it).
- `categories.kind` is NOT NULL, which [ADR 0009](0009-expand-contract-migrations.md) explains is still safe to roll back from.
