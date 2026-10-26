import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChangeLogRow } from './changelog'
import { DEFAULT_SETTINGS, readSettings, rejectedFields } from './settings'
import { callWhileInterrupted } from './test-support'
import { CHANGED_MEANWHILE } from './validate'

// Signed in through the localhost dev identity (the cookie picks the role), so these tests exercise the real guard and handlers.
const origin = 'http://localhost:5173'

type Options = { as?: 'admin' | 'member'; method?: string; body?: unknown; rawBody?: string; contentType?: string; origin?: string }

const send = (path: string, { as, method = 'GET', body, rawBody, contentType = 'application/json', origin: from = origin }: Options = {}) => {
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  const headers: Record<string, string> = {}
  if (as) headers.Cookie = `fernledger_dev_as=${as}`
  if (payload !== undefined) Object.assign(headers, { 'Content-Type': contentType, Origin: from })
  return exports.default.fetch(new Request(`${origin}${path}`, { method, headers, body: payload }))
}

const changeLog = async () => (await env.DB.prepare('SELECT * FROM change_log ORDER BY id').all<ChangeLogRow>()).results

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM change_log'), env.DB.prepare('DELETE FROM settings')])
})

describe('GET /api/settings', () => {
  it('gives a Member the defaults before anything is set', async () => {
    const res = await send('/api/settings', { as: 'member' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ app_title: 'Fernledger', about_contact: '', about_retention: '', cloudflare_plan: 'free' })
  })
})

