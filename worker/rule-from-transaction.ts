// Making a Rule from a Transaction: the Edit panel's Create Rule. The Admin has a Transaction in front of them, has chosen its Category, and wants every Transaction like it to
// have that Category. In one D1 batch (so the Rule and what it did commit together or not at all) this
//   1. adds the Rule, last in the order, as Add a Rule does (rules.ts), and sends a re-run that is going back to the start (rule-rerun.ts);
//   2. gives the Category to the other Transactions that have no Category and that the Rule would be the first to match, now, as if the Rules had been applied to them;
//   3. gives the Category to this Transaction: by the Rule if the Rule gives it (it is Uncategorised, the Rule matches it and no earlier Rule does), so it is a Rule's Category
//      like the others; and as an Override, as Save would, if not (the text was edited so that it no longer matches, an earlier Rule matches it, or it has a Category already).
//
// "Mirror what applying the Rules does" (rule-apply.ts, rule-rerun.ts): a Transaction's Rule result is `rule_id`, `rule_category` and `rule_transfer`, set from the first Rule that
// counts and matches. The new Rule is last, so it is the first to match a Transaction exactly when no other Rule counts and matches it (`firstMatchingRule`, the one definition,
// shared with Import and the re-run). What this never touches: an Override (`override_category`), a Transaction that already has a Category from a Rule, a Transfer. Those
// are not Uncategorised (effective-category.ts, the one definition: the Uncategorised page lists the Transactions this gives the Category to). A Transaction an earlier Rule matches
// but that has not had the Rules applied since (it is stored as Uncategorised) is left for the re-run too, which would give it the earlier Rule's Category, not this one's.
//
// Free plan (ADR 0004): how much it can write is bounded, because the rows it gives the Category to are written now, in the request. At most MAX_INLINE_APPLY other Transactions
// are: 500 Transactions are about 1,500 of the day's 100,000 rows written (at most 3 each, as the re-run budgets them) and, at the most there can be, 100 Rules and so about 55,000 of its
// 5 million read. With more than that to give the Category to, the Rule and this Transaction are saved, nothing else is, and the answer says how many more match, so the page can
// send the Admin to Apply the Rules to all Transactions, which keeps to its own share of the day. The reads are:
//   - one query for the Category, the Rules in use, this Transaction and up to MAX_INLINE_APPLY + 1 of the others, which reads each Transaction at most once and stops once it has
//     found that many (rule-preview.ts: the one pass over the Transactions is what a search for text costs, there being no index on it);
//   - when there are more, one count of them (a second pass), and otherwise one look at the (at most MAX_INLINE_APPLY) it found, for which of them an earlier Rule matches;
//   - the batch: nothing is walked, the Transactions are named by ID.
// Queries: the batch of reads, one more, and the batch of writes (at most 7 statements); the request's 50 queries are not close (rule-from-transaction.test.ts pins them).
//
// Another request can land between the reads and the batch. The Rule is added only while there is room and its Category is in use, the Override only over the Override that was read
// and only while there is room too, so a request whose reads went stale adds nothing and answers 409 (the last place taken) or 400 (the Category removed). The Transactions are given the
// Category only if the Rule was added, and only if each is still Uncategorised, so an Override the Admin set meanwhile is never replaced. The count in the Change Log is how many were read
// as Uncategorised; the answer's is how many were written, and the two differ only if the Admin changed one of those Transactions in the moments between.
import type { Member } from './auth'
import { changeLogStatement, recordChange, type ChangeEntry } from './changelog'
import { effectiveCategory } from './effective-category'
import { firstMatchingRule } from './rule-apply'
import { describeRule, MAX_RULES, ruleMatches, ruleRecord, type Criteria } from './rule-criteria'
import { restartRerun } from './rule-rerun'
import { describe as describeTransaction } from './transactions'

/** The most other Transactions a Rule made from a Transaction gives the Category to in the request. More are left to Apply the Rules to all Transactions. */
export const MAX_INLINE_APPLY = 500

export type FromTransaction = { transactionId: number; textContains: string; direction?: 'in' | 'out' | null; categoryId: number }

/** Why this Transaction was given the Category as an Override and not by the Rule. */
export type OverrideBecause = 'no-match' | 'earlier-rule' | 'categorised'

export type RuleFromTransaction = {
  /** The Rule's ID, and its place in the order (Rule 7). */
  id: number
  number: number
  /** How many Transactions the Rule gave the Category to: the others it found, and this one if the Rule gave it. */
  categorised: number
  thisBy: 'rule' | 'override'
  overrideBecause: OverrideBecause | null
  /** How many other Uncategorised Transactions the Rule matches that were left for Apply the Rules to all Transactions; null when none were. */
  moreUncategorised: number | null
}

