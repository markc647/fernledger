export type TransactionsChange = { accountId: number }

/**
 * Called after each committed change to an Account's Transactions (every Import chunk, so it may run more than once
 * per Import). Nothing yet: Transfer pairing will be called from here when it lands. The Balance Check is not: it needs
 * the whole Import, so it runs after the last chunk (balance-check.ts).
 */
export async function afterTransactionsChanged(_db: D1Database, _change: TransactionsChange): Promise<void> {}
