// Making a Rule from a Transaction: the Edit panel's Create Rule. The Admin has a Transaction in front of them, has chosen its Category, and wants every Transaction like it to
// have that Category. In one D1 batch (so the Rule and what it did commit together or not at all) this
//   1. adds the Rule, last in the order, as Add a Rule does (rules.ts), and, only if it was added, sends a re-run that is going back to the start (rule-rerun.ts);
//   2. gives the Category to the other Transactions that have no Category and that the Rule is the first to match, now, as if the Rules had been applied to them;
//   3. gives the Category to this Transaction: by the Rule if the Rule gives it (it is Uncategorised, the Rule matches it and no earlier Rule does), so it is a Rule's Category
//      like the others; as an Override, as Save would, if not (the text was edited so that it no longer matches, an earlier Rule matches it, or it has another Category already,
//      or is a Transfer); and not at all if it has this Category already.
//
// "Mirror what applying the Rules does" (rule-apply.ts, rule-rerun.ts): a Transaction's Rule result is `rule_id`, `rule_category` and `rule_transfer`, set from the first Rule that
// counts and matches. The new Rule is last, so it is the first to match a Transaction exactly when no other Rule counts and matches it (`firstMatchingRule`, the one definition,
// shared with Import and the re-run, and asked again when the Category is written). What this never touches: an Override (`override_category`), a Transaction that already has a
// Category from a Rule, a Transfer. Those are not Uncategorised (effective-category.ts, the one definition: the Uncategorised page lists the Transactions this gives the Category to).
// A Transaction an earlier Rule matches but that has not had the Rules applied since (it is stored as Uncategorised) is left to the re-run, which would give it the earlier Rule's
// Category and not this one's; the answer says how many (`heldByEarlierRule`).
//
// Free plan (ADR 0004): how much it can write is bounded, because the rows it gives the Category to are written now, in the request. At most MAX_INLINE_APPLY other Transactions
// are: 1,000 Transactions are about 2,000 of the day's 100,000 rows written (3,000 at the most, as the re-run budgets them) and, at the most there can be, 200 Rules and so about
// 210,000 of its 5 million read. With more than that to give the Category to, the Rule and this Transaction are saved, nothing else is, and the answer says how many more match, so the
// page can send the Admin to Apply the Rules to all Transactions, which keeps to its own share of the day. The reads are:
//   - one batch of four queries for the Category, the Rules in use, this Transaction and up to MAX_INLINE_APPLY + 1 of the others, which reads each Transaction
//     at most once and stops once it has found that many (rule-preview.ts: the one pass over the Transactions is what a search for text costs, there being no index on it);
//   - when there are more, one count of the Transactions after the last it found, so that the Transactions are read once between the two;
//   - the batch of writes (at most 7 statements, every one of them there when the Rule is made, so that the count of queries does not depend on how many Transactions it gives the Category to): nothing is walked, the Transactions are named by ID, and each is asked again whether it is still Uncategorised and whether the new Rule
//     is the first to match it (a read for each Rule above the new one, as in rule-rerun.ts).
// Queries: 9 on the usual path, 11 with an Override, 10 with too many (11 with an Override and nothing else to give) (rule-from-transaction.test.ts pins them); the request's 50 are not close.
//
// Another request can land between the reads and the batch, and what it did is never written over. The Rule is added only while there is room, its Category is in use and, when this
// Transaction is to be given an Override, the Override was written (so the Override is only over the Override that was read: if it changed, nothing is added and the answer is 409 as
// for Save). Everything after the Rule waits for it: its Change Log entry and the restart of a re-run that is going follow it by `changes()`, so a request that is refused (409, 400, 404)
// writes nothing and leaves a run alone; the Category is given only if the Rule is there (it is the newest, with this text, this direction and this Category, and newer than the newest
// the reads saw), and only to each Transaction that is still Uncategorised and that the new Rule is still the first to match (a Rule added since, an Override set, a Category
// removed). The entry in the Change Log, which the database counts as it writes it, and the answer are what was written. An answer from a request that lost such a race can be that this
// Transaction was left as it is (`kept`, `changed`), and `heldByEarlierRule` also counts a Transaction that was given a Category meanwhile.
import type { Member } from './auth'
import { changeLogStatement, CHANGES, recordChange, type ChangeEntry } from './changelog'
import { effectiveCategory } from './effective-category'
import { firstMatchingRule } from './rule-apply'
import { describeRule, MAX_RULES, ruleMatches, ruleRecord, type Criteria } from './rule-criteria'
import { restartRerunAfterChange } from './rule-rerun'
import { describe as describeTransaction } from './transactions'