export type MadeRule = { kind: 'made'; made: RuleFromTransaction } | { kind: 'no-transaction' } | { kind: 'bad-category' } | { kind: 'full' }

const category = effectiveCategory()
// The criteria are not saved, so they stand in for a `rules` row under the same column names (as rule-preview.ts does): the text (?1) and which way the money went (?2).
const WANT = '(SELECT ?1 AS text_contains, NULL AS bank_type, ?2 AS direction, NULL AS min_cents, NULL AS max_cents) want'
const UNCATEGORISED = `${category.id} IS NULL AND NOT ${category.isTransfer}`

// This Transaction, ?3: whether the text matches it, whether it is Uncategorised, and whether a Rule that is in use matches it already.
const THIS_ONE = `
  SELECT t.id, t.date, t.description, t.override_category AS overrideCategory,
         (SELECT name FROM categories WHERE id = t.override_category AND removed_at IS NULL) AS overrideName,
         ${ruleMatches('want', 't')} AS matches, (${UNCATEGORISED}) AS uncategorised, ${firstMatchingRule('t')} IS NOT NULL AS earlierRule
  FROM ${WANT} CROSS JOIN transactions t ${category.joins}
  WHERE t.id = ?3`

// The other Transactions the text matches that are Uncategorised, one more than can be given the Category now, in whatever order the pass over the Transactions finds them.
// The criteria come first and `CROSS JOIN` keeps them there: put after the Transactions' Category joins, the planner reads them again for every Transaction (twice the reads).
const OTHERS_FROM = `FROM ${WANT} CROSS JOIN transactions t ${category.joins} WHERE t.id <> ?3 AND ${ruleMatches('want', 't')} AND ${UNCATEGORISED}`
const OTHERS = `SELECT t.id ${OTHERS_FROM} LIMIT ${MAX_INLINE_APPLY + 1}`
const COUNT_OTHERS = `SELECT COUNT(*) AS n ${OTHERS_FROM}`

// Of the Transactions named in ?1 (a JSON array of IDs), the ones that no Rule in use matches: the new Rule, being last, would be the first to match them.
const NO_EARLIER_RULE = `SELECT t.id FROM transactions t WHERE t.id IN (SELECT value FROM json_each(?1)) AND ${firstMatchingRule('t')} IS NULL`

// Adds the Rule last, as Add a Rule does (rules.ts), only while there is room and its Category (?5) is in use. ?1 text, ?2 direction, ?3 Category, ?4 the most Rules.
const ADD_RULE = `
  INSERT INTO rules (position, text_contains, bank_type, direction, min_cents, max_cents, category_id, is_transfer)
  SELECT (SELECT COALESCE(MAX(position), 0) + 1 FROM rules WHERE removed_at IS NULL), ?1, NULL, ?2, NULL, NULL, ?3, 0
  WHERE (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) < ?4 AND EXISTS (SELECT 1 FROM categories WHERE id = ?3 AND removed_at IS NULL)`

// This Transaction's Override, as Save sets it (transactions.ts): over the Override that was read (?3, `IS` is `=` that also matches NULL), with the Category (?1) in use, and only
// while there is room for the Rule (?4), so a request that is to be refused changes nothing.
const SET_OVERRIDE = `
  UPDATE transactions SET override_category = ?1
  WHERE id = ?2 AND override_category IS ?3 AND EXISTS (SELECT 1 FROM categories WHERE id = ?1 AND removed_at IS NULL)
    AND (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) < ?4`

// The Rule's result on the Transactions named in ?1 (a JSON array of IDs), as the re-run stores it (rule-rerun.ts WALK) for a Rule that gives a Category: the Rule's ID, its Category
// (?2) and no Transfer mark. It runs right after the Change Log entry of the Rule, which is written only if the Rule was added, so `changes()` is 1 only then, and the Rule is the newest
// (an ID never goes back, and nothing else runs between the statements of a batch). A Transaction that has a Category by now is left alone.
const GIVE_CATEGORY = `
  UPDATE transactions SET rule_id = (SELECT MAX(id) FROM rules), rule_category = ?2, rule_transfer = NULL
  WHERE changes() > 0
    AND id IN (SELECT t.id FROM transactions t ${category.joins} WHERE t.id IN (SELECT value FROM json_each(?1)) AND ${UNCATEGORISED})`

type ThisOne = { id: number; date: string; description: string; overrideCategory: number | null; overrideName: string | null; matches: number; uncategorised: number; earlierRule: number }

const plural = (n: number) => `${n.toLocaleString('en-NZ')} ${n === 1 ? 'Transaction' : 'Transactions'}`

