import { Hono } from 'hono'
import * as z from 'zod/mini'
import { accountName } from './account-fields'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { validate } from './validate'

type AccountRow = { id: number; name: string; accountNumber: string }

const rename = z.object({ name: accountName })

export const accounts = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT id, name, account_number AS accountNumber FROM accounts ORDER BY name COLLATE NOCASE, id').all<AccountRow>()
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
