import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { AKAHU_SYNC, D1_USAGE, MEMBER_KEY, requireFeature } from './features'
import worker from './index'

// Fake token values, deliberately recognisable so a leak into a response is obvious.
const APP_TOKEN = 'app_token_SECRET_VALUE_1'
const USER_TOKEN = 'user_token_SECRET_VALUE_2'

type Features = { features: { id: string; name: string; enabled: boolean; message?: string }[] }

/** Calls the Worker with Akahu's secrets set or unset, which is why this goes through `worker.fetch` rather than the exported handler. */
async function getFeatures(as: 'admin' | 'member', secrets: Partial<Env> = {}) {
  const ctx = createExecutionContext()
  const request = new Request('http://localhost:5173/api/features', { headers: { Cookie: `fernledger_dev_as=${as}` } })
  const res = await worker.fetch!(request as never, { ...env, AKAHU_APP_TOKEN: undefined, AKAHU_USER_TOKEN: undefined, ...secrets }, ctx)
  await waitOnExecutionContext(ctx)
  return { res, text: await res.clone().text(), body: (await res.json()) as Features }
}

const akahu = (features: Features) => features.features.find((feature) => feature.id === AKAHU_SYNC.id)!

describe('GET /api/features', () => {
  it('tells the Admin what to set up and how, when Akahu Sync has no tokens', async () => {
    const { res, body } = await getFeatures('admin')
    expect(res.status).toBe(200)
    expect(akahu(body)).toEqual({
      id: 'akahu-sync',
      name: 'Akahu Sync',
      enabled: false,
      message:
        'Optional: you only need this to use Akahu Sync. ' +
        'Setup needed: the Akahu app token. Add it as the Worker secret AKAHU_APP_TOKEN. ' +
        'Setup needed: the Akahu user token. Add it as the Worker secret AKAHU_USER_TOKEN.',
    })
  })

  it('gives a Member a neutral message with no detail of what or how', async () => {
    const { body, text } = await getFeatures('member')
    expect(akahu(body)).toEqual({ id: 'akahu-sync', name: 'Akahu Sync', enabled: false, message: "Akahu Sync isn't set up yet." })
    expect(text).not.toMatch(/AKAHU_|secret|token/i)
  })

  it('names only what is still missing', async () => {
    const { body } = await getFeatures('admin', { AKAHU_APP_TOKEN: APP_TOKEN })
    expect(akahu(body).enabled).toBe(false)
    expect(akahu(body).message).toBe(
      'Optional: you only need this to use Akahu Sync. Setup needed: the Akahu user token. Add it as the Worker secret AKAHU_USER_TOKEN.',
    )
  })

  // The Summary and the Dashboard ask for it on every visit, for the Balances table's Sync column, so it must cost no D1 row (ADR 0004): with a database that throws on any use, it still answers.
  it('reads nothing from the database, for the Admin or a Member', async () => {
    const database = new Proxy({}, {
      get: (_target, property) => {
        throw new Error(`The database was used: ${String(property)}`)
      },
    }) as unknown as D1Database
    for (const as of ['admin', 'member'] as const) {
      const { res, body } = await getFeatures(as, { DB: database })
      expect(res.status, as).toBe(200)
      expect(body.features.map((feature) => feature.id), as).toEqual([AKAHU_SYNC.id, D1_USAGE.id, MEMBER_KEY.id])
    }
  })

  it('treats a blank value as missing', async () => {
    const { body } = await getFeatures('admin', { AKAHU_APP_TOKEN: '  ', AKAHU_USER_TOKEN: '' })
    expect(akahu(body).enabled).toBe(false)
  })

  it('enables the feature once everything it needs is set, and never returns a secret value', async () => {
    for (const as of ['admin', 'member'] as const) {
      const { body, text } = await getFeatures(as, { AKAHU_APP_TOKEN: APP_TOKEN, AKAHU_USER_TOKEN: USER_TOKEN })
      expect(akahu(body)).toEqual({ id: 'akahu-sync', name: 'Akahu Sync', enabled: true })
      expect(text).not.toContain('SECRET_VALUE')
    }
  })

  it('never returns a secret value while still disabled', async () => {
    const { text } = await getFeatures('admin', { AKAHU_APP_TOKEN: APP_TOKEN })
    expect(text).not.toContain('SECRET_VALUE')
  })

  it('is refused to a visitor who is not signed in', async () => {
    const res = await exports.default.fetch(new Request('https://app.test/api/features'))
    expect(res.status).toBe(401)
  })
})

