// Akahu Sync: once a day, the Transactions of every linked Account (ticket 27, spec 29, 31, 45, 48, 50, 51, 52, 53).
//
// Sync is optional per Account and the whole app works without it (ADR 0008). Nothing here runs unless the Deployer has set
// both Akahu tokens (worker/features.ts: AKAHU_SYNC) and the Admin has linked at least one Account.
//
// The window, per Account: from the later of its Cutover Date and RECHECK_DAYS before its last successful Sync, to now. The
// Cutover Date is the floor because an Import owns everything before it and the two sources never overlap (ADR 0003). The
// re-check is because a Transaction already synced can still change, and anything Akahu stops returning inside the window is
// removed (spec 49).
//
// Repeating a Sync is safe: every row carries Akahu's own ID and is written with ON CONFLICT DO UPDATE on it, so an overlapping
// window updates what it already holds and never adds a second copy (spec 48).
//
// Two Syncs can also overlap: the cron and the Admin's "Run a Sync now" (worker/sync-route.ts), or two of those. Nothing stops
// them, and nothing here knows a Sync is going. The same repeatability makes that safe, and a lock would block the retry the
// manual run exists to give: [ADR 0013](../docs/adr/0013-no-sync-lock.md) has the argument, including what the last-success
// mark and the page cap do when two runs overlap.
//
// The Account's own details (ticket 42): the run also asks Akahu for GET /accounts once, matches each linked Account's `_id` in the
// answer and stores what Akahu says about it (worker/akahu-details.ts). That is one request for the whole run, whatever the number of
// Accounts, and it comes out of the same MAX_PAGES as the Transactions' pages, so a run still makes at most MAX_PAGES requests to
// Akahu. If it fails, or does not list an Account, nothing is stored or cleared for that Account and Sync goes on as it did without it.
//
// D1 and subrequest budget (ADR 0004: 50 subrequests and 50 queries an invocation). One Account costs one page request for each
// 100 Transactions (akahu.ts caps the run, the details request included, at MAX_PAGES) and one batch of up to 7 statements. A household's
// daily Sync is a page or two an Account. A run that reaches the page cap, or that any Account fails in, is not a success and does not move that Account's
// `akahu_synced_at`, so the next run asks for the same window again (spec 47).
import { STORE_DETAILS, toCents, toDetails } from './akahu-details'
import type { AccountDetails } from './akahu-details'
import { akahuTokens, fetchAkahuTransactions, listAkahuAccounts, MAX_PAGES } from './akahu'
import type { AkahuAccount, AkahuFailure, AkahuResult, AkahuTransaction } from './akahu'
import { logEvent } from './log'
import { nzDate, nzDayStart } from './nz-time'
import { applyRulesStatement, lastTransactionId } from './rule-apply'
import { pairTransfersStatement } from './transfers'

/**
 * The cron Sync runs on: 18:00 UTC, which is 6 or 7 in the morning in NZ, after Akahu's own overnight refresh (spec 45).
 * It is one of the crons in wrangler.jsonc; scripts/wrangler-config.test.mjs fails if the two differ.
 */
export const SYNC_CRON = '0 18 * * *'

/**
 * How many days before the last successful Sync are asked for again (spec 49).
 *
 * Fourteen, not the thirty the spec first said. An NZ bank closes its transactions off daily and does not edit a settled one:
 * a correction arrives as an adjustment Transaction of its own, which is a new row and needs no re-check to be seen. What does
 * change state is a credit card's pending Transaction becoming a real one, and that settles in days.
 *
 * So the window is margin, not the mechanism, and two weeks is generous margin. It costs: every day of it is Transactions
 * fetched and written again on an account with any volume, out of one invocation's 50 subrequests and the page budget every
 * Account shares (worker/akahu.ts: MAX_PAGES).
 */
export const RECHECK_DAYS = 14

/**
 * The D1 queries one Sync may spend, and what one Account costs at most.
 *
 * An invocation gets 50 (ADR 0004). Sync has it to itself: the cron it runs on does nothing else, and "Run a Sync now" is a request of
 * its own that spends nothing beside it (the sign-in check reads no D1 row), so the backup and the Rules re-run, which the other crons
 * carry on (worker/index.ts), take none of it. The cap is one query for reading the Accounts and five Accounts at QUERIES_PER_ACCOUNT
 * each, 46, which leaves 4 of the 50 in hand. Five is a household's Accounts with room to grow; a sixth waits for the next run, and the
 * stalest first order (LINKED_ACCOUNTS) means it is not the same one each time.
 *
 * An Account costs one read for the highest Transaction ID and then its batch — the upsert, letting go of the partners of what
 * was withdrawn, the delete, the Rules, the pairing, the mark, and the Account's details — which is 8 (the test pins it), and 9 leaves one in hand. Sync stops starting
 * Accounts when fewer than that remain, rather than being cut off inside a batch; the Accounts it did not reach keep their old
 * last-success mark and come first in the next run (LINKED_ACCOUNTS). The one in hand stays: D1's own count of a batch can't be seen
 * from a test here, and an Account cut off inside its batch is the one failure this cap exists to prevent.
 */
