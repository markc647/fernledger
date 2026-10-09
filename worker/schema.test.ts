import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { getSetting, putSetting } from './settings'

describe('settings', () => {
  it('hold the app title and About-your-data fields, one value per key', async () => {
    await env.DB.batch([
      putSetting(env.DB, 'app_title', "Mum's finances"),
      putSetting(env.DB, 'about_contact', 'Sam, 021 000 0000'),
      putSetting(env.DB, 'about_retention', 'Kept until the Admin deletes it'),
    ])
    expect(await getSetting(env.DB, 'app_title')).toBe("Mum's finances")
    expect(await getSetting(env.DB, 'about_contact')).toBe('Sam, 021 000 0000')
    expect(await getSetting(env.DB, 'about_retention')).toBe('Kept until the Admin deletes it')

    await putSetting(env.DB, 'app_title', 'Dad\'s finances').run()
    expect(await getSetting(env.DB, 'app_title')).toBe("Dad's finances")
    const { n } = (await env.DB.prepare('SELECT count(*) AS n FROM settings').first<{ n: number }>())!
    expect(n).toBe(3) // updated in place, not duplicated
  })

  it('read as null when never set', async () => {
    await env.DB.prepare('DELETE FROM settings').run()
    expect(await getSetting(env.DB, 'app_title')).toBeNull()
  })

  it('have no place for the Admin, who is the ADMIN_EMAIL secret (ADR 0002)', async () => {
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('settings')").all<{ name: string }>()
    expect(columns.results.map((c) => c.name)).toEqual(['key', 'value'])
  })
})
