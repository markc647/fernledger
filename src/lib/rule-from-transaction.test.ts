import { describe, expect, it } from 'vitest'
import { countSentence, directionOf, MAX_INLINE_APPLY, savedRuleSentence, tooManyNote, type RuleFromTransaction } from './rule-from-transaction'

describe('directionOf', () => {
  it('is which way the money went, and either for $0.00', () => {
    expect(directionOf(-432_100)).toBe('out')
    expect(directionOf(1)).toBe('in')
    expect(directionOf(0)).toBe('')
  })
})

describe('countSentence', () => {
  it.each([
    [{ matches: 14, uncategorised: 9 }, '14 Transactions match, 9 of them uncategorised.'],
    [{ matches: 14, uncategorised: 14 }, '14 Transactions match, all of them uncategorised.'],
    [{ matches: 14, uncategorised: 1 }, '14 Transactions match, 1 of them uncategorised.'],
    [{ matches: 14, uncategorised: 0 }, '14 Transactions match, none of them uncategorised.'],
    [{ matches: 2, uncategorised: 2 }, '2 Transactions match, both of them uncategorised.'],
    [{ matches: 1, uncategorised: 1 }, '1 Transaction matches, and it is uncategorised.'],
    [{ matches: 1, uncategorised: 0 }, '1 Transaction matches, and it has a Category already.'],
    [{ matches: 0, uncategorised: 0 }, 'No Transactions match.'],
    [{ matches: 12_345, uncategorised: 1_234 }, '12,345 Transactions match, 1,234 of them uncategorised.'],
  ])('says how many match: %j', (counts, sentence) => {
    expect(countSentence(counts)).toBe(sentence)
  })
})

describe('tooManyNote', () => {
  it(`says so when more than ${MAX_INLINE_APPLY} other Transactions are uncategorised, and not before`, () => {
    expect(tooManyNote(MAX_INLINE_APPLY + 1, true)).toBeNull() // this one is one of them: 500 others
    expect(tooManyNote(MAX_INLINE_APPLY + 2, true)).toContain('Apply the Rules to all Transactions')
    expect(tooManyNote(MAX_INLINE_APPLY, false)).toBeNull()
    expect(tooManyNote(MAX_INLINE_APPLY + 1, false)).toContain('Apply the Rules to all Transactions')
  })

  it('says what will and will not happen', () => {
    expect(tooManyNote(2_000, true)).toBe(
      'That is more than 500, too many to give a Category at once. Save Category and Rule will save the Rule and give only this Transaction the Category; Apply the Rules to all Transactions, on the Rules page, will give the rest theirs.',
    )
  })
})

describe('savedRuleSentence', () => {
  const made = (over: Partial<RuleFromTransaction>): RuleFromTransaction => ({ id: 41, number: 7, categorised: 9, thisBy: 'rule', overrideBecause: null, moreUncategorised: null, ...over })
  const said = (over: Partial<RuleFromTransaction>, when = 'Text contains “COUNTDOWN”') => savedRuleSentence(made(over), { when, categoryName: 'Groceries' })

  it('says the Rule, how many Transactions it gave the Category, and that this one is among them', () => {
    expect(said({})).toBe('Saved Rule 7 (Text contains “COUNTDOWN”) and gave 9 Transactions the Category Groceries, this one included.')
    expect(said({}, 'Text contains “COUNTDOWN” and money out')).toContain('(Text contains “COUNTDOWN” and money out)')
  })

  it('says so when this was the only one', () => {
    expect(said({ categorised: 1 })).toBe('Saved Rule 7 (Text contains “COUNTDOWN”) and gave this Transaction the Category Groceries. No other Uncategorised Transactions match.')
  })

  it('says which when this one got its Category as an Override, and why', () => {
    expect(said({ thisBy: 'override', overrideBecause: 'no-match', categorised: 8 })).toBe(
      'Saved Rule 7 (Text contains “COUNTDOWN”) and gave 8 Transactions the Category Groceries. This Transaction does not match the text, so its Category is an Override on it instead.',
    )
    expect(said({ thisBy: 'override', overrideBecause: 'earlier-rule', categorised: 1 })).toBe(
      'Saved Rule 7 (Text contains “COUNTDOWN”) and gave 1 Transaction the Category Groceries. An earlier Rule matches this Transaction, so its Category is an Override on it instead.',
    )
    expect(said({ thisBy: 'override', overrideBecause: 'categorised', categorised: 0 })).toBe(
      'Saved Rule 7 (Text contains “COUNTDOWN”). This Transaction already had a Category, or is a Transfer, so the Category you chose is an Override on it. No other Uncategorised Transactions match.',
    )
  })

  it('says how many more there are when there were too many to do now, and what to do about them', () => {
    expect(said({ categorised: 1, moreUncategorised: 612 })).toBe(
      'Saved Rule 7 (Text contains “COUNTDOWN”) and gave this Transaction the Category Groceries. 612 more Uncategorised Transactions match: that is too many to give the Category at once. Choose Apply the Rules to all Transactions, on the Rules page, to give them theirs.',
    )
    expect(said({ thisBy: 'override', overrideBecause: 'no-match', categorised: 0, moreUncategorised: 1_612 })).toContain('1,612 more Uncategorised Transactions match')
  })
})
