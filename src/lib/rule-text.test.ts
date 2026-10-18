import { describe, expect, it } from 'vitest'
import { suggestRuleText } from './rule-text'

// Descriptions are made up, in the shapes NZ banks put on a statement: a card payment with its card number, a date and a place; a direct debit; a wage.
const merchants: [description: string, suggested: string][] = [
  ['EFTPOS 1234 COUNTDOWN AUCKLAND 12/10', 'COUNTDOWN'],
  ['POS W/D 12OCT NEW WORLD ALBANY 4521', 'NEW WORLD'],
  ['VISA PURCHASE 4835-12XX-XXXX-1234 Z ENERGY NEWMARKET 12/10/26 14:32', 'Z ENERGY'],
  ['DEBIT CARD PURCHASE 2026-10-12 PAK N SAVE NORTHLANDS', 'PAK N SAVE NORTHLANDS'],
  ['EFTPOS PURCHASE ************1234 THE WAREHOUSE MANUKAU 09:45:10', 'THE WAREHOUSE'],
  ['Countdown  Grey Lynn', 'Countdown  Grey Lynn'],
  ['COUNTDOWN 4521 ALBANY', 'COUNTDOWN'],
  ['SQ *BLUE BOTTLE COFFEE 9921 AKL', 'SQ *BLUE BOTTLE COFFEE'],
  ['PAYWAVE 7-ELEVEN QUEEN ST 0912', '7-ELEVEN QUEEN ST'],
  ['EFTPOS COUNTDOWN 12 OCT', 'COUNTDOWN'],
  ['EFTPOS COUNTDOWN 12OCT26 AUCKLAND NZL', 'COUNTDOWN'],
  ['CARD 1234 BUNNINGS WAREHOUSE PAPAKURA 2:15PM', 'BUNNINGS WAREHOUSE'],
  ['EFTPOS MITRE 10 MEGA TAURANGA NZ', 'MITRE 10 MEGA'],
  ['DIRECT DEBIT SPARK NZ 0800 123 456', 'SPARK'],
  ['AUTOMATIC PAYMENT MERIDIAN ENERGY LTD REF 887766', 'MERIDIAN ENERGY LTD'],
  ['DIRECT CREDIT ACME BUILDING LTD WAGES RECEIPT 20261012', 'ACME BUILDING LTD WAGES'],
  ['EFTPOS $45.60 PHARMACY 44 DUNEDIN', 'PHARMACY 44'],
  ['A/P ACME POWER LTD 20261012', 'ACME POWER LTD'],
  ['D/D SPARK NZ', 'SPARK'],
  ['BILL PAYMENT VODAFONE NZ 4455', 'VODAFONE'],
  ['EFTPOS NEW WORLD LAKE TAUPO 12/10', 'NEW WORLD'],
  ['EFTPOS COUNTDOWN MOUNT MAUNGANUI', 'COUNTDOWN'],
]

describe('suggestRuleText', () => {
  it.each(merchants)('suggests the merchant from %j', (description, suggested) => {
    expect(suggestRuleText(description)).toBe(suggested)
  })

  it('keeps the place when taking it away would leave too little to look for', () => {
    expect(suggestRuleText('Z NEWMARKET')).toBe('Z NEWMARKET')
    expect(suggestRuleText('EFTPOS BP ALBANY')).toBe('BP ALBANY')
    expect(suggestRuleText('AUCKLAND')).toBe('AUCKLAND')
  })

  it('keeps a trailing word that is also a surname, so a payee is not cut down to a first name', () => {
    expect(suggestRuleText('MARY NELSON')).toBe('MARY NELSON')
    expect(suggestRuleText('EFTPOS COUNTDOWN HAMILTON')).toBe('COUNTDOWN HAMILTON')
  })

  it('does not take a place off if that leaves a name that stops short, or leaves only a word that belongs to the place', () => {
    expect(suggestRuleText('BANK OF NEW ZEALAND')).toBe('BANK OF NEW ZEALAND') // "BANK OF" is not a name, and would find every bank
    expect(suggestRuleText('EFTPOS THE WAREHOUSE AND NEW LYNN')).toBe('THE WAREHOUSE AND NEW LYNN') // "THE WAREHOUSE AND" stops short too
    expect(suggestRuleText('LAKE TAUPO')).toBe('LAKE TAUPO') // all there is
    expect(suggestRuleText('MOUNT MAUNGANUI')).toBe('MOUNT MAUNGANUI')
  })

  it('keeps a dash between the words of a description, so a bank\'s own words are not cut to the half that finds everything', () => {
    // "ASB BANK" alone is in every Transaction the bank itself makes; the dash is part of how the bank wrote it.
    expect(suggestRuleText('ASB BANK - INTEREST')).toBe('ASB BANK - INTEREST')
    expect(suggestRuleText('PAYPAL - SPOTIFY 4029357733')).toBe('PAYPAL - SPOTIFY')
    // But a dash beside a number or at an end is not between words.
    expect(suggestRuleText('EFTPOS 1234 - COUNTDOWN')).toBe('COUNTDOWN')
    expect(suggestRuleText('COUNTDOWN - 1234')).toBe('COUNTDOWN')
  })

  it('only takes a place off the end', () => {
    expect(suggestRuleText('AUCKLAND TRANSPORT HOP CARD')).toBe('AUCKLAND TRANSPORT HOP CARD')
    expect(suggestRuleText('WELLINGTON ZOO SHOP')).toBe('WELLINGTON ZOO SHOP')
  })

  it('falls back to the whole description when nothing of a merchant is left', () => {
    expect(suggestRuleText('12/10 1234')).toBe('12/10 1234')
    expect(suggestRuleText('EFTPOS 4835 12OCT')).toBe('EFTPOS 4835 12OCT')
    expect(suggestRuleText('  POS  ')).toBe('POS')
  })

  it('has nothing to suggest only for a blank description', () => {
    expect(suggestRuleText('')).toBe('')
    expect(suggestRuleText('   ')).toBe('')
  })

  it('stops at 100 characters, the most a Rule can look for, at the end of a word', () => {
    const long = `EFTPOS ${'ABCDEFGHI '.repeat(15)}`
    const suggested = suggestRuleText(long)
    expect(suggested.length).toBeLessThanOrEqual(100)
    expect(suggested.endsWith('ABCDEFGHI')).toBe(true)
    expect(suggestRuleText('X'.repeat(150))).toHaveLength(100)
  })

  it('always suggests words that are in the description as they are written, so the Rule matches the Transaction it was made from', () => {
    const descriptions = [...merchants.map(([description]) => description), 'MĀORI MARKET  ŌTĀKOU 1234', 'a/b c.d e-f g_h', 'Café du Monde 12/10', '###', '*', '4835 4835 4835 4835', 'EFTPOS EFTPOS EFTPOS']
    for (const description of descriptions) {
      const suggested = suggestRuleText(description)
      expect(description, description).toContain(suggested)
      if (description.trim() !== '') expect(suggested, description).not.toBe('')
    }
  })
})
