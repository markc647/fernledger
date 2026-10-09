export type TransactionsChange = { accountId: number }
type Hook = (db: D1Database, change: TransactionsChange) => Promise<void>

/**
 * What runs after an Account's Transactions change (an Import so far). Empty for now: Transfer pairing and the
 * Balance Check will push their hooks here when they land.
 */
export const transactionsChangedHooks: Hook[] = []

export async function afterTransactionsChanged(db: D1Database, change: TransactionsChange): Promise<void> {
  for (const hook of transactionsChangedHooks) await hook(db, change)
}
