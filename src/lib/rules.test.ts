import { describe, expect, it } from 'vitest'
import { dollarsForInput, DRAG_INSTRUCTIONS, dragAnnouncements, inOrder, moveRuleBy, moveRuleTo, readDollars, ruleConditions, ruleResult, type RuleView } from './rules'

const rule = (over: Partial<RuleView> = {}): RuleView => ({
  id: 1,
  textContains: null,
  bankType: null,
  direction: null,
  minCents: null,
  maxCents: null,
  categoryId: 7,
  categoryName: 'Groceries',
  categoryRemoved: false,
  transfer: false,
  ...over,
})

describe('reading a dollar amount the Admin typed', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['0.05', 5],
    ['0', 0],
    ['  $1,234.50 ', 123450],
    ['$ 7', 700],
    ['1000000000', 100_000_000_000],
  ])('%s is %s cents', (text, cents) => {
    expect(readDollars(text)).toEqual({ valid: true, cents })
  })

  it.each(['', '   '])('treats blank (%j) as not used', (text) => {
    expect(readDollars(text)).toEqual({ valid: true, cents: null })
  })

  it.each(['abc', '-5', '5-', '12.345', '1.2.3', '12,34', '$', '.', '1e3', '１２', '1000000001', '5 dollars'])('refuses %j', (text) => {
    expect(readDollars(text)).toEqual({ valid: false })
  })

  it('shows cents as the Admin would type them back', () => {
    expect(dollarsForInput(null)).toBe('')
    expect(dollarsForInput(0)).toBe('0.00')
    expect(dollarsForInput(5)).toBe('0.05')
    expect(dollarsForInput(123450)).toBe('1234.50')
    expect(readDollars(dollarsForInput(123450))).toEqual({ valid: true, cents: 123450 })
  })
})

describe('describing a Rule in words', () => {
  it('lists each condition the Rule uses, and no other', () => {
    expect(ruleConditions(rule({ textContains: 'Woolworths' }))).toEqual(['text contains “Woolworths”'])
    expect(ruleConditions(rule({ bankType: 'EFTPOS', direction: 'out' }))).toEqual(['type is EFTPOS', 'money out'])
    expect(ruleConditions(rule({ direction: 'in' }))).toEqual(['money in'])
  })

  it('says an amount range in dollars, whichever ends it has', () => {
    expect(ruleConditions(rule({ minCents: 1000, maxCents: 20000 }))).toEqual(['amount from $10.00 to $200.00'])
    expect(ruleConditions(rule({ minCents: 1000 }))).toEqual(['amount of $10.00 or more'])
    expect(ruleConditions(rule({ maxCents: 150050 }))).toEqual(['amount of $1,500.50 or less'])
    expect(ruleConditions(rule({ minCents: 0, maxCents: 0 }))).toEqual(['amount from $0.00 to $0.00'])
  })

  it('puts the conditions in the order the form asks for them', () => {
    expect(ruleConditions(rule({ textContains: 'bp', bankType: 'EFTPOS', direction: 'out', minCents: 500, maxCents: 9000 }))).toEqual([
      'text contains “bp”',
      'type is EFTPOS',
      'money out',
      'amount from $5.00 to $90.00',
    ])
  })

  it('says what the Rule does', () => {
    expect(ruleResult(rule())).toBe('Category: Groceries')
    expect(ruleResult(rule({ categoryId: null, categoryName: null, transfer: true }))).toBe('Mark as a Transfer')
  })

  it('says when the Rule\'s Category has been removed, so the Admin knows it does nothing', () => {
    expect(ruleResult(rule({ categoryRemoved: true }))).toBe('Category: Groceries (removed, so this Rule does nothing until you choose another)')
  })
})

