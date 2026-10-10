import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { criteriaBody, describeRule, MAX_RULES, ruleBody, ruleRecord, toCriteria, type Criteria } from './rule-criteria'
import { previewStatements, type PreviewSample } from './rule-preview'
import { latestRerun, restartRerun, startRerun, stepRerun, stopRerun } from './rule-rerun'
import { validate } from './validate'

// Rules are applied to Transactions an Import adds (rule-apply.ts); saving, changing or removing a Rule here never
// touches a Transaction that is already stored. The Admin applies the Rules to all of those with a re-run (rule-rerun.ts),
// which is started and stepped from the routes at the end. A change to the Rules while a re-run is running sends it back
// to the start, so each change here carries `restartRerun` in its batch. Every change is one Change Log entry of type `rule`.

const orderBody = z.object({ ids: z.array(z.int().check(z.positive())).check(z.maxLength(MAX_RULES)) })
const nothing = z.object({})

type RuleView = Criteria & { id: number; categoryId: number | null; categoryName: string | null; categoryRemoved: boolean; transfer: boolean }
type RuleRow = Omit<RuleView, 'categoryRemoved' | 'transfer'> & { categoryRemoved: number; transfer: number }

// A removed Category still names its Rule's target, so the Rule is listed with that name and flagged.
const SELECT_RULES = `
  SELECT r.id, r.text_contains AS textContains, r.bank_type AS bankType, r.direction, r.min_cents AS minCents, r.max_cents AS maxCents,
         r.category_id AS categoryId, c.name AS categoryName, c.removed_at IS NOT NULL AS categoryRemoved, r.is_transfer AS transfer
  FROM rules r LEFT JOIN categories c ON c.id = r.category_id
  WHERE r.removed_at IS NULL`

const view = (row: RuleRow): RuleView => ({ ...row, categoryRemoved: row.categoryRemoved === 1, transfer: row.transfer === 1 })

/** The Rules in use, in priority order. At most MAX_RULES. */
const listRules = async (db: D1Database) => (await db.prepare(`${SELECT_RULES} ORDER BY r.position, r.id`).all<RuleRow>()).results.map(view)

const findRule = async (db: D1Database, id: number) => {
  const row = Number.isSafeInteger(id) ? await db.prepare(`${SELECT_RULES} AND r.id = ?`).bind(id).first<RuleRow>() : null
  return row ? view(row) : null
}

const criteriaOf = (rule: Criteria): Criteria => ({ textContains: rule.textContains, bankType: rule.bankType, direction: rule.direction, minCents: rule.minCents, maxCents: rule.maxCents })
const describe = (rule: RuleView) => describeRule(criteriaOf(rule), { category: rule.categoryName, transfer: rule.transfer })
// The Change Log page joins a list with commas and a Rule's own words have commas, so each place in an order is numbered.
const numbered = (rule: RuleView, i: number) => `${i + 1}. ${describe(rule)}`
const record = (rule: RuleView) => ruleRecord(criteriaOf(rule), { category: rule.categoryName, transfer: rule.transfer })

const sameRule = (a: RuleView, b: RuleView) =>
  a.textContains === b.textContains && a.bankType === b.bankType && a.direction === b.direction && a.minCents === b.minCents && a.maxCents === b.maxCents && a.categoryId === b.categoryId && a.transfer === b.transfer

/** Looks up the Category a request names. `undefined` when it names none, `null` when it names one that is not in use. */
async function targetCategory(db: D1Database, categoryId: number | null | undefined) {
  if (categoryId == null) return undefined
  return (await db.prepare('SELECT id, name FROM categories WHERE id = ? AND removed_at IS NULL').bind(categoryId).first<{ id: number; name: string }>()) ?? null
}

const badCategory = { error: 'Invalid request', field: 'categoryId' }

