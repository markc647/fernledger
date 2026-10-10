import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { CATEGORY_KINDS, KIND_LABELS, type CategoryKind } from './category-kinds'
import { recordChange } from './changelog'
import { restartRerun } from './rule-rerun'
import { nothing, validate } from './validate'

type CategoryRow = { id: number; name: string; kind: CategoryKind }

/** A Category's name as the Admin types it (trimmed, 1 to 40 characters). */
export const categoryName = z.string().check(z.trim(), z.minLength(1), z.maxLength(40))

const kind = z.enum(CATEGORY_KINDS)
const body = z.object({ name: categoryName })
/** A new Category is Spending unless the Admin says otherwise (ADR 0012). */
const addBody = z.object({ name: categoryName, kind: z.optional(kind) })
const kindBody = z.object({ kind })

const isDuplicateName = (error: unknown) => error instanceof Error && error.message.includes('UNIQUE constraint failed')
const alreadyThere = { error: 'A Category with that name already exists' }

/** A Category that is in use. A removed one is gone as far as the API is concerned (see migrations/1101_categories.sql). */
export const findCategory = (db: D1Database, id: number) =>
  Number.isSafeInteger(id) ? db.prepare('SELECT id, name, kind FROM categories WHERE id = ? AND removed_at IS NULL').bind(id).first<CategoryRow>() : null

export const categories = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT id, name, kind FROM categories WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE, id').all<CategoryRow>()
    return c.json(results)
  })
  .post('/', validate('json', addBody), async (c) => {
    const { name, kind: chosen } = c.req.valid('json')
    const kind = chosen ?? 'spending'
    const db = c.env.DB
    try {
      const [added] = await recordChange(db, db.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)').bind(name, kind), {
        actor: c.var.member,
        type: 'category',
        summary: `Added Category ${name}`,
        after: { name, kind: KIND_LABELS[kind] },
      })
      return c.json({ id: added!.meta.last_row_id, name, kind }, 201)
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
    if (category.name === name) return c.json({ id, name, kind: category.kind })

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
    return c.json({ id, name, kind: category.kind })
  })
  // What the Category is for (ADR 0012). Changing it changes how its Transactions are totalled from now on, in every month: nothing is stored per Transaction.
  .put('/:id/kind', validate('json', kindBody), async (c) => {
    const id = Number(c.req.param('id'))
    const { kind } = c.req.valid('json')
    const db = c.env.DB
    const category = await findCategory(db, id)
    if (!category) return c.json({ error: 'Not found' }, 404)
    if (category.kind === kind) return c.json({ id, name: category.name, kind })

    await recordChange(db, db.prepare('UPDATE categories SET kind = ? WHERE id = ?').bind(kind, id), {
      actor: c.var.member,
      type: 'category',
      summary: `Changed the kind of Category ${category.name} from ${KIND_LABELS[category.kind]} to ${KIND_LABELS[kind]}`,
      before: { name: category.name, kind: KIND_LABELS[category.kind] },
      after: { name: category.name, kind: KIND_LABELS[kind] },
    })
    return c.json({ id, name: category.name, kind })
  })
  // Removing keeps the row (see migrations/1101_categories.sql), so it is one write however many Transactions use the Category.
  // Those Transactions lose that Override: each falls back to its Rule or Akahu category, or is Uncategorised if neither applies.
  .delete('/:id', validate('json', nothing), async (c) => {
    const id = Number(c.req.param('id'))
    const db = c.env.DB
    const category = await findCategory(db, id)
    if (!category) return c.json({ error: 'Not found' }, 404)
    const used = await db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE override_category = ?').bind(id).first<{ n: number }>()
    const overrides = used?.n ?? 0

    // A Rule whose Category is removed no longer counts (rule-apply.ts), so a re-run that is running would have to look at its Transactions again.
    await recordChange(db, [db.prepare("UPDATE categories SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(id), restartRerun(db)], {
      actor: c.var.member,
      type: 'category',
      summary: `Removed Category ${category.name}`,
      before: { name: category.name, overrides },
    })
    return c.json({ id, name: category.name, overrides })
  })
