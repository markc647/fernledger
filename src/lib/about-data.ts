import type { Role } from './role'

/**
 * What the About your data page says for a Setting the Admin fills in (Settings, "About your data").
 * `set` is the Admin's own words; `setup` is guidance for the Admin; `neutral` is what a Member reads until it is set.
 */
export type SettingLine = { kind: 'set' | 'setup' | 'neutral'; text: string }

function line(value: string, role: Role | undefined, unset: { setup: string; neutral: string }): SettingLine {
  const text = value.trim()
  if (text) return { kind: 'set', text }
  // Only a known Admin is told to set anything up. While the role is loading, or for a Member, the line is neutral.
  return role === 'admin' ? { kind: 'setup', text: `Setup needed: ${unset.setup}` } : { kind: 'neutral', text: unset.neutral }
}

export const contactLine = (contact: string, role: Role | undefined) =>
  line(contact, role, {
    setup: 'say who Members should ask about this data. Add it under About your data in Settings.',
    neutral: 'Ask the person who invited you to Fernledger.',
  })

export const retentionLine = (retention: string, role: Role | undefined) =>
  line(retention, role, {
    setup: 'say how long the data is kept. Add it under About your data in Settings.',
    neutral: "The Admin hasn't said yet how long the data is kept.",
  })