export const MAX_QUERIES = 46
export const QUERIES_PER_ACCOUNT = 9

/** A linked Account, as Sync reads it. */
type LinkedAccount = {
  id: number
  account_number: string
  akahu_account_id: string
  cutover_date: string | null
  akahu_synced_at: string | null
}

// Least recently synced first, and an Account that has never synced before any that has. That ordering is what makes a run
// that stops early resume: an Account the budget did not reach keeps its old `akahu_synced_at`, so it sorts to the front of the
// next run. Taking them in `id` order instead would let the first Account spend the whole budget every morning and the last
// never sync at all. `id` only breaks ties, so the order is stable.
export const LINKED_ACCOUNTS = `
  SELECT id, account_number, akahu_account_id, cutover_date, akahu_synced_at
  FROM accounts WHERE akahu_account_id IS NOT NULL
  ORDER BY akahu_synced_at IS NOT NULL, akahu_synced_at, id`

// One statement for the whole Account's Transactions: the rows ride as a single JSON parameter and are unpacked with json_each,
// because D1 allows 100 bound parameters a statement and these rows have 17 columns (worker/imports.ts says the same of an Import).
//
// ON CONFLICT targets the unique index on `akahu_id` (migration 2701). The Account is not updated on conflict: a Transaction that
// somehow arrived under another Account stays where it is rather than moving silently, and ticket 29 (#30) is where a broken or
// changed Account Link is dealt with. `source` is not updated either: a row is 'sync' from the moment Sync wrote it.
//
// ?1 is the Account's ID, ?2 the rows.
export const UPSERT_SYNCED = `
  INSERT INTO transactions (
    account_id, date, amount_cents, description, bank_memo, bank_type, bank_reference, source, akahu_id, merchant,
    bank_counterparty_account, bank_card_suffix, bank_particulars, bank_payment_code, akahu_date_raw, has_bank_time, akahu_first_seen_at)
  SELECT ?1,
         json_extract(value, '$.date'),
         json_extract(value, '$.amountCents'),
         json_extract(value, '$.description'),
         json_extract(value, '$.bankMemo'),
         json_extract(value, '$.bankType'),
         json_extract(value, '$.bankReference'),
         'sync',
         json_extract(value, '$.akahuId'),
         json_extract(value, '$.merchant'),
         json_extract(value, '$.counterpartyAccount'),
         json_extract(value, '$.cardSuffix'),
         json_extract(value, '$.particulars'),
         json_extract(value, '$.paymentCode'),
         json_extract(value, '$.dateRaw'),
         json_extract(value, '$.hasBankTime'),
         json_extract(value, '$.firstSeenAt')
  FROM json_each(?2)
  -- Required, not decoration: after an INSERT … SELECT … FROM, SQLite reads a bare ON CONFLICT as a JOIN's ON and refuses the
  -- statement ("a JOIN clause is required before ON"), so the upsert clause must follow a WHERE. This one also says the rule the
  -- conflict target depends on: a row with no Akahu ID is not Sync's to write.
  WHERE json_extract(value, '$.akahuId') IS NOT NULL
  ON CONFLICT (akahu_id) WHERE akahu_id IS NOT NULL DO UPDATE SET
    date = excluded.date,
    amount_cents = excluded.amount_cents,
    description = excluded.description,
    bank_memo = excluded.bank_memo,
    bank_type = excluded.bank_type,
    bank_reference = excluded.bank_reference,
    merchant = excluded.merchant,
    bank_counterparty_account = excluded.bank_counterparty_account,
    bank_card_suffix = excluded.bank_card_suffix,
    bank_particulars = excluded.bank_particulars,
    bank_payment_code = excluded.bank_payment_code,
    akahu_date_raw = excluded.akahu_date_raw,
    has_bank_time = excluded.has_bank_time`

export const MARK_SYNCED = 'UPDATE accounts SET akahu_synced_at = ?2 WHERE id = ?1'