/** Makes the Rule and gives the Category as the notes at the top of the file say. `null` fields of the answer are for the page to word. */
export async function ruleFromTransaction(db: D1Database, actor: Member, request: FromTransaction): Promise<MadeRule> {
  const direction = request.direction ?? null
  const want = [request.textContains, direction, request.transactionId] as const
  const [chosen, rulesInUse, thisRows, found] = await db.batch([
    db.prepare('SELECT id, name FROM categories WHERE id = ? AND removed_at IS NULL').bind(request.categoryId),
    db.prepare('SELECT COUNT(*) AS n FROM rules WHERE removed_at IS NULL'),
    db.prepare(THIS_ONE).bind(...want),
    db.prepare(OTHERS).bind(...want),
  ])
  const here = thisRows!.results[0] as ThisOne | undefined
  if (!here) return { kind: 'no-transaction' }
  const named = chosen!.results[0] as { id: number; name: string } | undefined
  if (!named) return { kind: 'bad-category' }
  const inUse = (rulesInUse!.results[0] as { n: number }).n
  if (inUse >= MAX_RULES) return { kind: 'full' }

  // This one: by the Rule if the Rule would give it, otherwise as an Override.
  const byRule = here.matches === 1 && here.uncategorised === 1 && here.earlierRule === 0
  const because: OverrideBecause | null = byRule ? null : here.matches === 0 ? 'no-match' : here.uncategorised === 0 ? 'categorised' : 'earlier-rule'
  const setsOverride = !byRule && here.overrideCategory !== named.id

  // The others: with more than can be given the Category now, how many there are; otherwise, those that no earlier Rule matches.
  const candidates = (found!.results as { id: number }[]).map((row) => row.id)
  const tooMany = candidates.length > MAX_INLINE_APPLY
  const moreUncategorised = tooMany ? ((await db.prepare(COUNT_OTHERS).bind(...want).first<{ n: number }>())!.n) : null
  const winners = !tooMany && candidates.length > 0 ? ((await db.prepare(NO_EARLIER_RULE).bind(JSON.stringify(candidates)).all<{ id: number }>()).results.map((row) => row.id)) : []
  const ids = [...(byRule ? [here.id] : []), ...winners]

  const criteria: Criteria = { textContains: request.textContains, bankType: null, direction, minCents: null, maxCents: null }
  const target = { category: named.name, transfer: false }
  const number = inUse + 1
  const ruleEntry: ChangeEntry = { actor, type: 'rule', summary: `Added a Rule: ${describeRule(criteria, target)}`, after: ruleRecord(criteria, target), onlyIfChanged: true }
  const givenEntry: ChangeEntry = {
    actor,
    type: 'rule',
    summary: `Gave ${plural(ids.length)} the Category ${named.name} with the new Rule (Rule ${number})`,
    after: { transactionsGivenTheCategory: ids.length },
    onlyIfChanged: true,
  }
  const overrideEntry: ChangeEntry = {
    actor,
    type: 'transaction',
    summary: `Set Override on ${describeTransaction(here)} to ${named.name}`,
    before: { override: here.overrideName },
    after: { override: named.name },
    onlyIfChanged: true,
  }

  // Each entry follows the statement it describes (`onlyIfChanged` looks at the one before it), and the batch ends with an entry.
  const mutation: D1PreparedStatement[] = [restartRerun(db)]
  if (setsOverride) mutation.push(db.prepare(SET_OVERRIDE).bind(named.id, here.id, here.overrideCategory, MAX_RULES), changeLogStatement(db, overrideEntry))
  const added = mutation.length
  mutation.push(db.prepare(ADD_RULE).bind(request.textContains, direction, named.id, MAX_RULES))
  if (ids.length > 0) mutation.push(changeLogStatement(db, ruleEntry), db.prepare(GIVE_CATEGORY).bind(JSON.stringify(ids), named.id))
  const results = await recordChange(db, mutation, ids.length > 0 ? givenEntry : ruleEntry)

  if (results[added]!.meta.changes === 0) {
    // Nothing was written: the last place was taken, or the Category was removed, in the moments since the reads.
    const now = await db.prepare('SELECT (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) AS inUse').first<{ inUse: number }>()
    return now!.inUse >= MAX_RULES ? { kind: 'full' } : { kind: 'bad-category' }
  }
  return {
    kind: 'made',
    made: {
      id: results[added]!.meta.last_row_id,
      number,
      categorised: ids.length > 0 ? results.at(-1)!.meta.changes : 0,
      thisBy: byRule ? 'rule' : 'override',
      overrideBecause: because,
      moreUncategorised,
    },
  }
}
