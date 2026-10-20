import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import { HttpError } from './me'

/**
 * The Akahu accounts the Admin picks from when linking an Account (GET /api/akahu/accounts, worker/akahu-route.ts).
 *
 * Asking contacts Akahu, so this is never fetched as the page loads: the Account Link section enables it only when the Admin
 * asks to see the list (ADR 0010 keeps the Worker's outbound calls to what someone asked for). Nothing is stored by asking;
 * only the Account the Admin then links is ever synced (spec 31).
 */
export const akahuAccountsQuery = queryOptions({
  queryKey: ['akahu-accounts'],
  // One ask is one call to Akahu. A failure is shown with what to do about it rather than retried behind the Admin's back.
  retry: false,
  queryFn: async () => {
    const res = await api.akahu.accounts.$get()
    if (!res.ok) {
      // A 502 carries which of the three fixed reasons it was, so the page can say what to do about it rather than "it failed".
      const body: unknown = await res.json().catch(() => null)
      const reason = typeof body === 'object' && body !== null && 'reason' in body && typeof body.reason === 'string' ? body.reason : undefined
      throw new HttpError(res.status, reason)
    }
    return res.json()
  },
})

/**
 * What to tell the Admin when the list could not be read. The Worker answers one of three fixed reasons and never a word of
 * Akahu's, which can echo a token (worker/akahu.ts), so the wording is written here, where it can say what to do.
 */
export function describeAkahuFailure(reason: unknown): string {
  switch (reason) {
    case 'refused':
      return 'Akahu would not accept the tokens. Check AKAHU_APP_TOKEN and AKAHU_USER_TOKEN, and that the app is still connected in Akahu.'
    case 'unreadable':
      return 'Akahu answered with something Fernledger could not read. Try again; if it keeps happening, Akahu may have changed its API.'
    default:
      return 'Akahu could not be reached. Try again in a few minutes.'
  }
}

/** One Akahu account as the Admin sees it in the list: its name, and the account number Akahu formats, when it gives one. */
export const akahuAccountLabel = (account: { name: string; formatted_account?: string }) =>
  account.formatted_account ? `${account.name} (${account.formatted_account})` : account.name