/** The most other Transactions a Rule made from a Transaction gives the Category to in the request. More are left to Apply the Rules to all Transactions. */
export const MAX_INLINE_APPLY = 1000

export type FromTransaction = { transactionId: number; textContains: string; direction?: 'in' | 'out' | null; categoryId: number }

/**
 * Why this Transaction got its Category as it did, when not by the Rule: the Override it was given because the text does not match it, an earlier Rule does, or it has another
 * Category already (or is a Transfer); it was left as it is because it had this Category already, or got a Category of its own while the request was being handled.
 */
export type Because = 'no-match' | 'earlier-rule' | 'categorised' | 'already' | 'changed'

export type RuleFromTransaction = {
  /** The Rule's ID, and its place in the order (Rule 7). */
  id: number
  number: number
  /** How many Transactions the Rule gave the Category to: the others it found, and this one if the Rule gave it. */
  categorised: number
  /** 'rule' if the Rule gave this Transaction its Category, 'override' if an Override did, 'kept' if it was left as it is (see `Because`). */
  thisBy: 'rule' | 'override' | 'kept'
  because: Because | null
  /** How many other Uncategorised Transactions the text matches that an earlier Rule matches too, so were not given this Category; null when too many were left to say. */
  heldByEarlierRule: number | null
  /** How many other Uncategorised Transactions the Rule matches that were left for Apply the Rules to all Transactions, being more than the limit; null when none were. */
  moreUncategorised: number | null
}

export type MadeRule = { kind: 'made'; made: RuleFromTransaction } | { kind: 'no-transaction' } | { kind: 'bad-category' } | { kind: 'full' } | { kind: 'changed' }

const category = effectiveCategory()
// What a Rule matches (`ruleMatches`, the one definition) for criteria that are not saved: the text (?1) and which way the money went (?2) are bound, and the criteria this panel does not
// offer are none. The preview stands them in a one-row table (rule-preview.ts); here that would be in front of the Transactions, where the planner cannot see that it is one row and
// sorts all the matches to put them in the order of their IDs (below), reading every Transaction, so the columns are replaced by their values. A column `ruleMatches` gains
// that is not replaced here stops this file loading.
const matching = (transaction: string) => {
  const sql = ruleMatches('want', transaction)
    .replaceAll('want.text_contains', '?1')
    .replaceAll('want.direction', '?2')
    .replaceAll('want.bank_type', 'NULL')
    .replaceAll('want.min_cents', 'NULL')
    .replaceAll('want.max_cents', 'NULL')
  if (sql.includes('want.')) throw new Error('ruleMatches asks for a column that rule-from-transaction.ts does not bind')
  return sql
}
const UNCATEGORISED = `${category.id} IS NULL AND NOT ${category.isTransfer}`

// This Transaction, ?3: whether the text matches it, whether it is Uncategorised, whether a Rule that is in use matches it already, and whether its Category is the one chosen (?4) and it
// is not a Transfer, which has none to show.
const THIS_ONE = `
  SELECT t.id, t.date, t.description, t.override_category AS overrideCategory,
         (SELECT name FROM categories WHERE id = t.override_category AND removed_at IS NULL) AS overrideName,
         ${matching('t')} AS matches, (${UNCATEGORISED}) AS uncategorised, ${firstMatchingRule('t')} IS NOT NULL AS earlierRule,
         (${category.id} = ?4 AND NOT ${category.isTransfer}) AS already
  FROM transactions t ${category.joins}
  WHERE t.id = ?3`

// The other Transactions the text matches that are Uncategorised, one more than can be given the Category now, the lowest IDs first: that is the order a table of rows with IDs is scanned
// in, so asking for it costs no sort and the pass still stops at the last it needs (a test pins the reads), and the count of the rest below can carry on after the last ID found.
const OTHERS_FROM = `FROM transactions t ${category.joins} WHERE t.id <> ?3 AND ${matching('t')} AND ${UNCATEGORISED}`
const OTHERS = `SELECT t.id ${OTHERS_FROM} ORDER BY t.id LIMIT ${MAX_INLINE_APPLY + 1}`
// How many more there are after ?4, the last of those: the pass over the Transactions carries on where the one above stopped. (A count has no order to ask for.)
const COUNT_REST = `SELECT COUNT(*) AS n ${OTHERS_FROM} AND t.id > ?4`