// The Transactions Akahu no longer returns (spec 49). Banks sometimes withdraw a Transaction and re-issue it with a new ID, so
// a settled day can change: each Sync re-checks the last RECHECK_DAYS and anything in the window that Akahu has stopped
// returning is one of those, and goes. Without this the old one and its replacement would both sit in the ledger.
//
// What it will not touch, by construction:
// - Imported Transactions. `source = 'sync'` only; the dates before the Cutover Date are the Import's and are not in the window.
// - Anything outside the window. `date >= ?2` is the window's first date, and the window is what Akahu was asked about.
// - Anything at all after a run that did not finish. The caller runs this only when the fetch was complete: a run cut short at
//   the page budget has not seen the whole window, and every Transaction it did not reach would look withdrawn.
//
// ?1 is the Account, ?2 the window's first date, ?3 the JSON array of Akahu IDs this Sync did return.
const WITHDRAWN = `
  SELECT id FROM transactions
  WHERE account_id = ?1 AND source = 'sync' AND date >= ?2
    AND akahu_id IS NOT NULL AND akahu_id NOT IN (SELECT value FROM json_each(?3))`

// A withdrawn Transaction may be half of a Transfer. Its partner is let go first, or it would be left pointing at a row that is
// no longer there (worker/transfers.ts does the same when an Import removes rows). Re-pairing is what pairTransfersStatement
// does afterwards, with whatever Akahu returned in its place.
export const UNPAIR_WITHDRAWN = `UPDATE transactions SET transfer_of = NULL WHERE transfer_of IN (${WITHDRAWN})`

export const DELETE_WITHDRAWN = `DELETE FROM transactions WHERE id IN (${WITHDRAWN})`

/** A Transaction as the upsert's JSON wants it. Field names are this file's; the column names are in UPSERT_SYNCED. */
export type SyncRow = {
  akahuId: string
  date: string
  amountCents: number
  description: string
  bankMemo: string
  bankType: string
  bankReference: string | null
  merchant: string | null
  counterpartyAccount: string | null
  cardSuffix: string | null
  particulars: string | null
  paymentCode: string | null
  dateRaw: string
  hasBankTime: number
  firstSeenAt: string
}

/**
 * Whether the bank supplied a real time of day, or only a date (spec 52: a Bank Time is shown only when it is real).
 *
 * Akahu gives every Transaction an instant, and a bank that supplied a date alone has to arrive as some midnight. Which one is
 * not stated anywhere, and these are NZ banks reporting NZ dates, so both are read as a placeholder:
 * - midnight UTC, if Akahu writes a bare date as an instant, and
 * - midnight in Pacific/Auckland, if it writes the NZ day the bank meant (11:00 or 12:00 UTC the day before).
 *
 * This is a reading of the data, not something Akahu states, so it is wrong in one direction only: a Transaction the bank really
 * did stamp at one of those two moments is treated as having no time, and no time is shown. Fernledger never invents a time, so
 * failing this way shows nothing rather than showing midnight as if the bank had meant it. The raw value is kept in
 * `akahu_date_raw` either way, so reading it better later loses nothing (spec 51).
 */
export function hasBankTime(dateRaw: string): boolean {
  const at = Date.parse(dateRaw)
  if (Number.isNaN(at)) return false
  if (at % 86_400_000 === 0) return false
  const instant = new Date(at)
  try {
    return nzDayStart(nzDate(instant)) !== instant.toISOString()
  } catch {
    // Outside the years nzDayStart handles. The instant is not one of the two midnights it could have checked for, so it stands.
    return true
  }
}

/** One Akahu Transaction as a row. `description` is the merchant Akahu recognised, or the bank's own description when there is none. */
export function toRow(transaction: AkahuTransaction): SyncRow {
  const meta = transaction.meta ?? {}
  const merchant = transaction.merchant?.name ?? null
  return {
    akahuId: transaction._id,
    date: nzDate(new Date(transaction.date)),
    amountCents: toCents(transaction.amount),
    description: merchant ?? transaction.description,
    bankMemo: transaction.description,
    bankType: transaction.type,
    bankReference: meta.reference ?? null,
    merchant,
    counterpartyAccount: meta.other_account ?? null,
    cardSuffix: meta.card_suffix ?? null,
    particulars: meta.particulars ?? null,
    paymentCode: meta.code ?? null,
    dateRaw: transaction.date,
    hasBankTime: hasBankTime(transaction.date) ? 1 : 0,
    firstSeenAt: transaction.created_at,
  }
}

/** The NZ date `days` before `date`, both `YYYY-MM-DD`. */
const daysBefore = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)