describe('putting the Rules in a new order', () => {
  const ids = [11, 12, 13, 14, 15]

  it('moves a Rule to the place of the Rule it is dropped on, and the Rules between move along one', () => {
    expect(moveRuleTo(ids, 13, 11)).toEqual([13, 11, 12, 14, 15]) // up to the top
    expect(moveRuleTo(ids, 12, 15)).toEqual([11, 13, 14, 15, 12]) // down to the bottom
    expect(moveRuleTo(ids, 14, 13)).toEqual([11, 12, 14, 13, 15]) // one place up
    expect(moveRuleTo(ids, 12, 13)).toEqual([11, 13, 12, 14, 15]) // one place down
  })

  it('does not change the list it was given', () => {
    const before = [...ids]
    moveRuleTo(ids, 13, 11)
    moveRuleBy(ids, 13, -1)
    expect(ids).toEqual(before)
  })

  it('says nothing has moved (null) when a Rule is dropped on itself, or on a Rule that is not in the list', () => {
    expect(moveRuleTo(ids, 13, 13)).toBeNull()
    expect(moveRuleTo(ids, 13, 99)).toBeNull()
    expect(moveRuleTo(ids, 99, 13)).toBeNull()
  })

  it('moves a Rule one place up or down, as the menu does', () => {
    expect(moveRuleBy(ids, 13, -1)).toEqual([11, 13, 12, 14, 15])
    expect(moveRuleBy(ids, 13, 1)).toEqual([11, 12, 14, 13, 15])
  })

  it('cannot move the first Rule up or the last one down', () => {
    expect(moveRuleBy(ids, 11, -1)).toBeNull()
    expect(moveRuleBy(ids, 15, 1)).toBeNull()
    expect(moveRuleBy([7], 7, 1)).toBeNull()
    expect(moveRuleBy(ids, 99, 1)).toBeNull()
  })

  it('puts the Rules themselves in the order of the ids, for the page to show before the Worker has answered', () => {
    const rules = [rule({ id: 1 }), rule({ id: 2 }), rule({ id: 3 })]
    expect(inOrder(rules, [3, 1, 2]).map((r) => r.id)).toEqual([3, 1, 2])
    expect(inOrder(rules, [1, 2, 3])).toEqual(rules)
  })

  it('leaves the Rules as they are when the ids are not the same Rules (the order is not applied to a list it was not made from)', () => {
    const rules = [rule({ id: 1 }), rule({ id: 2 }), rule({ id: 3 })]
    expect(inOrder(rules, [3, 1])).toEqual(rules)
    expect(inOrder(rules, [3, 1, 9])).toEqual(rules)
    expect(inOrder(rules, [1, 1, 2])).toEqual(rules)
  })
})

describe('what a screen reader is told while a Rule is dragged', () => {
  // Rule numbers are positions: the Rule with id 21 is Rule 1, and so on.
  const say = dragAnnouncements([21, 22, 23, 24])

  it('says which Rule was picked up and where it is', () => {
    expect(say.onDragStart({ active: { id: 23 } })).toBe('Picked up Rule 3 of 4.')
  })

  it('says which position it is over as it moves, and when it is over none', () => {
    expect(say.onDragOver({ active: { id: 23 }, over: { id: 21 } })).toBe('Rule 3 is over position 1 of 4.')
    expect(say.onDragOver({ active: { id: 23 }, over: null })).toBe('Rule 3 is not over a position.')
  })

  it('says where it was dropped, and that it stayed if it was dropped where it was', () => {
    expect(say.onDragEnd({ active: { id: 23 }, over: { id: 21 } })).toBe('Dropped Rule 3 in position 1 of 4.')
    expect(say.onDragEnd({ active: { id: 23 }, over: { id: 23 } })).toBe('Dropped Rule 3. It stays in position 3 of 4.')
    expect(say.onDragEnd({ active: { id: 23 }, over: null })).toBe('Dropped Rule 3. It stays in position 3 of 4.')
  })

  it('says a cancelled move left the Rule where it was', () => {
    expect(say.onDragCancel({ active: { id: 22 } })).toBe('Moving Rule 2 was cancelled. It is still in position 2 of 4.')
  })

  it('has plain words to say how to pick a Rule up', () => {
    expect(DRAG_INSTRUCTIONS).toBe('To move a Rule, press Space or Enter on its handle. Use the up and down arrow keys to choose its new place, then press Space or Enter to drop it. Press Escape to cancel.')
  })
})
