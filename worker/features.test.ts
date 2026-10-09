import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { AKAHU_SYNC, requireFeature } from './features'
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