describe('the D1 usage bar', () => {
  const usage = (features: Features) => features.features.find((feature) => feature.id === D1_USAGE.id)!
  const off = { CF_ANALYTICS_TOKEN: undefined, CF_ACCOUNT_ID: undefined }

  it('tells the Admin it is optional, and what to set up and how, when neither secret is set', async () => {
    const { body } = await getFeatures('admin', off)
    expect(usage(body)).toEqual({
      id: 'd1-usage',
      name: 'D1 usage bar',
      enabled: false,
      message:
        'Optional: you only need this to use the D1 usage bar. ' +
        'Setup needed: the Cloudflare analytics token. Add it as the Worker secret CF_ANALYTICS_TOKEN. ' +
        'Setup needed: the Cloudflare account ID. Add it as the Worker secret CF_ACCOUNT_ID. ' +
        'The steps are in docs/setup.md, under "D1 usage bar (optional)".',
    })
  })

  it('names only what is still missing, and gives a Member no detail', async () => {
    const half = { ...off, CF_ANALYTICS_TOKEN: 'cf_token_SECRET_VALUE_1' }
    expect(usage((await getFeatures('admin', half)).body).message).toBe(
      'Optional: you only need this to use the D1 usage bar. Setup needed: the Cloudflare account ID. Add it as the Worker secret CF_ACCOUNT_ID. ' +
        'The steps are in docs/setup.md, under "D1 usage bar (optional)".',
    )
    const member = await getFeatures('member', half)
    expect(usage(member.body)).toEqual({ id: 'd1-usage', name: 'D1 usage bar', enabled: false, message: "The D1 usage bar isn't set up yet." })
    expect(member.text).not.toMatch(/CF_|SECRET_VALUE|setup\.md/)
  })

  it('leaves Akahu Sync as it was: no "the", and no steps to point to', async () => {
    const { body } = await getFeatures('admin')
    expect(akahu(body).message).not.toContain('setup.md')
    expect(akahu(body).message).toContain('to use Akahu Sync.')
    expect(akahu((await getFeatures('member')).body).message).toBe("Akahu Sync isn't set up yet.")
  })

  it("asks the Admin to run npm run deploy for the Members' read count key, and is on once it is set", async () => {
    const key = (body: Features) => body.features.find((feature) => feature.id === MEMBER_KEY.id)!
    expect(key((await getFeatures('admin')).body)).toEqual({
      id: 'member-key',
      name: "Members' read count key",
      enabled: false,
      message: "Setup needed: the key for the Members' read counts. Run npm run deploy, which sets the Worker secret MEMBER_KEY_SECRET.",
    })
    expect(key((await getFeatures('member')).body).message).toBe("The Members' read count key isn't set up yet.")
    const { body, text } = await getFeatures('admin', { MEMBER_KEY_SECRET: 'member_key_SECRET_VALUE_1' })
    expect(key(body)).toEqual({ id: 'member-key', name: "Members' read count key", enabled: true })
    expect(text).not.toContain('SECRET_VALUE')
  })

  it('is on once both are set, and says nothing of their values', async () => {
    for (const as of ['admin', 'member'] as const) {
      const { body, text } = await getFeatures(as, { CF_ANALYTICS_TOKEN: 'cf_token_SECRET_VALUE_1', CF_ACCOUNT_ID: 'account_SECRET_VALUE_2' })
      expect(usage(body)).toEqual({ id: 'd1-usage', name: 'D1 usage bar', enabled: true })
      expect(text).not.toContain('SECRET_VALUE')
    }
  })
})

describe('requireFeature', () => {
  const guarded = new Hono<{ Bindings: Env }>().get('/sync', requireFeature(AKAHU_SYNC), (c) => c.json({ ran: true }))

  it('stops a request to a feature that is not set up, saying only that it is not set up', async () => {
    const res = await guarded.request('/sync', {}, { ...env, AKAHU_APP_TOKEN: APP_TOKEN, AKAHU_USER_TOKEN: undefined })
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'Not set up', feature: 'akahu-sync' })
    expect(text).not.toContain('SECRET_VALUE')
  })

  it('lets the request through once the feature is set up', async () => {
    const res = await guarded.request('/sync', {}, { ...env, AKAHU_APP_TOKEN: APP_TOKEN, AKAHU_USER_TOKEN: USER_TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ran: true })
  })
})
