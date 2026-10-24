import { Hono } from 'hono'
import * as z from 'zod/mini'
import type { AppEnv } from './app-env'
import { recordChange } from './changelog'
import { criteriaBody, describeRule, fromTransactionBody, MAX_RULES, ruleBody, ruleRecord, toCriteria, type Criteria } from './rule-criteria'
import { ruleFromTransaction } from './rule-from-transaction'
import { previewStatements, type PreviewSample } from './rule-preview'
import { latestRerun, restartRerun, startRerun, stepRerun, stopRerun } from './rule-rerun'
import { CHANGED_MEANWHILE, nothing, pathId, validate } from './validate'

// Rules are applied to Transactions an Import adds (rule-apply.ts); saving, changing or removing a Rule here never
// touches a Transaction that is already stored, with one exception: a Rule made from a Transaction (rule-from-transaction.ts) gives its Category to the
// Uncategorised Transactions it matches, up to a limit. The Admin applies the Rules to all of those with a re-run (rule-rerun.ts),
// which is started and stepped from the routes at the end. A change to the Rules while a re-run is running sends it back
// to the start, so each change here carries `restartRerun` in its batch. Every change is one Change Log entry of type `rule`.

const orderBody = z.object({ ids: z.array(z.int().check(z.positive())).check(z.maxLength(MAX_RULES)) })

/** What a preview answers: how many Transactions match and the newest few; with `uncategorised` asked for, how many of them have no Category and no examples. */
type PreviewAnswer = { matches: number; samples: PreviewSample[]; uncategorised?: number }

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
const RULES_FULL = { error: `There are already ${MAX_RULES} Rules; remove one first` }