describe('PATCH /api/settings', () => {
  it('lets the Admin change Settings, and logs the change with before and after', async () => {
    const res = await send('/api/settings', { as: 'admin', method: 'PATCH', body: { app_title: "Mum's finances", about_contact: 'Sam, 021 000 0000' } })
    expect(res.status).toBe(200)
    const expected = { app_title: "Mum's finances", about_contact: 'Sam, 021 000 0000', about_retention: '', cloudflare_plan: 'free' }
    expect(await res.json()).toEqual(expected)
    expect(await (await send('/api/settings', { as: 'member' })).json()).toEqual(expected)

    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      actor: 'admin@example.com',
      type: 'settings',
      summary: 'Changed settings: app title, contact',
      before: JSON.stringify({ app_title: 'Fernledger', about_contact: '' }),
      after: JSON.stringify({ app_title: "Mum's finances", about_contact: 'Sam, 021 000 0000' }),
    })
  })

  it('lets the Admin say the Cloudflare account is on the Paid plan, and back, logging each', async () => {
    const res = await send('/api/settings', { as: 'admin', method: 'PATCH', body: { cloudflare_plan: 'paid' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cloudflare_plan: 'paid' })
    expect(await (await send('/api/settings', { as: 'member' })).json()).toMatchObject({ cloudflare_plan: 'paid' })
    await send('/api/settings', { as: 'admin', method: 'PATCH', body: { cloudflare_plan: 'free' } })
    const entries = await changeLog()
    expect(entries.map((entry) => [entry.summary, entry.before, entry.after])).toEqual(
      expect.arrayContaining([
        ['Changed settings: Cloudflare plan', JSON.stringify({ cloudflare_plan: 'free' }), JSON.stringify({ cloudflare_plan: 'paid' })],
        ['Changed settings: Cloudflare plan', JSON.stringify({ cloudflare_plan: 'paid' }), JSON.stringify({ cloudflare_plan: 'free' })],
      ]),
    )
  })

  it('changes only the Settings sent, and trims them', async () => {
    await send('/api/settings', { as: 'admin', method: 'PATCH', body: { about_retention: 'Kept until you ask' } })
    const res = await send('/api/settings', { as: 'admin', method: 'PATCH', body: { app_title: '  Nan  ' } })
    expect(await res.json()).toEqual({ app_title: 'Nan', about_contact: '', about_retention: 'Kept until you ask', cloudflare_plan: 'free' })
  })

  it('lets the Admin clear the About-your-data fields but not the title', async () => {
    await send('/api/settings', { as: 'admin', method: 'PATCH', body: { about_contact: 'Sam' } })
    const cleared = await send('/api/settings', { as: 'admin', method: 'PATCH', body: { about_contact: '  ' } })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ about_contact: '' })

    const blankTitle = await send('/api/settings', { as: 'admin', method: 'PATCH', body: { app_title: '   ' } })
    expect(blankTitle.status).toBe(400)
  })

  it('writes nothing, and logs nothing, when nothing changed', async () => {
    await send('/api/settings', { as: 'admin', method: 'PATCH', body: { app_title: 'Nan' } })
    const same = await send('/api/settings', { as: 'admin', method: 'PATCH', body: { app_title: 'Nan', about_contact: '' } })
    expect(same.status).toBe(200)
    expect(await changeLog()).toHaveLength(1)
  })

  // Another request can land between the handler's read and its write. The write sets the Settings only if each still holds what was read, all of them or none, and
  // with `onlyIfChanged` a request that changes nothing writes no entry: the Change Log never says a Setting changed from a value it no longer had.
  describe('when another request lands between this one\'s read and its write', () => {
    const patch = (body: object) => () => send('/api/settings', { as: 'admin', method: 'PATCH', body })
    const interrupted = (body: object, before: () => Promise<unknown>) => callWhileInterrupted('/api/settings', 'PATCH', body, before)

    it('writes no second entry for the same value, and says it is so', async () => {
      const res = await interrupted({ app_title: 'Nan' }, patch({ app_title: 'Nan' }))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ...DEFAULT_SETTINGS, app_title: 'Nan' })
      expect(await changeLog()).toMatchObject([{ summary: 'Changed settings: app title', before: '{"app_title":"Fernledger"}', after: '{"app_title":"Nan"}' }])
    })

    it('does not overwrite a value set meanwhile, writes no entry, and says to try again', async () => {
      const res = await interrupted({ app_title: 'Dad' }, patch({ app_title: 'Nan' }))

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual(CHANGED_MEANWHILE)
      expect((await readSettings(env.DB)).app_title).toBe('Nan')
      expect(await changeLog()).toMatchObject([{ summary: 'Changed settings: app title', after: '{"app_title":"Nan"}' }])
    })

    it('writes none of its Settings when one of them went stale, and logs only the other request', async () => {
      const res = await interrupted({ app_title: 'Dad', about_contact: 'Sam' }, patch({ about_contact: 'Alex' }))

      expect(res.status).toBe(409)
      expect(await readSettings(env.DB)).toEqual({ ...DEFAULT_SETTINGS, about_contact: 'Alex' })
      expect(await changeLog()).toMatchObject([{ summary: 'Changed settings: contact', before: '{"about_contact":""}', after: '{"about_contact":"Alex"}' }])
    })

    it('writes all of its Settings, in one entry, when none went stale', async () => {
      const res = await interrupted({ app_title: 'Dad', about_contact: 'Sam' }, patch({ about_retention: 'Kept' }))

      expect(res.status).toBe(200)
      expect(await readSettings(env.DB)).toEqual({ app_title: 'Dad', about_contact: 'Sam', about_retention: 'Kept', cloudflare_plan: 'free' })
      expect(await changeLog()).toMatchObject([{ summary: 'Changed settings: retention' }, { summary: 'Changed settings: app title, contact', before: '{"app_title":"Fernledger","about_contact":""}' }])
    })
  })

  describe('refuses', () => {
    const logAndSettingsUntouched = async () => {
      expect(await changeLog()).toEqual([])
      expect(await (await send('/api/settings', { as: 'member' })).json()).toEqual({ app_title: 'Fernledger', about_contact: '', about_retention: '', cloudflare_plan: 'free' })
    }

    it('a Member, without writing or logging anything', async () => {
      const res = await send('/api/settings', { as: 'member', method: 'PATCH', body: { app_title: 'Hijacked' } })
      expect(res.status).toBe(403)
      await logAndSettingsUntouched()
    })

    it('a visitor who is not signed in', async () => {
      const res = await exports.default.fetch(
        new Request('https://app.test/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' }, body: '{"app_title":"x"}' }),
      )
      expect(res.status).toBe(401)
      await logAndSettingsUntouched()
    })

    it('a write from another origin, and one that is not JSON', async () => {
      const body = { app_title: 'Hijacked' }
      expect((await send('/api/settings', { as: 'admin', method: 'PATCH', body, origin: 'https://evil.test' })).status).toBe(403)
      expect((await send('/api/settings', { as: 'admin', method: 'PATCH', rawBody: 'app_title=x', contentType: 'text/plain' })).status).toBe(415)
      await logAndSettingsUntouched()
    })

    it.each([
      ['a title that is blank', { app_title: ' ' }, ['app_title']],
      ['a title over 60 characters', { app_title: 'x'.repeat(61) }, ['app_title']],
      ['a contact over 500 characters', { about_contact: 'x'.repeat(501) }, ['about_contact']],
      ['a retention that is not text', { about_retention: 7 }, ['about_retention']],
      ['a Cloudflare plan that is neither free nor paid', { cloudflare_plan: 'business' }, ['cloudflare_plan']],
      ['several bad fields at once', { app_title: '', about_contact: null }, ['app_title', 'about_contact']],
    ])('%s, naming the field and never echoing the value', async (_name, body, fields) => {
      const res = await send('/api/settings', { as: 'admin', method: 'PATCH', body })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid settings', fields })
      await logAndSettingsUntouched()
    })

    it('a body that is not valid JSON, or not an object', async () => {
      for (const rawBody of ['{not json', '"text"', 'null', '[]']) {
        expect((await send('/api/settings', { as: 'admin', method: 'PATCH', rawBody })).status).toBe(400)
      }
      await logAndSettingsUntouched()
    })

    it('trying to set the Admin, which is the ADMIN_EMAIL secret and never a Setting', async () => {
      for (const body of [{ admin_email: 'me@example.com' }, { adminEmail: 'me@example.com' }, { app_title: 'Ok', admin_email: 'me@example.com' }]) {
        const res = await send('/api/settings', { as: 'admin', method: 'PATCH', body })
        expect(res.status).toBe(400)
      }
      await logAndSettingsUntouched()
      expect(await env.DB.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE '%admin%'").first('n')).toBe(0)
    })
  })
})

describe('readSettings', () => {
  it('ignores a stored key that is not a Setting, even one named like a built-in property', async () => {
    await env.DB.batch(
      ['constructor', 'toString', '__proto__', 'unknown'].map((key) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, 'x')),
    )
    const settings = await readSettings(env.DB)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })
})

describe('rejectedFields', () => {
  it('names each rejected Setting once, in order, and nothing else', () => {
    expect(rejectedFields([{ path: ['about_contact'] }, { path: ['app_title'] }, { path: ['about_contact'] }])).toEqual(['about_contact', 'app_title'])
  })

  it('skips issues that are not about one field, such as an unknown key or a body that is not an object', () => {
    expect(rejectedFields([{ path: [] }, { path: [0] }, { path: [Symbol('x')] }])).toEqual([])
  })
})
