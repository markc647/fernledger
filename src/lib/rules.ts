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

/** When a Rule applies, as one sentence: "Text contains “COUNTDOWN” and money out". The Rules table's "When" column, and what saving a Rule made from a Transaction says. */
export function ruleWhen(rule: Pick<RuleView, 'textContains' | 'bankType' | 'direction' | 'minCents' | 'maxCents'>): string {
  const text = ruleConditions(rule).join(' and ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What a Rule does to a Transaction it matches. */
export function ruleResult(rule: Pick<RuleView, 'transfer' | 'categoryName' | 'categoryRemoved'>): string {
  if (rule.transfer) return 'Mark as a Transfer'
  return rule.categoryRemoved ? `Category: ${rule.categoryName} (removed, so this Rule does nothing until you choose another)` : `Category: ${rule.categoryName}`
}

// Putting the Rules in order. A Rule's number is its place in the order (Rule 1 is checked first), so "Rule 3" and "position 3" are the same place. The page saves the whole new order
// with PUT /api/rules/order, and shows it at once; these decide what the order is.

/** The ids with `id` taken out and put where `overId` is (a dragged Rule takes the place of the one it is dropped on, and those between move along one), or null if nothing would move. */
export function moveRuleTo(ids: number[], id: number, overId: number): number[] | null {
  const from = ids.indexOf(id)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return null
  const next = ids.slice()
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

/** The ids with `id` one place up (-1) or down (1), or null at the end of the list, where it cannot go further. */
export function moveRuleBy(ids: number[], id: number, by: -1 | 1): number[] | null {
  const over = ids[ids.indexOf(id) + by]
  return ids.indexOf(id) < 0 || over === undefined ? null : moveRuleTo(ids, id, over)
}

/** The Rules in the order of `ids`, if those are exactly these Rules; otherwise the Rules as they are (an order made for another list is not applied to this one). */
export function inOrder<T extends { id: number }>(rules: T[], ids: number[]): T[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]))
  if (ids.length !== rules.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) return rules
  return ids.map((id) => byId.get(id)!)
}

/** What a handle is called to a screen reader, in place of dnd-kit's "sortable" (its `aria-roledescription`): "movable Rule, Drag to reorder Rule 3, button". */
export const DRAG_ROLE = 'movable Rule'

/** How to pick a Rule up, read to a screen reader with the handle (dnd-kit's `screenReaderInstructions`). */
export const DRAG_INSTRUCTIONS =
  'To move a Rule, press Space or Enter on its handle. Use the up and down arrow keys to choose its new place, then press Space or Enter to drop it. Press Escape to cancel.'

type Dragged = { id: string | number }

/** What a screen reader is told as a Rule is dragged, in dnd-kit's shape (`accessibility.announcements`). `ids` are the Rules in the order they are shown. */
export function dragAnnouncements(ids: number[]) {
  const place = (item: Dragged) => ids.indexOf(Number(item.id)) + 1
  const of = `of ${ids.length}`
  return {
    onDragStart: ({ active }: { active: Dragged }) => `Picked up Rule ${place(active)} ${of}.`,
    onDragOver: ({ active, over }: { active: Dragged; over: Dragged | null }) =>
      over ? `Rule ${place(active)} is over position ${place(over)} ${of}.` : `Rule ${place(active)} is not over a position.`,
    onDragEnd: ({ active, over }: { active: Dragged; over: Dragged | null }) =>
      over && over.id !== active.id ? `Dropped Rule ${place(active)} in position ${place(over)} ${of}.` : `Dropped Rule ${place(active)}. It stays in position ${place(active)} ${of}.`,
    onDragCancel: ({ active }: { active: Dragged }) => `Moving Rule ${place(active)} was cancelled. It is still in position ${place(active)} ${of}.`,
  }
}