export const rules = new Hono<AppEnv>()
  .get('/', async (c) => c.json(await listRules(c.env.DB)))
  // How many Transactions on file a set of criteria matches, and the newest few, before the Admin saves anything (rule-preview.ts). With `uncategorised` it counts how many of
  // them have no Category instead of showing examples: the count Create Rule keeps up to date as the Admin types.
  .post('/preview', validate('json', criteriaBody), async (c) => {
    const body = c.req.valid('json')
    const criteria = toCriteria(body)
    if (body.uncategorised === true) {
      const [count] = await c.env.DB.batch(previewStatements(c.env.DB, criteria, { uncategorised: true }))
      const found = count!.results[0] as { matches: number; uncategorised: number }
      const preview: PreviewAnswer = { matches: found.matches, samples: [], uncategorised: found.uncategorised }
      return c.json(preview)
    }
    const [count, samples] = await c.env.DB.batch(previewStatements(c.env.DB, criteria))
    const preview: PreviewAnswer = { matches: (count!.results[0] as { matches: number }).matches, samples: samples!.results as PreviewSample[] }
    return c.json(preview)
  })
  // Create Rule, in the Edit panel of a Transaction (rule-from-transaction.ts): adds a Rule last, as POST / does, gives the Category to the other Uncategorised Transactions it
  // matches (up to a limit) and to this one, in one batch.
  .post('/from-transaction', validate('json', fromTransactionBody), async (c) => {
    const outcome = await ruleFromTransaction(c.env.DB, c.var.member, c.req.valid('json'))
    if (outcome.kind === 'no-transaction') return c.json({ error: 'Not found' }, 404)
    if (outcome.kind === 'bad-category') return c.json(badCategory, 400)
    if (outcome.kind === 'full') return c.json(RULES_FULL, 409)
    if (outcome.kind === 'changed') return c.json(CHANGED_MEANWHILE, 409)
    return c.json(outcome.made, 201)
  })
  // The new Rule goes last in priority; the Admin moves it up with PUT /order.
  .post('/', validate('json', ruleBody), async (c) => {
    const body = c.req.valid('json')
    const db = c.env.DB
    const category = await targetCategory(db, body.categoryId)
    if (category === null) return c.json(badCategory, 400)
    const inUse = (await db.prepare('SELECT COUNT(*) AS n FROM rules WHERE removed_at IS NULL').first<{ n: number }>())!.n
    if (inUse >= MAX_RULES) return c.json(RULES_FULL, 409)

    const criteria = toCriteria(body)
    const target = { category: category?.name ?? null, transfer: body.transfer === true }
    // The check above can be beaten by another request adding the last place first, so the INSERT checks the count again. It is the last statement (what `onlyIfChanged`
    // looks at): it adds a Rule, and logs it, only while there is room.
    const [, added] = await recordChange(
      db,
      [
        restartRerun(db),
        db
          .prepare(
            `INSERT INTO rules (position, text_contains, bank_type, direction, min_cents, max_cents, category_id, is_transfer)
             SELECT (SELECT COALESCE(MAX(position), 0) + 1 FROM rules WHERE removed_at IS NULL), ?, ?, ?, ?, ?, ?, ?
             WHERE (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) < ?`,
          )
          .bind(criteria.textContains, criteria.bankType, criteria.direction, criteria.minCents, criteria.maxCents, category?.id ?? null, target.transfer ? 1 : 0, MAX_RULES),
      ],
      { actor: c.var.member, type: 'rule', summary: `Added a Rule: ${describeRule(criteria, target)}`, after: ruleRecord(criteria, target), onlyIfChanged: true },
    )
    if (added!.meta.changes === 0) return c.json(RULES_FULL, 409)
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
    // Only if the Rules in use are still the ones that were read, in the order they were read in: another request can add, remove or move one between the read and the write,
    // and a Rule left out of the list would be given no place. The check is on the whole order at once (?2, the ids as read, against the Rules in use numbered in order by a window
    // function, which is exact where the order of a group_concat is only what SQLite happens to do), and the UPDATE is the last statement, which `onlyIfChanged` looks at.
    // Both lookups go by position in a JSON array, and each is written to cost one read per Rule: `UPDATE … FROM json_each` walks the list once (a correlated `SELECT … FROM json_each`
    // per Rule walks it once per Rule), and `json_extract` takes the n-th element directly (a `json_each` lookup per row walks it again). At 100 Rules that is about 800 rows read, not 10,600.
    const [, moved] = await recordChange(
      db,
      [
        restartRerun(db),
        db
          .prepare(
            `UPDATE rules SET position = j.key + 1 FROM json_each(?1) j
             WHERE rules.id = j.value AND rules.removed_at IS NULL
               AND (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) = json_array_length(?2)
               AND NOT EXISTS (
                 SELECT 1 FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM rules WHERE removed_at IS NULL) r
                 WHERE r.id IS NOT json_extract(?2, '$[' || (r.n - 1) || ']')
               )`,
          )
          .bind(JSON.stringify(ids), JSON.stringify(current.map((rule) => rule.id))),
      ],
      {
        actor: c.var.member,
        type: 'rule',
        summary: 'Changed the order of Rules',
        before: { order: current.map(numbered) },
        after: { order: ids.map((id, i) => numbered(byId.get(id)!, i)) },
        onlyIfChanged: true,
      },
    )
    if (moved!.meta.changes === 0) {
      const now = (await listRules(db)).map((rule) => rule.id)
      return now.length === ids.length && now.every((id, i) => id === ids[i]) ? c.json({ ids }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ ids })
  })
  .put('/:id', validate('json', ruleBody), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const body = c.req.valid('json')
    const db = c.env.DB
    const rule = await findRule(db, id)
    if (!rule) return c.json({ error: 'Not found' }, 404)
    const category = await targetCategory(db, body.categoryId)
    if (category === null) return c.json(badCategory, 400)

    const criteria = toCriteria(body)
    const next: RuleView = { id, ...criteria, categoryId: category?.id ?? null, categoryName: category?.name ?? null, categoryRemoved: false, transfer: body.transfer === true }
    if (sameRule(rule, next)) return c.json({ id })

    // Only over the Rule that was read, still in use and with the criteria it was read with (`IS` is `=` that also matches NULL): another request can remove or change it
    // between the read and the write, and the entry must not say it changed from what it no longer was. The UPDATE is the last statement, which `onlyIfChanged` looks at.
    // Whether it marks a Transfer is not compared: a Rule has a Category or marks a Transfer and never both (migrations/1301_rules.sql), so the Category says it.
    const [, changed] = await recordChange(
      db,
      [
        restartRerun(db),
        db
          .prepare(
            `UPDATE rules SET text_contains = ?1, bank_type = ?2, direction = ?3, min_cents = ?4, max_cents = ?5, category_id = ?6, is_transfer = ?7
             WHERE id = ?8 AND removed_at IS NULL AND text_contains IS ?9 AND bank_type IS ?10 AND direction IS ?11 AND min_cents IS ?12 AND max_cents IS ?13 AND category_id IS ?14`,
          )
          .bind(
            criteria.textContains,
            criteria.bankType,
            criteria.direction,
            criteria.minCents,
            criteria.maxCents,
            next.categoryId,
            next.transfer ? 1 : 0,
            id,
            rule.textContains,
            rule.bankType,
            rule.direction,
            rule.minCents,
            rule.maxCents,
            rule.categoryId,
          ),
      ],
      { actor: c.var.member, type: 'rule', summary: `Changed a Rule: ${describe(next)}`, before: record(rule), after: record(next), onlyIfChanged: true },
    )
    if (changed!.meta.changes === 0) {
      const now = await findRule(db, id)
      if (!now) return c.json({ error: 'Not found' }, 404)
      return sameRule(now, next) ? c.json({ id }) : c.json(CHANGED_MEANWHILE, 409)
    }
    return c.json({ id })
  })
  // Removing keeps the row (see migrations/1301_rules.sql): Transactions it categorised point at it, and the Change Log keeps its details.
  .delete('/:id', validate('json', nothing), async (c) => {
    const id = pathId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Not found' }, 404)
    const db = c.env.DB
    const rule = await findRule(db, id)
    if (!rule) return c.json({ error: 'Not found' }, 404)

    // The UPDATE is the last statement, which `onlyIfChanged` looks at: if another request removed the Rule first, this one wrote nothing, logs nothing and answers as it does
    // for a Rule that is not there.
    const [, removed] = await recordChange(db, [restartRerun(db), db.prepare("UPDATE rules SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND removed_at IS NULL").bind(id)], {
      actor: c.var.member,
      type: 'rule',
      summary: `Removed a Rule: ${describe(rule)}`,
      before: record(rule),
      onlyIfChanged: true,
    })
    if (removed!.meta.changes === 0) return c.json({ error: 'Not found' }, 404)
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
