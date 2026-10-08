import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { authenticate, type AuthConfig } from './auth'
import { handleApi } from './index'

const issuer = 'https://example.cloudflareaccess.com'
const audience = 'test-aud'
let config: AuthConfig
let sign: (claims: Record<string, unknown>, opts?: { aud?: string; key?: CryptoKey }) => Promise<string>

beforeAll(async () => {
  const good = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(good.publicKey)), kid: 'k1', alg: 'RS256' }
  config = { getKey: createLocalJWKSet({ keys: [jwk] }), issuer, audience, adminEmail: 'Admin@example.com' }
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(opts.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(opts.key ?? good.privateKey)
})

const req = (token?: string, method = 'GET') =>
  new Request('https://app.test/api/me', { method, headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} })

describe('authenticate', () => {
  it('recognises the Admin case-insensitively', async () => {
    expect(await authenticate(req(await sign({ email: 'admin@EXAMPLE.com' })), config)).toEqual({
      email: 'admin@example.com',
      role: 'admin',
    })
  })

  it('treats any other valid email as a read-only Member', async () => {
    expect((await authenticate(req(await sign({ email: 'sib@example.com' })), config))?.role).toBe('member')
  })

  it('rejects a missing token', async () => {
    expect(await authenticate(req(), config)).toBeNull()
  })

  it('rejects a token signed by another key', async () => {
    const other = await generateKeyPair('RS256')
    expect(await authenticate(req(await sign({ email: 'admin@example.com' }, { key: other.privateKey })), config)).toBeNull()
  })

  it('rejects a token for another Access app', async () => {
    expect(await authenticate(req(await sign({ email: 'admin@example.com' }, { aud: 'other-app' })), config)).toBeNull()
  })
})

describe('handleApi', () => {
  it('blocks writes from Members', async () => {
    const res = await handleApi(req(undefined, 'POST'), { email: 'sib@example.com', role: 'member' })
    expect(res.status).toBe(403)
  })

  it('lets the Admin past the write check', async () => {
    const res = await handleApi(req(undefined, 'POST'), { email: 'admin@example.com', role: 'admin' })
    expect(res.status).not.toBe(403)
  })
})