/**
 * Where a Sync of this Account starts:
 * - `from` a date: the later of the Cutover Date and RECHECK_DAYS before the last successful Sync. An Account that has never
 *   synced starts at its Cutover Date.
 * - `skip`: the Account has no Cutover Date, so where the imported history stops and Sync starts is not known.
 *
 * An Account is set up by importing a CSV first and linked to Akahu after, so by the time it is synced it has a Cutover Date
 * (README: Setting up an Account). Skipping is for an Account linked before that was done, and it is the Admin's to fix.
 *
 * Syncing from the beginning of Akahu's history instead is not an option, and not only because it would overlap the imported
 * history the Cutover Date exists to separate (ADR 0003): Akahu refuses a transactions query with no `start`, which is what a
 * live run on 2026-10-20 answered before the Cutover Date was set.
 */
export type SyncWindow = { kind: 'from'; date: string } | { kind: 'skip' }

export function windowStart(account: Pick<LinkedAccount, 'cutover_date' | 'akahu_synced_at'>): SyncWindow {
  const recheckFrom = account.akahu_synced_at === null ? null : daysBefore(nzDate(new Date(account.akahu_synced_at)), RECHECK_DAYS)
  if (account.cutover_date === null) return recheckFrom === null ? { kind: 'skip' } : { kind: 'from', date: recheckFrom }
  // ISO dates compare correctly as text.
  if (recheckFrom === null || recheckFrom <= account.cutover_date) return { kind: 'from', date: account.cutover_date }
  return { kind: 'from', date: recheckFrom }
}

/** What one Account's Sync did, for the run's own result and its log line. */
export type AccountOutcome = { accountId: number; written: number; removed: number; complete: boolean; failure?: AkahuFailure | 'no-window' | 'no-budget' }

/** What `writeAccount` changed: Transactions written (added or updated), and Transactions Akahu no longer returns, removed. */
export type AccountWrite = { written: number; removed: number }

/**
 * What the write may do, which depends on how the fetch ended. `syncedAt` is the run's moment when the Account finished and
 * null when it did not; `from` is the window's first date, and is given only when the whole window was read, because that is
 * the only time Sync can tell a withdrawn Transaction from one it has not reached yet.
 */
export type WriteWindow = { syncedAt: Date | null; from: string | null }

export type SyncOutcome = { ran: boolean; success: boolean; accounts: AccountOutcome[] }

/**
 * Sync every linked Account. `now` is the moment the run belongs to (the cron's scheduled time, or when the Admin asked for a
 * run of their own), so a run's window and the `akahu_synced_at` it writes agree with each other however long the run takes.
 *
 * The run is a success only when every linked Account finished (spec 47). An Account that failed, or that stopped at the page
 * cap, keeps its old `akahu_synced_at`, so the next run asks for its window again.
 */
export async function syncAll(env: Env, now: Date): Promise<SyncOutcome> {
  const tokens = akahuTokens(env)
  if (tokens === null) return { ran: false, success: false, accounts: [] }
  const { results } = await env.DB.prepare(LINKED_ACCOUNTS).all<LinkedAccount>()
  if (results.length === 0) return { ran: false, success: false, accounts: [] }

  logEvent('sync.start', { count: results.length })
  const budget = { pagesLeft: MAX_PAGES }
  // One query has already gone on reading the Accounts.
  let queriesLeft = MAX_QUERIES - 1
  const end = now.toISOString()
  const outcomes: AccountOutcome[] = []
  // Asked for once, when the first Account is about to be read, so a run that reads none asks for nothing.
  let listed: AkahuResult<AkahuAccount[]> | undefined

  for (const account of results) {
    const window = windowStart(account)
    if (window.kind === 'skip') {
      logEvent('sync.account.no-window', { id: account.id })
      outcomes.push({ accountId: account.id, written: 0, removed: 0, complete: false, failure: 'no-window' })
      continue
    }
    // Stop before an Account rather than inside one: a batch cut off part way is the one thing that would leave an Account's
    // rows written without the Rules, the pairing or the mark that says it finished.
    if (queriesLeft < QUERIES_PER_ACCOUNT) {
      logEvent('sync.account.no-budget', { id: account.id })
      outcomes.push({ accountId: account.id, written: 0, removed: 0, complete: false, failure: 'no-budget' })
      continue
    }
    // Akahu's `start` is exclusive, so the instant asked for is the millisecond before NZ midnight on the window's first date: a
    // Transaction stamped at exactly that midnight is inside the window, not just outside it.
    const start = new Date(Date.parse(nzDayStart(window.date)) - 1).toISOString()
    if (listed === undefined) {
      budget.pagesLeft -= 1
      listed = await listAkahuAccounts(tokens)
    }
    const akahuAccount = listed.ok ? listed.value.find((candidate) => candidate._id === account.akahu_account_id) : undefined
    const details = akahuAccount === undefined ? null : toDetails(akahuAccount)
    const answer = await fetchAkahuTransactions(tokens, account.akahu_account_id, { start, end }, budget)
    if (!answer.ok) {
      // What Akahu said about the Account is still true, so it is kept: one query, which the Account's share (QUERIES_PER_ACCOUNT) already holds.
      if (details !== null) {
        await storeDetails(env.DB, account, details)
        queriesLeft -= 1
      }
      logEvent('sync.account.failed', { id: account.id })
      outcomes.push({ accountId: account.id, written: 0, removed: 0, complete: false, failure: answer.reason })
      continue
    }
    const { transactions, complete } = answer.value
    queriesLeft -= QUERIES_PER_ACCOUNT
    const { written, removed } = await writeAccount(env.DB, account, transactions.map(toRow), {
      syncedAt: complete ? now : null,
      from: complete ? window.date : null,
    }, details)
    logEvent(complete ? 'sync.account.done' : 'sync.account.partial', { id: account.id, count: written })
    if (removed > 0) logEvent('sync.account.withdrawn', { id: account.id, count: removed })
    outcomes.push({ accountId: account.id, written, removed, complete })
  }

  const success = outcomes.every((outcome) => outcome.complete)
  logEvent(success ? 'sync.done' : 'sync.incomplete', { count: outcomes.reduce((total, outcome) => total + outcome.written, 0) })
  return { ran: true, success, accounts: outcomes }
}

