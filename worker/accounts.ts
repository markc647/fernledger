import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName, isoDate } from './account-fields'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { validate } from './validate'

type AccountRow = { id: number; name: string; accountNumber: string; cutoverDate: string | null }

const rename = z.object({ name: accountName })
const cutover = z.object({ cutoverDate: z.nullable(isoDate) })

export const accounts = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT id, name, account_number AS accountNumber, cutover_date AS cutoverDate FROM accounts ORDER BY name COLLATE NOCASE, id').all<AccountRow>()
    return c.json(results)
  })
  .patch('/:id', validate('json', rename), async (c) => {
    const id = Number(c.req.param('id'))
    const { name } = c.req.valid('json')
    const db = c.env.DB
    const account = Number.isSafeInteger(id) ? await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(id).first<{ name: string }>() : null
    if (!account) return c.json({ error: 'Not found' }, 404)

    await recordChange(db, db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id), {
      actor: c.var.member,
      summary: `Renamed Account ${account.name} to ${name}`,
      before: { name: account.name },
      after: { name },
    })
    return c.json({ id, name })
  })
  // The Cutover Date (ADR 0003): Import drops rows dated on or after it. Setting it deletes nothing already saved.
  .put('/:id/cutover-date', validate('json', cutover), async (c) => {
    const id = Number(c.req.param('id'))
    const { cutoverDate } = c.req.valid('json')
    const db = c.env.DB
    const account = Number.isSafeInteger(id) ? await db.prepare('SELECT name, cutover_date FROM accounts WHERE id = ?').bind(id).first<{ name: string; cutover_date: string | null }>() : null
    if (!account) return c.json({ error: 'Not found' }, 404)

    await recordChange(db, db.prepare('UPDATE accounts SET cutover_date = ? WHERE id = ?').bind(cutoverDate, id), {
      actor: c.var.member,
      summary: cutoverDate === null ? `Cleared the Cutover Date for ${account.name}` : `Set the Cutover Date for ${account.name} to ${cutoverDate}`,
      before: { cutoverDate: account.cutover_date },
      after: { cutoverDate },
    })
    return c.json({ id, cutoverDate })
  })