// Adds the Rule last, as Add a Rule does (rules.ts), only while there is room and its Category (?3) is in use. ?1 text, ?2 direction, ?4 the most Rules. When this Transaction is
// being given an Override (?5 is 1) the statement before it is that Override's entry, which is written only if the Override was, so the Rule is added only then.
const ADD_RULE = `
  INSERT INTO rules (position, text_contains, bank_type, direction, min_cents, max_cents, category_id, is_transfer)
  SELECT (SELECT COALESCE(MAX(position), 0) + 1 FROM rules WHERE removed_at IS NULL), ?1, NULL, ?2, NULL, NULL, ?3, 0
  WHERE (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) < ?4 AND EXISTS (SELECT 1 FROM categories WHERE id = ?3 AND removed_at IS NULL) AND (?5 = 0 OR changes() > 0)`

// This Transaction's Override, as Save sets it (transactions.ts): over the Override that was read (?3, `IS` is `=` that also matches NULL), with the Category (?1) in use, and only
// while there is room for the Rule (?4), so a request that is to be refused changes nothing.
const SET_OVERRIDE = `
  UPDATE transactions SET override_category = ?1
  WHERE id = ?2 AND override_category IS ?3 AND EXISTS (SELECT 1 FROM categories WHERE id = ?1 AND removed_at IS NULL)
    AND (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) < ?4`

// The Rule's result on the Transactions named in ?1 (a JSON array of IDs), as the re-run stores it (rule-rerun.ts WALK) for a Rule that gives a Category: the Rule's ID, its Category
// (?2) and no Transfer mark. It runs after the restart of a re-run, which follows the Change Log entry of the Rule, so `changes()` no longer says whether the Rule was added: the Rule
// is there if the newest Rule has an ID above the newest the reads saw (?3) and this text (?4), direction (?5) and Category (nothing else runs between the statements of a batch, and an
// ID never goes back). A Transaction is given it only if it is still Uncategorised and the new Rule is the first that matches it, which is asked again here: a Rule added, a Category
// chosen or a Category removed since the reads leave it alone. The IDs it gave are returned.
const GIVE_CATEGORY = `
  UPDATE transactions SET rule_id = (SELECT MAX(id) FROM rules), rule_category = ?2, rule_transfer = NULL
  WHERE EXISTS (
      SELECT 1 FROM rules WHERE id = (SELECT MAX(id) FROM rules) AND id > ?3 AND removed_at IS NULL AND text_contains IS ?4 AND direction IS ?5 AND category_id = ?2
        AND bank_type IS NULL AND min_cents IS NULL AND max_cents IS NULL AND is_transfer = 0)
    AND id IN (
      SELECT t.id FROM transactions t ${category.joins}
      WHERE t.id IN (SELECT value FROM json_each(?1)) AND ${UNCATEGORISED} AND ${firstMatchingRule('t')} = (SELECT MAX(id) FROM rules))
  RETURNING id`

// Why a Rule was not added, from what is true now: the Transaction, the room for another Rule, the Category.
const WHY_NOT = `
  SELECT (SELECT COUNT(*) FROM rules WHERE removed_at IS NULL) AS inUse,
         EXISTS (SELECT 1 FROM categories WHERE id = ?1 AND removed_at IS NULL) AS categoryInUse,
         EXISTS (SELECT 1 FROM transactions WHERE id = ?2) AS transactionThere`

type ThisOne = {
  id: number
  date: string
  description: string
  overrideCategory: number | null
  overrideName: string | null
  matches: number
  uncategorised: number
  earlierRule: number
  already: number | null
}