// Only while the Account is still linked to the Akahu account the details came from (STORE_DETAILS).
const detailsStatement = (db: D1Database, account: LinkedAccount, details: AccountDetails) =>
  db.prepare(STORE_DETAILS).bind(account.id, account.akahu_account_id, JSON.stringify(details))

const storeDetails = (db: D1Database, account: LinkedAccount, details: AccountDetails) => detailsStatement(db, account, details).run()

/**
 * Write one Account's Transactions, give them their Rules and pair their Transfers, and — only when the Account finished
 * (`syncedAt` is the run's moment, or null when it did not) — record that Sync reached it. `details` is what Akahu says about
 * the Account, written whole so that a field it stopped sending is cleared; null when Akahu did not say this time, which leaves
 * what is stored alone.
 *
 * The statements go in one batch, so an Account's rows and what follows from them commit together or not at all. That is
 * the same reason an Import batches its own (worker/imports.ts), and it is why the Rules are applied from the highest
 * Transaction ID read just before the batch: a failure part way would otherwise leave rows that no retry gives Rules to.
 *
 * No Change Log entry: the Change Log records what an Admin did, and every entry carries the actor's email (worker/changelog.ts).
 * A Sync is the app's own daily work with no one behind it, and the Sync status (ticket 29, #30) is where a Member sees it.
 */
export async function writeAccount(db: D1Database, account: LinkedAccount, rows: SyncRow[], window: WriteWindow, details: AccountDetails | null): Promise<AccountWrite> {
  const { syncedAt, from } = window
  // Only a finished fetch has seen the whole window, so only a finished fetch may say what is no longer in it.
  const withdrawable = syncedAt !== null && from !== null
  if (rows.length === 0 && !withdrawable && details === null) return { written: 0, removed: 0 }

  const ids = JSON.stringify(rows.map((row) => row.akahuId))
  const afterId = await lastTransactionId(db)
  const statements = [
    ...(rows.length === 0 ? [] : [db.prepare(UPSERT_SYNCED).bind(account.id, JSON.stringify(rows))]),
    // The partners go first, then the rows, then the Rules and the pairing over what is left.
    ...(withdrawable ? [db.prepare(UNPAIR_WITHDRAWN).bind(account.id, from, ids), db.prepare(DELETE_WITHDRAWN).bind(account.id, from, ids)] : []),
    applyRulesStatement(db, { accountNumber: account.account_number, afterId }),
    pairTransfersStatement(db, { accountNumber: account.account_number, afterId }),
    ...(syncedAt === null ? [] : [db.prepare(MARK_SYNCED).bind(account.id, syncedAt.toISOString())]),
    ...(details === null ? [] : [detailsStatement(db, account, details)]),
  ]
  const results = await db.batch(statements)
  const written = rows.length === 0 ? 0 : results[0]!.meta.changes
  // The delete is the second of the withdrawn pair, after the upsert when there was one.
  const removed = withdrawable ? results[(rows.length === 0 ? 0 : 1) + 1]!.meta.changes : 0
  return { written, removed }
}
