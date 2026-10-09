import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { validate } from './validate'

export const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

const digits = z.optional(z.string().check(z.regex(/^\d{1,9}$/)))
const pageQuery = z.object({ limit: digits, offset: digits })

type TransactionListRow = {
  id: number
  accountId: number
  accountName: string
  date: string
  description: string
  bankType: string
  amountCents: number
}

/** The basic list every Member can read: newest first, a page at a time. */
export const transactions = new Hono<AppEnv>().get('/', validate('query', pageQuery), async (c) => {
  const query = c.req.valid('query')
  const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)
  const offset = Number(query.offset ?? 0)
  const db = c.env.DB
  const [count, page] = await db.batch([
    db.prepare('SELECT COUNT(*) AS total FROM transactions'),
    db
      .prepare(
        `SELECT t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.description, t.bank_type AS bankType, t.amount_cents AS amountCents
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset),
  ])
  return c.json({ total: (count!.results[0] as { total: number }).total, transactions: page!.results as TransactionListRow[] })
})