/** Makes the Rule and gives the Category as the notes at the top of the file say. `null` fields of the answer are for the page to word. */
export async function ruleFromTransaction(db: D1Database, actor: Member, request: FromTransaction): Promise<MadeRule> {
  const direction = request.direction ?? null
  const want = [request.textContains, direction, request.transactionId] as const
  const [chosen, rulesInUse, thisRows, found] = await db.batch([
    db.prepare('SELECT id, name FROM categories WHERE id = ? AND removed_at IS NULL').bind(request.categoryId),
    db.prepare('SELECT COUNT(*) AS n, (SELECT COALESCE(MAX(id), 0) FROM rules) AS lastId FROM rules WHERE removed_at IS NULL'),
    db.prepare(THIS_ONE).bind(...want, request.categoryId),
    db.prepare(OTHERS).bind(...want),
  ])
  const here = thisRows!.results[0] as ThisOne | undefined
  if (!here) return { kind: 'no-transaction' }
  const named = chosen!.results[0] as { id: number; name: string } | undefined
  if (!named) return { kind: 'bad-category' }
  const { n: inUse, lastId } = rulesInUse!.results[0] as { n: number; lastId: number }
  if (inUse >= MAX_RULES) return { kind: 'full' }

  // This one: by the Rule if the Rule would give it; left as it is if it has this Category already; otherwise as an Override.
  const byRule = here.matches === 1 && here.uncategorised === 1 && here.earlierRule === 0
  const already = here.already === 1
  const because: Because | null = byRule ? null : already ? 'already' : here.matches === 0 ? 'no-match' : here.uncategorised === 0 ? 'categorised' : 'earlier-rule'
  const setsOverride = !byRule && !already

  // The others: with more than can be given the Category now, how many there are (the count carries on after the last found); otherwise all of them, and the write says which no earlier Rule matches.
  const candidates = (found!.results as { id: number }[]).map((row) => row.id)
  const tooMany = candidates.length > MAX_INLINE_APPLY
  const moreUncategorised = tooMany ? candidates.length + (await db.prepare(COUNT_REST).bind(...want, candidates.at(-1)!).first<{ n: number }>())!.n : null
  const ids = [...(byRule ? [here.id] : []), ...(tooMany ? [] : candidates)]

  const criteria: Criteria = { textContains: request.textContains, bankType: null, direction, minCents: null, maxCents: null }
  const target = { category: named.name, transfer: false }
  const number = inUse + 1
  const ruleEntry: ChangeEntry = { actor, type: 'rule', summary: `Added a Rule: ${describeRule(criteria, target)}`, after: ruleRecord(criteria, target), onlyIfChanged: true }
  // The database counts what it gave the Category to, as it writes the entry.
  const givenEntry: ChangeEntry = { actor, type: 'rule', summary: `Transactions given the Category ${named.name} by the new Rule (Rule ${number}): ${CHANGES}`, onlyIfChanged: true, countChanges: true }
  const overrideEntry: ChangeEntry = {
    actor,
    type: 'transaction',
    summary: `Set Override on ${describeTransaction(here)} to ${named.name}`,
    before: { override: here.overrideName },
    after: { override: named.name },
    onlyIfChanged: true,
  }

  // Each entry follows the statement it describes (`onlyIfChanged` looks at the one before it), and the batch ends with an entry. The restart of a re-run follows the Rule's entry, which is
  // written only if the Rule was, and is only for a Rule that was added. The Category is given even to nobody (an empty list), so that the batch is the same whatever is found.
  const mutation: D1PreparedStatement[] = []
  if (setsOverride) mutation.push(db.prepare(SET_OVERRIDE).bind(named.id, here.id, here.overrideCategory, MAX_RULES), changeLogStatement(db, overrideEntry))
  const added = mutation.length
  mutation.push(
    db.prepare(ADD_RULE).bind(request.textContains, direction, named.id, MAX_RULES, setsOverride ? 1 : 0),
    changeLogStatement(db, ruleEntry),
    restartRerunAfterChange(db),
    db.prepare(GIVE_CATEGORY).bind(JSON.stringify(ids), named.id, lastId, request.textContains, direction),
  )
  const results = await recordChange(db, mutation, givenEntry)

  if (results[added]!.meta.changes === 0) {
    // Nothing was added: in the moments since the reads, the Transaction went, the last place was taken, the Category was removed or (for an Override) the Override moved on. Nothing else
    // was written either (the Rule's entry, the restart and the Category all wait for the Rule), and the Override waited for its room and Category too. The Override already being what was
    // asked for is not "done": the Rule was not made.
    const now = (await db.prepare(WHY_NOT).bind(named.id, here.id).first<{ inUse: number; categoryInUse: number; transactionThere: number }>())!
    if (now.transactionThere === 0) return { kind: 'no-transaction' }
    if (now.inUse >= MAX_RULES) return { kind: 'full' }
    return now.categoryInUse === 0 ? { kind: 'bad-category' } : { kind: 'changed' }
  }
  const given = (results.at(-1)!.results as { id: number }[]).map((row) => row.id)
  const thisGiven = byRule && given.includes(here.id)
  return {
    kind: 'made',
    made: {
      id: results[added]!.meta.last_row_id,
      number,
      categorised: given.length,
      thisBy: thisGiven ? 'rule' : byRule || already ? 'kept' : 'override',
      because: byRule ? (thisGiven ? null : 'changed') : because,
      heldByEarlierRule: tooMany ? null : candidates.length - (given.length - (thisGiven ? 1 : 0)),
      moreUncategorised,
    },
  }
}
