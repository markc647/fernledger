// What Akahu says about a linked Account, kept in `accounts` (migration 4201; ticket 42). Sync writes every column from Akahu's answer,
// so a field Akahu stops sending is cleared and not left stale (worker/sync.ts: toDetails). Unlinking or relinking an Account clears them
// all, because they describe the old link (worker/accounts.ts). The Accounts screen shows the DISPLAYED ones.
//
// Never fetched, drawn or sent to the browser: `akahuConnectionLogo`, a URL on Akahu's CDN. Storing the string asks no one anything;
// drawing it would make the reader's browser contact Akahu, which ADR 0010 does not allow.

/** One Account's details as the store statement wants them. Names are this file's; `COLUMNS` has the column of each. */
export type AccountDetails = {
  akahuName: string
  akahuFormattedAccount: string | null
  akahuStatus: string
  akahuType: string
  /** Akahu's attributes, as a JSON array of words. */
  akahuAttributes: string | null
  akahuConnectionId: string
  akahuConnectionName: string
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
export const STORE_DETAILS = `UPDATE accounts SET ${entries.map(([key, column]) => `${column} = json_extract(?3, '$.${key}')`).join(', ')}
  WHERE id = ?1 AND akahu_account_id = ?2`

/** The SET list that clears them all, for the statement that unlinks or relinks an Account. */
export const CLEAR_DETAILS = entries.map(([, column]) => `${column} = NULL`).join(', ')

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
