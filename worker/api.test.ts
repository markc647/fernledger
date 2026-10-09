import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import worker from './index'

const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`
let signingKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] }
  // Access's key set is faked at the Worker's outbound fetch; any other outbound fetch is a bug (no network in tests).
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new Request(input).url
    if (url === `${issuer}/cdn-cgi/access/certs`) return Response.json(jwks)
    throw new Error(`Unexpected outbound fetch in test: ${url}`)
  })
})
afterAll(() => vi.unstubAllGlobals())

type SignOptions = { aud?: string; iss?: string; exp?: number; key?: CryptoKey }

const sign = (claims: Record<string, unknown>, opts: SignOptions = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? env.ACCESS_AUD!)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? signingKey)

type CallOptions = { token?: string; method?: string; headers?: Record<string, string>; origin?: string }

/**
 * Goes through the Worker's exported handler with the env configured in vitest.config.ts.
 * The test env has no assets layer, so `assets.run_worker_first` isn't exercised here;
 * browser-level asset routing belongs to the Playwright seam (ticket 03).
 */
async function call(path: string, opts: CallOptions = {}) {
  const headers = { ...opts.headers, ...(opts.token ? { 'Cf-Access-Jwt-Assertion': opts.token } : {}) }
  return exports.default.fetch(new Request(`${opts.origin ?? 'https://app.test'}${path}`, { method: opts.method ?? 'GET', headers }))
}

/** Calls the Worker's fetch handler directly, only for cases that change the Worker's settings or origin. */
async function callWith(url: string, envOverride: Partial<Env>, opts: CallOptions = {}) {
  const headers = { ...opts.headers, ...(opts.token ? { 'Cf-Access-Jwt-Assertion': opts.token } : {}) }
  const ctx = createExecutionContext()
  const response = await worker.fetch!(new Request(url, { method: opts.method ?? 'GET', headers }) as never, { ...env, ...envOverride }, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('GET /api/me', () => {
  it('recognises the Admin by email, case-insensitively', async () => {
    const res = await call('/api/me', { token: await sign({ email: 'ADMIN@example.com' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'admin@example.com', role: 'admin' })
  })

  it('treats any other signed-in Member as read-only', async () => {
    const res = await call('/api/me', { token: await sign({ email: 'sib@example.com' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'sib@example.com', role: 'member' })
  })

  it('accepts unusual but valid email addresses', async () => {
    const res = await call('/api/me', { token: await sign({ email: "o'brien+family@intranet" }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: "o'brien+family@intranet", role: 'member' })
  })
})

describe('Access verification on /api', () => {
  it('rejects a missing token', async () => {
    expect((await call('/api/me')).status).toBe(401)
  })

  it('rejects a token signed by another key', async () => {
    const other = await generateKeyPair('RS256')
    const token = await sign({ email: 'admin@example.com' }, { key: other.privateKey })
    expect((await call('/api/me', { token })).status).toBe(401)
  })

  it('rejects a token for another Access app', async () => {
    const token = await sign({ email: 'admin@example.com' }, { aud: 'other-app' })
    expect((await call('/api/me', { token })).status).toBe(401)
  })

  it('rejects a token from another issuer', async () => {
    const token = await sign({ email: 'admin@example.com' }, { iss: 'https://other.cloudflareaccess.com' })
    expect((await call('/api/me', { token })).status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = await sign({ email: 'admin@example.com' }, { exp: Math.floor(Date.now() / 1000) - 60 })
    expect((await call('/api/me', { token })).status).toBe(401)
  })

  it.each([{ email: 123 }, { email: '' }, { email: '   ' }, {}])('rejects a token without a usable email claim (%j)', async (claims) => {
    expect((await call('/api/me', { token: await sign(claims) })).status).toBe(401)
  })

  it.each(['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAIL'] as const)('fails closed when %s is missing', async (name) => {
    const token = await sign({ email: 'admin@example.com' })
    expect((await callWith('https://app.test/api/me', { [name]: undefined }, { token })).status).toBe(401)
  })

  it('checks the token before routing, so unknown routes do not reveal themselves', async () => {
    expect((await call('/api/nothing-here')).status).toBe(401)
  })

  it('answers unknown routes with a JSON 404 once signed in', async () => {
    const res = await call('/api/nothing-here', { token: await sign({ email: 'sib@example.com' }) })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('read-only Members', () => {
  it('refuses change requests from a Member', async () => {
    const res = await call('/api/me', { method: 'POST', token: await sign({ email: 'sib@example.com' }) })
    expect(res.status).toBe(403)
  })

  it('lets the Admin past the write check', async () => {
    const res = await call('/api/me', { method: 'POST', token: await sign({ email: 'admin@example.com' }) })
    expect(res.status).not.toBe(403)
  })
})

describe('local development identity', () => {
  // DEV_USER_EMAIL is set to Dev@example.com in vitest.config.ts; it only ever applies on localhost.
  it('stands in for a signed-in Member on localhost, without a token', async () => {
    const res = await call('/api/me', { origin: 'http://localhost:5173' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'dev@example.com', role: 'member' })
  })

  it('can be the Admin', async () => {
    const res = await callWith('http://127.0.0.1:5173/api/me', { DEV_USER_EMAIL: 'ADMIN@example.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'admin@example.com', role: 'admin' })
  })

  it('is ignored on any other host', async () => {
    expect((await call('/api/me')).status).toBe(401)
  })

  it('cannot be spoofed with a Host header on a non-localhost URL', async () => {
    expect((await call('/api/me', { headers: { Host: 'localhost' } })).status).toBe(401)
  })
})

describe('local D1', () => {
  it('is available to the Worker under test', async () => {
    expect(await env.DB.prepare('select 1 as ok').first('ok')).toBe(1)
  })
})
