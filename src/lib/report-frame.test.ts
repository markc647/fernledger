import { describe, expect, it } from 'vitest'
import { cssString, describeRange, generatedLine, runningHead } from './report-frame'

describe('describeRange', () => {
  it('writes both ends the way the rest of the app writes a date', () => {
    expect(describeRange('2026-10-01', '2026-10-31')).toBe('Thu 1 Oct 2026 to Sat 31 Oct 2026')
  })
  it('writes a single day once', () => {
    expect(describeRange('2026-10-08', '2026-10-08')).toBe('Thu 8 Oct 2026')
  })
})

describe('generatedLine', () => {
  it('says when and by whom, with the time in NZ whatever the device\'s zone', () => {
    expect(generatedLine(new Date('2026-10-08T02:42:00.000Z'), 'admin@example.com')).toBe('Generated Thu 8 Oct 2026 at 3:42 pm by admin@example.com')
  })
})

describe('runningHead', () => {
  const parts = { appTitle: "Mum's finances", name: 'Transaction listing', accounts: 'Example savings', range: 'Thu 1 Oct 2026 to Sat 31 Oct 2026' }
  it('carries the title, the Report, the Account and the dates', () => {
    expect(runningHead(parts)).toBe("Mum's finances · Transaction listing · Example savings · Thu 1 Oct 2026 to Sat 31 Oct 2026")
  })
  it('stops at 200 characters with an ellipsis, so a long list of Accounts can\'t outgrow the page margin', () => {
    const head = runningHead({ ...parts, accounts: 'Example account name that goes on and on, '.repeat(20) })
    expect(Array.from(head)).toHaveLength(200)
    expect(head.endsWith('…')).toBe(true)
  })
  it('does not cut a character in two', () => {
    const head = runningHead({ ...parts, appTitle: '😀'.repeat(150) })
    expect(head).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/) // no lone half of a pair
  })
})

describe('cssString (the text of a page margin, set as a CSS custom property)', () => {
  it('quotes the text', () => {
    expect(cssString("Mum's finances")).toBe('"Mum\'s finances"')
  })
  it('escapes a quote and a backslash, so the text can\'t end the string and add CSS of its own', () => {
    expect(cssString('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(cssString('"; } body { display: none; } /*')).toBe('"\\"; } body { display: none; } /*"')
  })
  it('turns line breaks into spaces, which a CSS string can\'t hold', () => {
    expect(cssString('one\ntwo\r\nthree\ffour')).toBe('"one two three four"')
  })
})
