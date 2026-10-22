// What Akahu says about a linked Account, kept in `accounts` (migration 4201; ticket 42). Sync writes every column from Akahu's answer,
// so a field Akahu stops sending is cleared and not left stale (toDetails, below). Unlinking or relinking an Account clears them
// all, because they describe the old link (worker/accounts.ts). The Accounts screen shows the DISPLAYED ones.
//
import type { AkahuAccount } from './akahu'

// Never fetched, drawn or sent to the browser: `akahuConnectionLogo`, a URL on Akahu's CDN. Storing the string asks no one anything;
// drawing it would make the reader's browser contact Akahu, which ADR 0010 does not allow.

/** One Account's details as the store statement wants them. Names are this file's; `COLUMNS` has the column of each. */
export type AccountDetails = {
  akahuName: string
  akahuFormattedAccount: string | null
  akahuStatus: string | null
  akahuType: string | null
  /** Akahu's attributes, as a JSON array of words. */
  akahuAttributes: string | null
  akahuConnectionId: string | null
  akahuConnectionName: string | null
  akahuConnectionLogo: string | null
  akahuConnectionType: string | null
  akahuBalanceCurrency: string | null
  akahuBalanceCurrentCents: number | null
  akahuBalanceAvailableCents: number | null
  akahuRefreshedBalanceAt: string | null
  akahuRefreshedMetaAt: string | null
  akahuRefreshedTransactionsAt: string | null
}

const COLUMNS = {
  akahuName: 'akahu_name',
  akahuFormattedAccount: 'akahu_formatted_account',
  akahuStatus: 'akahu_status',
  akahuType: 'akahu_type',
  akahuAttributes: 'akahu_attributes',
  akahuConnectionId: 'akahu_connection_id',
  akahuConnectionName: 'akahu_connection_name',
  akahuConnectionLogo: 'akahu_connection_logo',
  akahuConnectionType: 'akahu_connection_type',
  akahuBalanceCurrency: 'akahu_balance_currency',
  akahuBalanceCurrentCents: 'akahu_balance_current_cents',
  akahuBalanceAvailableCents: 'akahu_balance_available_cents',
  akahuRefreshedBalanceAt: 'akahu_refreshed_balance_at',
  akahuRefreshedMetaAt: 'akahu_refreshed_meta_at',
  akahuRefreshedTransactionsAt: 'akahu_refreshed_transactions_at',
} as const satisfies Record<keyof AccountDetails, string>

const entries = Object.entries(COLUMNS)

// ?1 is the Account, ?2 the Akahu account it is linked to and ?3 the details as JSON. Only while the Account is still linked to that
// Akahu account: a link changed while a Sync was running must not get the old account's details back.
//
// Writing these details means Akahu listed the Account, which is the one thing that says its Link is not broken, so the same
// statement clears `akahu_missing_since` and the status stops saying so (worker/sync.ts: MARK_MISSING, ticket 29).
export const STORE_DETAILS = `UPDATE accounts SET ${entries.map(([key, column]) => `${column} = json_extract(?3, '$.${key}')`).join(', ')},
    akahu_missing_since = NULL
  WHERE id = ?1 AND akahu_account_id = ?2`

/**
 * The SET list that clears them all, for the statement that unlinks or relinks an Account. `akahu_missing_since` and
 * `akahu_last_failure` (migration 2901) go with them: a broken Link and a failed Sync were the old link's, and the new one has
 * neither until a Sync says so.
 */
export const CLEAR_DETAILS = [...entries.map(([, column]) => column), 'akahu_missing_since', 'akahu_last_failure'].map((column) => `${column} = NULL`).join(', ')

/** The part of the details the Accounts screen shows, as the Accounts list reads them. The logo URL is not among them. */
const DISPLAYED = [
  'akahuName',
  'akahuStatus',
  'akahuType',
  'akahuConnectionName',
  'akahuBalanceCurrency',
  'akahuBalanceCurrentCents',
  'akahuBalanceAvailableCents',
  'akahuRefreshedBalanceAt',
  'akahuRefreshedMetaAt',
  'akahuRefreshedTransactionsAt',
] as const satisfies readonly (keyof AccountDetails)[]

export type DisplayedDetails = Pick<AccountDetails, (typeof DISPLAYED)[number]>

export const SELECT_DISPLAYED = DISPLAYED.map((key) => `${COLUMNS[key]} AS ${key}`).join(', ')

/** Akahu's dollars as integer NZD cents. Rounded, because JSON numbers are binary floats and 12.34 is not exact. */
export const toCents = (amount: number): number => Math.round(amount * 100)

// An instant written as `toISOString` does, or nothing for one that is missing or is not a moment (the Accounts screen writes it as a time).
const isoInstantOrNull = (value: string | undefined): string | null => {
  const at = new Date(value ?? NaN)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * What Akahu says about one account, as the Account's columns want it. Every column is written on every Sync, so what Akahu has
 * stopped sending is null here and clears the column. Balances are cents of the currency Akahu names, which is kept beside them.
 */
export function toDetails(account: AkahuAccount): AccountDetails {
  const { balance, refreshed, connection } = account
  return {
    akahuName: account.name,
    akahuFormattedAccount: account.formatted_account ?? null,
    akahuStatus: account.status ?? null,
    akahuType: account.type ?? null,
    akahuAttributes: account.attributes === undefined ? null : JSON.stringify(account.attributes),
    akahuConnectionId: connection?._id ?? null,
    akahuConnectionName: connection?.name ?? null,
    akahuConnectionLogo: connection?.logo ?? null,
    akahuConnectionType: connection?.connection_type ?? null,
    akahuBalanceCurrency: balance?.currency ?? null,
    akahuBalanceCurrentCents: balance === undefined ? null : toCents(balance.current),
    akahuBalanceAvailableCents: balance?.available === undefined ? null : toCents(balance.available),
    akahuRefreshedBalanceAt: isoInstantOrNull(refreshed?.balance),
    akahuRefreshedMetaAt: isoInstantOrNull(refreshed?.meta),
    akahuRefreshedTransactionsAt: isoInstantOrNull(refreshed?.transactions),
  }
}
