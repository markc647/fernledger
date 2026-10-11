import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName, isoDate } from './account-fields'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { CHANGED_MEANWHILE, pathId, validate } from './validate'

type AccountRow = { id: number; name: string; accountNumber: string; cutoverDate: string | null }

const rename = z.object({ name: accountName })
const cutover = z.object({ cutoverDate: z.nullable(isoDate) })

export const accounts = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT id, name, account_number AS accountNumber, cutover_date AS cutoverDate FROM accounts ORDER BY name COLLATE NOCASE, id').all<AccountRow>()
    return c.json(results)
  })
  .patch('/:id', validate('json', rename), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const { name } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(id).first<{ name: string }>()
    if (!account) return c.json({ error: 'Not found' }, 404)
    if (account.name === name) return c.json({ id, name })

    // Only over the name that was read, and an entry only if it changed something (`onlyIfChanged`): another request can land between the read and the write, and the
    // Change Log must not say the Account was renamed from a name it no longer had.
    const [update] = await recordChange(db, db.prepare('UPDATE accounts SET name = ?1 WHERE id = ?2 AND name = ?3').bind(name, id, account.name), {
      actor: c.var.member,
      type: 'account',
      summary: `Renamed Account ${account.name} to ${name}`,
      before: { name: account.name },
      after: { name },
      onlyIfChanged: true,
    })
    if (update!.meta.changes === 0) {
      const now = await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(id).first<{ name: string }>()
      if (!now) return c.json({ error: 'Not found' }, 404)
      return now.name === name ? c.json({ id, name }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ id, name })
  })
  // The Cutover Date (ADR 0003): Import drops rows dated on or after it. Setting it deletes nothing already saved.
  .put('/:id/cutover-date', validate('json', cutover), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const { cutoverDate } = c.req.valid('json')
    const db = c.env.DB
    const account = await db.prepare('SELECT name, cutover_date FROM accounts WHERE id = ?').bind(id).first<{ name: string; cutover_date: string | null }>()
    if (!account) return c.json({ error: 'Not found' }, 404)
    if (account.cutover_date === cutoverDate) return c.json({ id, cutoverDate })

    // As the rename is: only over the date that was read (`IS` is `=` that also matches NULL), and an entry only if it changed something.
    const [update] = await recordChange(db, db.prepare('UPDATE accounts SET cutover_date = ?1 WHERE id = ?2 AND cutover_date IS ?3').bind(cutoverDate, id, account.cutover_date), {
      actor: c.var.member,
      type: 'account',
      summary: cutoverDate === null ? `Cleared the Cutover Date for ${account.name}` : `Set the Cutover Date for ${account.name} to ${cutoverDate}`,
      before: { cutoverDate: account.cutover_date },
      after: { cutoverDate },
      onlyIfChanged: true,
    })
    if (update!.meta.changes === 0) {
      const now = await db.prepare('SELECT cutover_date FROM accounts WHERE id = ?').bind(id).first<{ cutover_date: string | null }>()
      if (!now) return c.json({ error: 'Not found' }, 404)
      return now.cutover_date === cutoverDate ? c.json({ id, cutoverDate }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ id, cutoverDate })
  })
