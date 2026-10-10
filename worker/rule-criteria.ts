// What a Rule is made of: the shape the API takes, the one SQL definition of "this Rule matches this Transaction",
// and how a Rule reads in the Change Log. Applying Rules (rule-apply.ts), previewing one (rules.ts) and the tests all
// build on `ruleMatches`, so they can't disagree about what a Rule matches.
import * as z from 'zod/mini'

/** Rules in use. Every new Import chunk looks up the first Rule that matches each of its rows, so the list stays short (ADR 0004). */
export const MAX_RULES = 100

/** The largest amount a Rule can name: $1,000,000,000.00. Mirrored in src/lib/rules.ts. */
export const MAX_AMOUNT_CENTS = 100_000_000_000

const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max))
const cents = z.int().check(z.minimum(0), z.maximum(MAX_AMOUNT_CENTS))
/** A criterion the Rule may leave out: absent and null both mean "not used". */
const optionally = <T extends z.ZodMiniType>(schema: T) => z.optional(z.nullable(schema))

const criteriaFields = {
  /** Found anywhere in the description or the bank memo, ignoring capitals A to Z (not accented letters). */
  textContains: optionally(text(100)),
  /** The bank's own transaction type (Tran Type in the bank's export), such as EFTPOS. Equal, ignoring capitals A to Z. */
  bankType: optionally(text(40)),
  /** Which way the money went: 'in' is an amount above zero, 'out' below zero. Left out means either. */
  direction: optionally(z.enum(['in', 'out'])),
  /** The size of the amount in cents, whichever way the money went. Both ends included. */
  minCents: optionally(cents),
  maxCents: optionally(cents),
}

type CriteriaInput = { textContains?: string | null; bankType?: string | null; direction?: 'in' | 'out' | null; minCents?: number | null; maxCents?: number | null }

/** A Rule with no criterion would match every Transaction, so at least one is needed. */
const usesACriterion = (c: CriteriaInput) => [c.textContains, c.bankType, c.direction, c.minCents, c.maxCents].some((value) => value !== undefined && value !== null)
const rangeIsOrdered = (c: CriteriaInput) => c.minCents == null || c.maxCents == null || c.minCents <= c.maxCents

/** What the preview takes: criteria only, since it asks how many Transactions they match and changes nothing. */
export const criteriaBody = z
  .object(criteriaFields)
  .check(z.refine(usesACriterion, { path: ['criteria'] }), z.refine(rangeIsOrdered, { path: ['maxCents'] }))

/** What adding or changing a Rule takes: the criteria, and exactly one target, a Category or the Transfer flag. */
export const ruleBody = z
  .object({ ...criteriaFields, categoryId: optionally(z.int().check(z.positive())), transfer: z.optional(z.boolean()) })
  .check(
    z.refine(usesACriterion, { path: ['criteria'] }),
    z.refine(rangeIsOrdered, { path: ['maxCents'] }),
    z.refine((rule) => (rule.categoryId != null) !== (rule.transfer === true), { path: ['categoryId'] }),
  )

/** The criteria with every unused one made null, so a stored Rule and a request compare equal. */
export type Criteria = { textContains: string | null; bankType: string | null; direction: 'in' | 'out' | null; minCents: number | null; maxCents: number | null }

export const toCriteria = (input: CriteriaInput): Criteria => ({
  textContains: input.textContains ?? null,
  bankType: input.bankType ?? null,
  direction: input.direction ?? null,
  minCents: input.minCents ?? null,
  maxCents: input.maxCents ?? null,
})

/**
 * SQL that is true when the Rule row `rule` matches the Transaction row `transaction`. Both are table aliases and are
 * interpolated into SQL, so they must be constants written in the calling code, never anything from a request.
 * `rule` needs the columns text_contains, bank_type, direction, min_cents and max_cents (a `rules` row, or a one-row
 * subquery of the same names holding criteria that are not saved yet).
 *
 * - Text uses `instr` rather than `LIKE`, so `%` and `_` in the Admin's text are the characters they are.
 * - Capitals are ignored with `lower()`, which in SQLite folds A to Z only, as `COLLATE NOCASE` does for Category names.
 * - The amount range is on the size of the amount (`abs`), so one range covers money in and money out; `direction`
 *   narrows it to one way. A $0.00 Transaction is neither money in nor money out.
 */
export const ruleMatches = (rule: string, transaction: string) => `(
    (${rule}.text_contains IS NULL OR instr(lower(${transaction}.description), lower(${rule}.text_contains)) > 0 OR instr(lower(${transaction}.bank_memo), lower(${rule}.text_contains)) > 0)
    AND (${rule}.bank_type IS NULL OR lower(${transaction}.bank_type) = lower(${rule}.bank_type))
    AND (${rule}.direction IS NULL OR (${rule}.direction = 'in' AND ${transaction}.amount_cents > 0) OR (${rule}.direction = 'out' AND ${transaction}.amount_cents < 0))
    AND (${rule}.min_cents IS NULL OR abs(${transaction}.amount_cents) >= ${rule}.min_cents)
    AND (${rule}.max_cents IS NULL OR abs(${transaction}.amount_cents) <= ${rule}.max_cents)
  )`

const wholeDollars = new Intl.NumberFormat('en-NZ')
/** "$1,500.50", from whole cents. */
export const dollars = (amountCents: number) => `$${wholeDollars.format(Math.floor(amountCents / 100))}.${String(amountCents % 100).padStart(2, '0')}`

/** A Rule as it reads in the Change Log: its criteria joined with "and", then where a Transaction it matches goes. */
export function describeRule(criteria: Criteria, target: { category: string | null; transfer: boolean }): string {
  const parts: string[] = []
  if (criteria.textContains !== null) parts.push(`text contains "${criteria.textContains}"`)
  if (criteria.bankType !== null) parts.push(`type is ${criteria.bankType}`)
  if (criteria.direction !== null) parts.push(criteria.direction === 'in' ? 'money in' : 'money out')
  if (criteria.minCents !== null && criteria.maxCents !== null) parts.push(`amount from ${dollars(criteria.minCents)} to ${dollars(criteria.maxCents)}`)
  else if (criteria.minCents !== null) parts.push(`amount of ${dollars(criteria.minCents)} or more`)
  else if (criteria.maxCents !== null) parts.push(`amount of ${dollars(criteria.maxCents)} or less`)
  return `${parts.join(' and ')}, ${target.transfer ? 'marked as a Transfer' : `category ${target.category}`}`
}

/** A Rule's recorded before or after in the Change Log: plain words and dollars, since the Change Log page shows them as they are. */
export function ruleRecord(criteria: Criteria, target: { category: string | null; transfer: boolean }) {
  return {
    textContains: criteria.textContains,
    transactionType: criteria.bankType,
    moneyDirection: criteria.direction === null ? null : criteria.direction === 'in' ? 'Money in' : 'Money out',
    amountFrom: criteria.minCents === null ? null : dollars(criteria.minCents),
    amountTo: criteria.maxCents === null ? null : dollars(criteria.maxCents),
    category: target.category,
    transfer: target.transfer,
  }
}
