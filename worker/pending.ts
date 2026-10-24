// Pending Transactions: money the bank has reported and not settled (ticket 29, spec 54, 55, 56; GLOSSARY "Pending Transaction").
//
// They are kept in `pending_transactions` (migration 2901) and not in `transactions`, so no Budget, Report or total has to know
// they exist to leave them out: nothing that adds Transactions up reads this table. The Transactions list shows them above the
// settled rows, marked as pending (src/components/transaction-list.tsx).
//
// Every Sync replaces them whole, for all the linked Accounts at once: Akahu's pending rows carry no `_id`, so there is nothing to
// match one against and nothing to update, and what the bank is showing at the moment of asking is all there is (spec 55). One
// delete and one insert for the run, whatever the number of Accounts, which is what the run's share of the D1 queries can afford
// (worker/sync.ts: RUN_QUERIES).
import type { AkahuPending } from './akahu'
import { toCents } from './akahu-details'
import { nzDate } from './nz-time'

/** One Pending Transaction as its row, with the Account it belongs to. */
export type PendingRow = {
  accountId: number
  date: string
  amountCents: number
  description: string
  bankType: string | null
}

/**
 * What Akahu sent for the Accounts that are linked, as rows. A pending row for an account nobody linked is dropped: Akahu
 * answering for more accounts than were linked must not put them in the app (spec 31), the same check the Transactions make.
 *
 * `accountIds` maps Akahu's account ID to the Account's own.
 */
export const toPendingRows = (pending: AkahuPending[], accountIds: Map<string, number>): PendingRow[] =>
  pending.flatMap((item) => {
    const accountId = accountIds.get(item._account)
    if (accountId === undefined) return []
    return [
      {
        accountId,
        // The NZ date of the instant Akahu gave, as every date in the app is (worker/nz-time.ts).
        date: nzDate(new Date(item.date)),
        amountCents: toCents(item.amount),
        description: item.description,
        bankType: item.type ?? null,
      },
    ]
  })

/** Everything held for the linked Accounts, whose IDs ride as a JSON array in ?1. The insert below writes what Akahu has now. */
export const DELETE_PENDING = 'DELETE FROM pending_transactions WHERE account_id IN (SELECT value FROM json_each(?1))'

/**
 * One Account's pending money, for the statement that unlinks or relinks it (worker/accounts.ts). It goes in the same batch as
 * the link itself, so the two commit together: pending rows left behind on an unlinked Account would be shown and never
 * replaced, because a Sync only replaces the rows of Accounts that are linked.
 *
 * ?1 is the Account and ?2 the link it is read to have. It goes BEFORE the update in the batch, guarded on that same old link,
 * for two reasons: the Change Log entry that ends the batch counts `changes()` of the statement just before it (worker/changelog.ts),
 * which must be the update itself; and a link someone else changed in between matches neither statement, so the Account's
 * pending money is left alone exactly where its link is.
 */
export const DELETE_PENDING_ON_RELINK = `DELETE FROM pending_transactions
  WHERE account_id = ?1 AND (SELECT akahu_account_id FROM accounts WHERE id = ?1) IS ?2`

// The rows ride as one JSON parameter and are unpacked with json_each, as an Account's Transactions do (worker/sync.ts: UPSERT_SYNCED):
// D1 allows 100 bound parameters a statement, and a household's pending rows are not worth a statement each.
//
// ?1 is the rows, ?2 the instant this Sync ran.
export const INSERT_PENDING = `
  INSERT INTO pending_transactions (account_id, date, amount_cents, description, bank_type, synced_at)
  SELECT json_extract(value, '$.accountId'),
         json_extract(value, '$.date'),
         json_extract(value, '$.amountCents'),
         json_extract(value, '$.description'),
         json_extract(value, '$.bankType'),
         ?2
  FROM json_each(?1)`

/** What the Transactions list reads: the pending rows of every Account, newest first, with the Account's name. */
export const SELECT_PENDING = `
  SELECT pending_transactions.id AS id,
         account_id AS accountId,
         accounts.name AS accountName,
         date,
         amount_cents AS amountCents,
         description,
         bank_type AS bankType,
         synced_at AS syncedAt
  FROM pending_transactions
  JOIN accounts ON accounts.id = pending_transactions.account_id
  -- Only while the Account is still linked: pending money came from a link, and an Account that no longer has one has nothing
  -- pending to show, whatever the table still holds.
  WHERE accounts.akahu_account_id IS NOT NULL
  ORDER BY date DESC, pending_transactions.id DESC`

/** One Pending Transaction as the Transactions list reads it. */
export type PendingTransaction = {
  id: number
  accountId: number
  accountName: string
  date: string
  amountCents: number
  description: string
  bankType: string | null
  /** When the Sync that read it ran, so the list can say how current the pending money is. */
  syncedAt: string
}