export const rules = new Hono<AppEnv>()
  .get('/', async (c) => c.json(await listRules(c.env.DB)))
  // How many Transactions on file a set of criteria matches, and the newest few, before the Admin saves anything (rule-preview.ts).
  .post('/preview', validate('json', criteriaBody), async (c) => {
    const [count, samples] = await c.env.DB.batch(previewStatements(c.env.DB, toCriteria(c.req.valid('json'))))
    return c.json({ matches: (count!.results[0] as { matches: number }).matches, samples: samples!.results as PreviewSample[] })
  })
  // The new Rule goes last in priority; the Admin moves it up with PUT /order.
  .post('/', validate('json', ruleBody), async (c) => {
    const body = c.req.valid('json')
    const db = c.env.DB
    const category = await targetCategory(db, body.categoryId)
    if (category === null) return c.json(badCategory, 400)
    const inUse = (await db.prepare('SELECT COUNT(*) AS n FROM rules WHERE removed_at IS NULL').first<{ n: number }>())!.n
    if (inUse >= MAX_RULES) return c.json({ error: `There are already ${MAX_RULES} Rules; remove one first` }, 409)

    const criteria = toCriteria(body)
    const target = { category: category?.name ?? null, transfer: body.transfer === true }
    const [added] = await recordChange(
      db,
      [
        db
          .prepare(
            `INSERT INTO rules (position, text_contains, bank_type, direction, min_cents, max_cents, category_id, is_transfer)
             VALUES ((SELECT COALESCE(MAX(position), 0) + 1 FROM rules WHERE removed_at IS NULL), ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(criteria.textContains, criteria.bankType, criteria.direction, criteria.minCents, criteria.maxCents, category?.id ?? null, target.transfer ? 1 : 0),
        restartRerun(db),
      ],
      { actor: c.var.member, type: 'rule', summary: `Added a Rule: ${describeRule(criteria, target)}`, after: ruleRecord(criteria, target) },
    )
    return c.json({ id: added!.meta.last_row_id }, 201)
  })
  // Registered before `/:id`, which would take "order" for an ID. The list must be exactly the Rules in use, so a page
  // that was open while another changed them cannot drop a Rule from the order or bring a removed one back.
  .put('/order', validate('json', orderBody), async (c) => {
    const { ids } = c.req.valid('json')
    const db = c.env.DB
    const current = await listRules(db)
    const isTheRulesInUse = ids.length === current.length && new Set(ids).size === ids.length && current.every((rule) => ids.includes(rule.id))
    if (!isTheRulesInUse) return c.json({ error: 'Invalid request', field: 'ids' }, 400)
    if (ids.every((id, i) => id === current[i]!.id)) return c.json({ ids })

    const byId = new Map(current.map((rule) => [rule.id, rule]))
    await recordChange(db, [db.prepare('UPDATE rules SET position = (SELECT j.key + 1 FROM json_each(?1) j WHERE j.value = rules.id) WHERE removed_at IS NULL').bind(JSON.stringify(ids)), restartRerun(db)], {
      actor: c.var.member,
      type: 'rule',
      summary: 'Changed the order of Rules',
      before: { order: current.map(numbered) },
      after: { order: ids.map((id, i) => numbered(byId.get(id)!, i)) },
    })
    return c.json({ ids })
  })
  .put('/:id', validate('json', ruleBody), async (c) => {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const db = c.env.DB
    const rule = await findRule(db, id)
    if (!rule) return c.json({ error: 'Not found' }, 404)
    const category = await targetCategory(db, body.categoryId)
    if (category === null) return c.json(badCategory, 400)

    const criteria = toCriteria(body)
    const next: RuleView = { id, ...criteria, categoryId: category?.id ?? null, categoryName: category?.name ?? null, categoryRemoved: false, transfer: body.transfer === true }
    if (sameRule(rule, next)) return c.json({ id })

    await recordChange(
      db,
      [
        db
          .prepare('UPDATE rules SET text_contains = ?, bank_type = ?, direction = ?, min_cents = ?, max_cents = ?, category_id = ?, is_transfer = ? WHERE id = ? AND removed_at IS NULL')
          .bind(criteria.textContains, criteria.bankType, criteria.direction, criteria.minCents, criteria.maxCents, next.categoryId, next.transfer ? 1 : 0, id),
        restartRerun(db),
      ],
      { actor: c.var.member, type: 'rule', summary: `Changed a Rule: ${describe(next)}`, before: record(rule), after: record(next) },
    )
    return c.json({ id })
  })
  // Removing keeps the row (see migrations/1301_rules.sql): Transactions it categorised point at it, and the Change Log keeps its details.
  .delete('/:id', validate('json', nothing), async (c) => {
    const id = Number(c.req.param('id'))
    const db = c.env.DB
    const rule = await findRule(db, id)
    if (!rule) return c.json({ error: 'Not found' }, 404)

    await recordChange(db, [db.prepare("UPDATE rules SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND removed_at IS NULL").bind(id), restartRerun(db)], {
      actor: c.var.member,
      type: 'rule',
      summary: `Removed a Rule: ${describe(rule)}`,
      before: record(rule),
    })
    return c.json({ id })
  })
  // Applying the Rules to the Transactions already on file (rule-rerun.ts): start a run, then step it, one chunk a request, until
  // it says it is done (or paused until D1's day changes), or stop it. The Rules page does all of it. The latest run, running or
  // ended, is readable by every Member like the Rules.
  .get('/rerun', async (c) => c.json({ job: await latestRerun(c.env.DB) }))
  .post('/rerun', validate('json', nothing), async (c) => {
    const job = await startRerun(c.env.DB, c.var.member)
    return job ? c.json({ job }, 201) : c.json({ error: 'A re-run is already in progress' }, 409)
  })
  .post('/rerun/step', validate('json', nothing), async (c) => c.json({ job: await stepRerun(c.env.DB) }))
  .post('/rerun/stop', validate('json', nothing), async (c) => {
    const job = await stopRerun(c.env.DB, c.var.member)
    return job ? c.json({ job }) : c.json({ error: 'No re-run is in progress' }, 409)
  })
