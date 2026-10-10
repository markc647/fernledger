import { describe, expect, it } from 'vitest'
import { dollarsForInput, readDollars, ruleConditions, ruleResult, type RuleView } from './rules'

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
