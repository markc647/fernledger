import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Member } from './auth'
import { recordChange, type ChangeLogRow } from './changelog'
import { getSetting, putSetting } from './settings'

const admin: Member = { email: 'admin@example.com', role: 'admin' }
const changeLog = async () => (await env.DB.prepare('SELECT * FROM change_log ORDER BY id').all<ChangeLogRow>()).results

// Each test starts from the same known state, so the order tests run in doesn't matter.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM change_log'), env.DB.prepare('DELETE FROM settings'), putSetting(env.DB, 'app_title', 'Starting title')])
})

describe('recordChange', () => {
  it('writes the change and its Change Log entry together', async () => {
    const before = Date.now()
    await recordChange(env.DB, putSetting(env.DB, 'app_title', "Mum's finances"), {
      actor: admin,
      type: 'settings',
      summary: 'Changed the app title',
      before: { app_title: 'Starting title' },
      after: { app_title: "Mum's finances" },
    })

    expect(await getSetting(env.DB, 'app_title')).toBe("Mum's finances")
    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      actor: 'admin@example.com',
      type: 'settings',
      summary: 'Changed the app title',
      before: '{"app_title":"Starting title"}',
      after: '{"app_title":"Mum\'s finances"}',
    })
    expect(Date.parse(entry!.at)).toBeGreaterThanOrEqual(before - 1000) // when: an ISO UTC time
    expect(Date.parse(entry!.at)).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('takes several statements, and stores a missing before or after as null', async () => {
    await recordChange(env.DB, [putSetting(env.DB, 'about_contact', 'Sam'), putSetting(env.DB, 'about_retention', 'Forever')], {
      actor: admin,
      type: 'settings',
      summary: 'Filled in About your data',
    })

    expect(await getSetting(env.DB, 'about_contact')).toBe('Sam')
    expect(await getSetting(env.DB, 'about_retention')).toBe('Forever')
    expect(await changeLog()).toMatchObject([{ summary: 'Filled in About your data', before: null, after: null }])
  })

  describe('for a mutation that may find it has nothing to do (onlyIfChanged)', () => {
    const rename = (from: string, to: string) => env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'app_title' AND value = ?").bind(to, from)
    const entry = { actor: admin, type: 'settings', summary: 'Changed the app title', onlyIfChanged: true } as const

    it('writes the entry when the mutation changed a row', async () => {
      await recordChange(env.DB, rename('Starting title', 'Changed'), entry)

      expect(await getSetting(env.DB, 'app_title')).toBe('Changed')
      expect(await changeLog()).toMatchObject([{ summary: 'Changed the app title' }])
    })

    it('writes nothing when the mutation changed no row, so a change that did not happen has no entry', async () => {
      await recordChange(env.DB, rename('Some other title', 'Changed'), entry)

      expect(await getSetting(env.DB, 'app_title')).toBe('Starting title')
      expect(await changeLog()).toEqual([])
    })

    it('goes by the last statement of several', async () => {
      await recordChange(env.DB, [putSetting(env.DB, 'about_contact', 'Sam'), rename('Some other title', 'Changed')], entry)

      expect(await getSetting(env.DB, 'about_contact')).toBe('Sam') // the first statement still ran
      expect(await changeLog()).toEqual([])
    })

    it('is not the default: a change without it always has its entry', async () => {
      await recordChange(env.DB, rename('Some other title', 'Changed'), { actor: admin, type: 'settings', summary: 'Tried to change the app title' })

      expect(await changeLog()).toMatchObject([{ summary: 'Tried to change the app title' }])
    })
  })

  it('leaves no entry, and no partial change, when a mutation fails', async () => {
    const failing = [putSetting(env.DB, 'app_title', 'Should not stick'), env.DB.prepare('INSERT INTO no_such_table (x) VALUES (1)')]

    await expect(recordChange(env.DB, failing, { actor: admin, type: 'settings', summary: 'Will fail' })).rejects.toThrow()

    expect(await changeLog()).toEqual([])
    expect(await getSetting(env.DB, 'app_title')).toBe('Starting title')
  })

  it('leaves no change behind when the entry cannot be written', async () => {
    // The entry's actor is NOT NULL, so the entry is refused after the mutation ran inside the same batch.
    const noActor = { actor: { email: null } as unknown as Member, type: 'settings' as const, summary: 'Will fail' }

    await expect(recordChange(env.DB, putSetting(env.DB, 'app_title', 'Should not stick'), noActor)).rejects.toThrow()

    expect(await changeLog()).toEqual([])
    expect(await getSetting(env.DB, 'app_title')).toBe('Starting title')
  })
})
