// Akahu Sync: once a day, the Transactions of every linked Account (ticket 27, spec 29, 31, 45, 48, 50, 51, 52, 53).
//
// Sync is optional per Account and the whole app works without it (ADR 0008). Nothing here runs unless the Deployer has set
// both Akahu tokens (worker/features.ts: AKAHU_SYNC) and the Admin has linked at least one Account.
//
// The window, per Account: from the later of its Cutover Date and 30 days before its last successful Sync, to now. The Cutover
// Date is the floor because an Import owns everything before it and the two sources never overlap (ADR 0003). The 30 days are
// because banks sometimes delete and re-issue a Transaction, so a settled day can still change; ticket 28 (#29) adds the removal
// of Transactions Akahu no longer returns within that window, which is why the re-check is here from the start.
//
// Repeating a Sync is safe: every row carries Akahu's own ID and is written with ON CONFLICT DO UPDATE on it, so an overlapping
// window updates what it already holds and never adds a second copy (spec 48).
//
// Two Syncs can also overlap: the cron and the Admin's "Run a Sync now" (worker/sync-route.ts), or two of those. Nothing stops
// them, and nothing here knows a Sync is going. The same repeatability makes that safe, and a lock would block the retry the
// manual run exists to give: [ADR 0013](../docs/adr/0013-no-sync-lock.md) has the argument, including what the last-success
// mark and the page cap do when two runs overlap.
//
// D1 and subrequest budget (ADR 0004: 50 subrequests and 50 queries an invocation). One Account costs one page request for each
// 100 Transactions (akahu.ts caps the run at MAX_PAGES) and one batch of 4 statements. A household's daily Sync is a page or two
// an Account. A run that reaches the page cap, or that any Account fails in, is not a success and does not move that Account's
// `akahu_synced_at`, so the next run asks for the same window again (spec 47).
import { akahuTokens, fetchAkahuTransactions, MAX_PAGES } from './akahu'
import type { AkahuFailure, AkahuTransaction } from './akahu'
import { logEvent } from './log'
import { nzDate, nzDayStart } from './nz-time'
import { applyRulesStatement, lastTransactionId } from './rule-apply'
import { pairTransfersStatement } from './transfers'

/**
 * The cron Sync runs on: 18:00 UTC, which is 6 or 7 in the morning in NZ, after Akahu's own overnight refresh (spec 45).
 * It is one of the crons in wrangler.jsonc; scripts/wrangler-config.test.mjs fails if the two differ.
 */
export const SYNC_CRON = '0 18 * * *'

/** How many days before the last successful Sync are asked for again, because a bank can still change them (spec 49). */
export const RECHECK_DAYS = 30

/** A linked Account, as Sync reads it. */
type LinkedAccount = {
  id: number
  account_number: string
  akahu_account_id: string
  cutover_date: string | null
  akahu_synced_at: string | null
}

export const LINKED_ACCOUNTS = `
  SELECT id, account_number, akahu_account_id, cutover_date, akahu_synced_at
  FROM accounts WHERE akahu_account_id IS NOT NULL ORDER BY id`

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

/** Akahu's dollars as integer NZD cents. Rounded, because JSON numbers are binary floats and 12.34 is not exact. */
export const toCents = (amount: number): number => Math.round(amount * 100)

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
export type AccountOutcome = { accountId: number; written: number; complete: boolean; failure?: AkahuFailure | 'no-window' }

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
  const end = now.toISOString()
  const outcomes: AccountOutcome[] = []

  for (const account of results) {
    const window = windowStart(account)
    if (window.kind === 'skip') {
      logEvent('sync.account.no-window', { id: account.id })
      outcomes.push({ accountId: account.id, written: 0, complete: false, failure: 'no-window' })
      continue
    }
    // Akahu's `start` is exclusive, so the instant asked for is the millisecond before NZ midnight on the window's first date: a
    // Transaction stamped at exactly that midnight is inside the window, not just outside it.
    const start = new Date(Date.parse(nzDayStart(window.date)) - 1).toISOString()
    const answer = await fetchAkahuTransactions(tokens, account.akahu_account_id, { start, end }, budget)
    if (!answer.ok) {
      logEvent('sync.account.failed', { id: account.id })
      outcomes.push({ accountId: account.id, written: 0, complete: false, failure: answer.reason })
      continue
    }
    const { transactions, complete } = answer.value
    const written = await writeAccount(env.DB, account, transactions.map(toRow), complete ? now : null)
    logEvent(complete ? 'sync.account.done' : 'sync.account.partial', { id: account.id, count: written })
    outcomes.push({ accountId: account.id, written, complete })
  }

  const success = outcomes.every((outcome) => outcome.complete)
  logEvent(success ? 'sync.done' : 'sync.incomplete', { count: outcomes.reduce((total, outcome) => total + outcome.written, 0) })
  return { ran: true, success, accounts: outcomes }
}

/**
 * Write one Account's Transactions, give them their Rules and pair their Transfers, and — only when the Account finished
 * (`syncedAt` is the run's moment, or null when it did not) — record that Sync reached it.
 *
 * The four statements go in one batch, so an Account's rows and what follows from them commit together or not at all. That is
 * the same reason an Import batches its own (worker/imports.ts), and it is why the Rules are applied from the highest
 * Transaction ID read just before the batch: a failure part way would otherwise leave rows that no retry gives Rules to.
 *
 * No Change Log entry: the Change Log records what an Admin did, and every entry carries the actor's email (worker/changelog.ts).
 * A Sync is the app's own daily work with no one behind it, and the Sync status (ticket 29, #30) is where a Member sees it.
 */
export async function writeAccount(db: D1Database, account: LinkedAccount, rows: SyncRow[], syncedAt: Date | null): Promise<number> {
  if (rows.length === 0) {
    if (syncedAt !== null) await db.prepare(MARK_SYNCED).bind(account.id, syncedAt.toISOString()).run()
    return 0
  }
  const afterId = await lastTransactionId(db)
  const statements = [
    db.prepare(UPSERT_SYNCED).bind(account.id, JSON.stringify(rows)),
    applyRulesStatement(db, { accountNumber: account.account_number, afterId }),
    pairTransfersStatement(db, { accountNumber: account.account_number, afterId }),
    ...(syncedAt === null ? [] : [db.prepare(MARK_SYNCED).bind(account.id, syncedAt.toISOString())]),
  ]
  const [upsert] = await db.batch(statements)
  return upsert!.meta.changes
}
