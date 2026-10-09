import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const setting = (key: string, value: string) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, value)

describe('settings', () => {
  it('hold the app title and About-your-data fields, one value per key', async () => {
    await env.DB.batch([
      setting('app_title', "Mum's finances"),
      setting('about_contact', 'Sam, 021 000 0000'),
      setting('about_retention', 'Kept until the Admin deletes it'),
    ])
    const { results } = await env.DB.prepare('SELECT key, value FROM settings ORDER BY key').all()
    expect(results).toEqual([
      { key: 'about_contact', value: 'Sam, 021 000 0000' },
      { key: 'about_retention', value: 'Kept until the Admin deletes it' },
      { key: 'app_title', value: "Mum's finances" },
    ])
    await expect(setting('app_title', 'Again').run()).rejects.toThrow()
  })

  it('have no place for the Admin, who is the ADMIN_EMAIL secret (ADR 0002)', async () => {
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('settings')").all<{ name: string }>()
    expect(columns.results.map((c) => c.name)).toEqual(['key', 'value'])
  })
})
