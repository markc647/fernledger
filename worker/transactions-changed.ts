export type TransactionsChange = {
  accountId: number
  /**
   * The highest Transaction ID before the change (`lastTransactionId`, read before writing), so every Transaction above
   * it in this Account is one the change added. Leave it out when the change added none.
   */
  afterId?: number
}

/** The highest Transaction ID, or 0 when there are none. Read it before a change that adds Transactions, to pass as `afterId`. */
export const lastTransactionId = async (db: D1Database) => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM transactions').first<{ id: number }>())!.id

/**
 * Called after each committed change to an Account's Transactions (every Import chunk, so it may run more than once
 * per Import). Nothing yet: Transfer pairing will be called from here when it lands. The Balance Check is not: it needs
 * the whole Import, so it runs after the last chunk (balance-check.ts). Nor are the Rules: they are applied inside the
 * change's own batch (rule-apply.ts), so a Transaction and its Rule result commit together.
 */
export async function afterTransactionsChanged(_db: D1Database, _change: TransactionsChange): Promise<void> {}
