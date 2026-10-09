import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { validate } from './validate'

type CategoryRow = { id: number; name: string }

/** A Category's name as the Admin types it (trimmed, 1 to 40 characters). */
export const categoryName = z.string().check(z.trim(), z.minLength(1), z.maxLength(40))

const body = z.object({ name: categoryName })
const nothing = z.object({})

const isDuplicateName = (error: unknown) => error instanceof Error && error.message.includes('UNIQUE constraint failed')
const alreadyThere = { error: 'A Category with that name already exists' }

/** A Category that is in use. A removed one is gone as far as the API is concerned (see migrations/1101_categories.sql). */
const findCategory = (db: D1Database, id: number) =>
  Number.isSafeInteger(id) ? db.prepare('SELECT id, name FROM categories WHERE id = ? AND removed_at IS NULL').bind(id).first<CategoryRow>() : null

export const categories = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT id, name FROM categories WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE, id').all<CategoryRow>()
    return c.json(results)
  })
  .post('/', validate('json', body), async (c) => {
    const { name } = c.req.valid('json')
    const db = c.env.DB
    try {
      const [added] = await recordChange(db, db.prepare('INSERT INTO categories (name) VALUES (?)').bind(name), {
        actor: c.var.member,
        type: 'category',
        summary: `Added Category ${name}`,
        after: { name },
      })
      return c.json({ id: added!.meta.last_row_id, name }, 201)
    } catch (error) {
      if (isDuplicateName(error)) return c.json(alreadyThere, 409)
      throw error
    }
  })
  .patch('/:id', validate('json', body), async (c) => {
    const id = Number(c.req.param('id'))
    const { name } = c.req.valid('json')
    const db = c.env.DB
    const category = await findCategory(db, id)
    if (!category) return c.json({ error: 'Not found' }, 404)
    if (category.name === name) return c.json({ id, name })

    try {
      await recordChange(db, db.prepare('UPDATE categories SET name = ? WHERE id = ?').bind(name, id), {
        actor: c.var.member,
        type: 'category',
        summary: `Renamed Category ${category.name} to ${name}`,
        before: { name: category.name },
        after: { name },
      })
    } catch (error) {
      if (isDuplicateName(error)) return c.json(alreadyThere, 409)
      throw error
    }
    return c.json({ id, name })
  })
  // Removing keeps the row (see migrations/1101_categories.sql), so it is one write however many Transactions use the Category.
  .delete('/:id', validate('json', nothing), async (c) => {
    const id = Number(c.req.param('id'))
    const db = c.env.DB
    const category = await findCategory(db, id)
    if (!category) return c.json({ error: 'Not found' }, 404)
    const used = await db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE override_category = ?').bind(id).first<{ n: number }>()
    const overrides = used?.n ?? 0

    await recordChange(db, db.prepare("UPDATE categories SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(id), {
      actor: c.var.member,
      type: 'category',
      summary: `Removed Category ${category.name}`,
      before: { name: category.name, overrides },
    })
    return c.json({ id, name: category.name, overrides })
  })
