import type { MAX_AMOUNT_CENTS as WORKER_MAX_AMOUNT_CENTS } from '@/generated/api/rule-criteria'
import { formatBalance } from './format'

// How the Rules page reads and writes a Rule: dollar amounts typed by the Admin, and a Rule described in words.
// Money on the wire is integer cents (the Worker's rule-criteria.ts); the dollars here are only what the Admin types and reads.

/** The Worker's limit on an amount a Rule can name, $1,000,000,000.00 (worker/rule-criteria.ts). Typed as the Worker's literal, so the build fails if the two drift apart. */
export const MAX_AMOUNT_CENTS: typeof WORKER_MAX_AMOUNT_CENTS = 100_000_000_000

/** A Rule as the API lists it. */
export type RuleView = {
  id: number
  textContains: string | null
  bankType: string | null
  direction: 'in' | 'out' | null
  minCents: number | null
  maxCents: number | null
  categoryId: number | null
  categoryName: string | null
  /** The Rule's Category was removed, so the Rule does nothing until it is changed. */
  categoryRemoved: boolean
  transfer: boolean
}

export type DollarsRead = { valid: true; cents: number | null } | { valid: false }

// Digits with an optional "$", optional thousands commas and up to two decimal places. ASCII digits only.
const DOLLARS = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/** Reads dollars the Admin typed ("12", "$1,234.50") as whole cents. Blank means the amount is not used, so `cents` is null. */
export function readDollars(text: string): DollarsRead {
  const typed = text.trim()
  if (typed === '') return { valid: true, cents: null }
  const match = DOLLARS.exec(typed)
  if (!match) return { valid: false }
  // Whole parts of any length are possible, so reject before the arithmetic can lose precision.
  const whole = match[1]!.replaceAll(',', '')
  if (whole.length > 12) return { valid: false }
  const cents = Number(whole) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return cents > MAX_AMOUNT_CENTS ? { valid: false } : { valid: true, cents }
}

/** Cents as they go back into an amount box: "1234.50"; blank for an amount that is not used. */
export function dollarsForInput(cents: number | null): string {
  if (cents === null) return ''
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

// An amount a Rule names is never negative, so the shared formatter reads it as "$1,234.50".
const dollars = formatBalance

/** What a Rule looks for, one phrase per condition it uses, in the order the form asks for them. */
export function ruleConditions(rule: Pick<RuleView, 'textContains' | 'bankType' | 'direction' | 'minCents' | 'maxCents'>): string[] {
  const conditions: string[] = []
  if (rule.textContains !== null) conditions.push(`text contains “${rule.textContains}”`)
  if (rule.bankType !== null) conditions.push(`type is ${rule.bankType}`)
  if (rule.direction !== null) conditions.push(rule.direction === 'in' ? 'money in' : 'money out')
  if (rule.minCents !== null && rule.maxCents !== null) conditions.push(`amount from ${dollars(rule.minCents)} to ${dollars(rule.maxCents)}`)
  else if (rule.minCents !== null) conditions.push(`amount of ${dollars(rule.minCents)} or more`)
  else if (rule.maxCents !== null) conditions.push(`amount of ${dollars(rule.maxCents)} or less`)
  return conditions
}

/** What a Rule does to a Transaction it matches. */
export function ruleResult(rule: Pick<RuleView, 'transfer' | 'categoryName' | 'categoryRemoved'>): string {
  if (rule.transfer) return 'Mark as a Transfer'
  return rule.categoryRemoved ? `Category: ${rule.categoryName} (removed, so this Rule does nothing until you choose another)` : `Category: ${rule.categoryName}`
}
