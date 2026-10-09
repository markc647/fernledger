import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
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

const sign = (claims: Record<string, unknown>, opts: { aud?: string; key?: CryptoKey } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience(opts.aud ?? env.ACCESS_AUD!)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(opts.key ?? signingKey)

type CallOptions = { token?: string; method?: string; origin?: string; envOverride?: Partial<Env> }

/** Sends a real request through the Worker's fetch handler. `envOverride` changes Worker settings for that call only. */
async function call(path: string, opts: CallOptions = {}) {
  const request = new Request(`${opts.origin ?? 'https://app.test'}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.token ? { 'Cf-Access-Jwt-Assertion': opts.token } : {},
  })
  const ctx = createExecutionContext()
  const response = await worker.fetch!(request as never, { ...env, ...opts.envOverride }, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('GET /api/me', () => {
  it('recognises the Admin by email, case-insensitively', async () => {
    const res = await call('/api/me', { token: await sign({ email: 'ADMIN@example.com' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'admin@example.com', role: 'admin' })
  })

  it('treats any other signed-in email as a read-only Member', async () => {
    const res = await call('/api/me', { token: await sign({ email: 'sib@example.com' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'sib@example.com', role: 'member' })
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

  it('rejects a token whose email claim is not an email address', async () => {
    expect((await call('/api/me', { token: await sign({ email: 'not-an-email' }) })).status).toBe(401)
  })

  it.each(['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAIL'] as const)('fails closed when %s is missing', async (name) => {
    const token = await sign({ email: 'admin@example.com' })
    expect((await call('/api/me', { token, envOverride: { [name]: undefined } })).status).toBe(401)
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
  const dev = { DEV_USER_EMAIL: 'Dev@example.com' }

  it('stands in for a signed-in user on localhost, without a token', async () => {
    const res = await call('/api/me', { origin: 'http://localhost:5173', envOverride: dev })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'dev@example.com', role: 'member' })
  })

  it('can be the Admin', async () => {
    const res = await call('/api/me', { origin: 'http://127.0.0.1:5173', envOverride: { DEV_USER_EMAIL: 'ADMIN@example.com' } })
    expect(await res.json()).toEqual({ email: 'admin@example.com', role: 'admin' })
  })

  it('is ignored on any other host', async () => {
    expect((await call('/api/me', { envOverride: dev })).status).toBe(401)
  })
})

describe('local D1', () => {
  it('is available to the Worker under test', async () => {
    expect(await env.DB.prepare('select 1 as ok').first('ok')).toBe(1)
  })
})
