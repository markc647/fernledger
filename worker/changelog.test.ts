import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { recordChange, type ChangeLogRow } from './changelog'

const setSetting = (key: string, value: string) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value)
const settingValue = (key: string) => env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<string>('value')
const changeLog = async () => (await env.DB.prepare('SELECT * FROM change_log ORDER BY id').all<ChangeLogRow>()).results

describe('recordChange', () => {
  it('writes the change and its Change Log entry together', async () => {
    const before = Date.now()
    await recordChange(env.DB, setSetting('app_title', "Mum's finances"), {
      actor: 'admin@example.com',
      summary: 'Changed the app title',
      before: { app_title: null },
      after: { app_title: "Mum's finances" },
    })

    expect(await settingValue('app_title')).toBe("Mum's finances")
    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      actor: 'admin@example.com',
      summary: 'Changed the app title',
      before: '{"app_title":null}',
      after: '{"app_title":"Mum\'s finances"}',
    })
    expect(Date.parse(entry!.at)).toBeGreaterThanOrEqual(before - 1000) // when: an ISO UTC time
    expect(Date.parse(entry!.at)).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('takes several statements, and stores a missing before or after as null', async () => {
    await recordChange(env.DB, [setSetting('about_contact', 'Sam'), setSetting('about_retention', 'Forever')], {
      actor: 'admin@example.com',
      summary: 'Filled in About your data',
    })

    expect(await settingValue('about_contact')).toBe('Sam')
    expect(await settingValue('about_retention')).toBe('Forever')
    const entry = (await changeLog()).at(-1)
    expect(entry).toMatchObject({ summary: 'Filled in About your data', before: null, after: null })
  })

  it('leaves no entry, and no partial change, when a mutation fails', async () => {
    const entriesBefore = (await changeLog()).length
    const failing = [setSetting('app_title', 'Should not stick'), env.DB.prepare('INSERT INTO no_such_table (x) VALUES (1)')]

    await expect(recordChange(env.DB, failing, { actor: 'admin@example.com', summary: 'Will fail' })).rejects.toThrow()

    expect(await changeLog()).toHaveLength(entriesBefore)
    expect(await settingValue('app_title')).toBe("Mum's finances")
  })

  it('leaves no change behind when the entry cannot be written', async () => {
    const entriesBefore = (await changeLog()).length
    // actor is NOT NULL, so the entry is refused after the mutation ran inside the same batch.
    const bad = { actor: null as unknown as string, summary: 'Will fail' }

    await expect(recordChange(env.DB, setSetting('app_title', 'Should not stick'), bad)).rejects.toThrow()

    expect(await changeLog()).toHaveLength(entriesBefore)
    expect(await settingValue('app_title')).toBe("Mum's finances")
  })
})
