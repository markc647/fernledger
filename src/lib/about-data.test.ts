import { describe, expect, it } from 'vitest'
import { contactLine, retentionLine } from './about-data'

describe.each([
  ['contact', contactLine],
  ['retention', retentionLine],
])('the %s line on the About your data page', (_name, line) => {
  it("shows the Admin's own words, trimmed, to the Admin and to a Member", () => {
    for (const role of ['admin', 'member'] as const) {
      expect(line('  Sam, sam@example.com  ', role)).toEqual({ kind: 'set', text: 'Sam, sam@example.com' })
    }
  })

  it('tells the Admin what to set up, in the same "Setup needed" words as the rest of the app', () => {
    for (const unset of ['', '   \n ']) {
      const result = line(unset, 'admin')
      expect(result.kind).toBe('setup')
      expect(result.text).toMatch(/^Setup needed: /)
    }
  })

  it('gives a Member a neutral line, with no mention of setup', () => {
    for (const unset of ['', '   ']) {
      const result = line(unset, 'member')
      expect(result.kind).toBe('neutral')
      expect(result.text).not.toMatch(/setup|settings/i)
    }
  })

  it('fails closed while the role is not known yet: never the Admin guidance', () => {
    expect(line('', undefined).kind).toBe('neutral')
  })
})

describe('the neutral lines', () => {
  it('send a Member to the person who invited them, and say the retention is not written down yet', () => {
    expect(contactLine('', 'member').text).toMatch(/invited you/)
    expect(retentionLine('', 'member').text).toMatch(/hasn't said/)
  })
})
