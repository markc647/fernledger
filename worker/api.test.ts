import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { putSetting } from './settings'

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

type CallOptions = { token?: string; method?: string; headers?: Record<string, string>; origin?: string; body?: string }

/**
 * Goes through the Worker's exported handler with the env configured in vitest.config.ts.
 * The test env has no assets layer, so `assets.run_worker_first` isn't exercised here;
 * browser-level asset routing belongs to the Playwright seam (ticket 03).
 */
async function call(path: string, opts: CallOptions = {}) {
  const headers = { ...opts.headers, ...(opts.token ? { 'Cf-Access-Jwt-Assertion': opts.token } : {}) }
  return exports.default.fetch(new Request(`${opts.origin ?? 'https://app.test'}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body }))
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

describe('GET /api/app-title', () => {
  const asMember = async () => ({ token: await sign({ email: 'sib@example.com' }) })
  const setTitle = (value: string | null) =>
    env.DB.batch([env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('app_title'), ...(value === null ? [] : [putSetting(env.DB, 'app_title', value)])])

  it("gives a Member the title the Admin set, for the page header", async () => {
    await setTitle("Mum's finances")
    const res = await call('/api/app-title', await asMember())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: "Mum's finances" })
  })

  it('says "Fernledger" until a title is set', async () => {
    await setTitle(null)
    expect(await (await call('/api/app-title', await asMember())).json()).toEqual({ title: 'Fernledger' })
  })

  it.each(['', '   \n'])('says "Fernledger" when the stored title is blank (%j)', async (blank) => {
    await setTitle(blank)
    expect(await (await call('/api/app-title', await asMember())).json()).toEqual({ title: 'Fernledger' })
  })

  it('trims the title', async () => {
    await setTitle('  Dad finances  ')
    expect(await (await call('/api/app-title', await asMember())).json()).toEqual({ title: 'Dad finances' })
  })

  it('is refused without a valid Access token, and reveals no title', async () => {
    await setTitle('Private family name')
    const res = await call('/api/app-title')
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('Private family name')
  })

  it('is read-only: a Member cannot change it', async () => {
    const res = await call('/api/app-title', { ...(await asMember()), method: 'PUT', body: '{}', headers: { Origin: 'https://app.test', 'Content-Type': 'application/json' } })
    expect(res.status).toBe(403)
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

/** A change request from the Admin that satisfies every guard unless an option breaks one. */
async function adminWrite(opts: CallOptions = {}) {
  return call('/api/nothing-here', {
    method: 'POST',
    token: await sign({ email: 'admin@example.com' }),
    body: '{}',
    headers: { Origin: 'https://app.test', 'Content-Type': 'application/json' },
    ...opts,
  })
}

describe('read-only Members', () => {
  it('refuses change requests from a Member', async () => {
    const res = await call('/api/me', { method: 'POST', token: await sign({ email: 'sib@example.com' }) })
    expect(res.status).toBe(403)
  })

  it('lets the Admin past the write checks with the right Origin and a JSON body', async () => {
    // No route exists for this path, so a 404 means every guard let the request through.
    expect((await adminWrite()).status).toBe(404)
  })
})

describe('change requests', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('are accepted from the Admin on %s', async (method) => {
    expect((await adminWrite({ method })).status).toBe(404)
  })

  it('accept a JSON content type with parameters', async () => {
    const headers = { Origin: 'https://app.test', 'Content-Type': 'application/json; charset=utf-8' }
    expect((await adminWrite({ headers })).status).toBe(404)
  })

  it('are refused when the Origin is another site', async () => {
    const res = await adminWrite({ headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } })
    expect(res.status).toBe(403)
  })

  it.each(['https://app.test.evil.test', 'http://app.test', 'https://app.test:8443', 'null'])('are refused when the Origin is %s', async (origin) => {
    const res = await adminWrite({ headers: { Origin: origin, 'Content-Type': 'application/json' } })
    expect(res.status).toBe(403)
  })

  it('are refused when there is no Origin', async () => {
    expect((await adminWrite({ headers: { 'Content-Type': 'application/json' } })).status).toBe(403)
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', ''])('are refused with content type "%s"', async (contentType) => {
    const headers: Record<string, string> = { Origin: 'https://app.test' }
    if (contentType) headers['Content-Type'] = contentType
    expect((await adminWrite({ headers })).status).toBe(415)
  })

  it('still refuse a Member even with the right Origin and a JSON body', async () => {
    const res = await adminWrite({ token: await sign({ email: 'sib@example.com' }) })
    expect(res.status).toBe(403)
  })

  it('do not apply to reads', async () => {
    const res = await call('/api/me', { token: await sign({ email: 'admin@example.com' }), headers: { Origin: 'https://evil.test' } })
    expect(res.status).toBe(200)
  })
})

describe('security headers', () => {
  const expected = {
    'content-security-policy': expect.stringContaining("default-src 'none'"),
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }

  it('are on a successful response', async () => {
    const res = await call('/api/me', { token: await sign({ email: 'sib@example.com' }) })
    expect(Object.fromEntries(res.headers)).toMatchObject(expected)
  })

  it('are on a 401, a 404 and a refused change', async () => {
    const token = await sign({ email: 'sib@example.com' })
    for (const res of [
      await call('/api/me'),
      await call('/api/nothing-here', { token }),
      await call('/api/me', { method: 'POST', token }),
    ]) {
      expect(Object.fromEntries(res.headers)).toMatchObject(expected)
    }
  })

  it('are on a 500 too', async () => {
    const res = await callWith('https://app.test/api/me', { ACCESS_TEAM_DOMAIN: 'bad host' }, { token: await sign({ email: 'admin@example.com' }) })
    expect(res.status).toBe(500)
    expect(Object.fromEntries(res.headers)).toMatchObject(expected)
  })

  it('allow inline styles (UI components need them) but only scripts from the app itself', async () => {
    const csp = (await call('/api/me')).headers.get('content-security-policy')!
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
  })

  it('forbid framing in the Content Security Policy too', async () => {
    const csp = (await call('/api/me')).headers.get('content-security-policy')
    expect(csp).toContain("frame-ancestors 'none'")
  })
})

describe('logging', () => {
  it('never contains an email, token or transaction text, even when a request fails', async () => {
    const logged: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(' ')))
    try {
      const adminToken = await sign({ email: 'admin@example.com' })
      const memberToken = await sign({ email: 'sib@example.com' })
      const body = JSON.stringify({ bankMemo: 'COUNTDOWN 12.34 FROM mum@leak.test' })
      const headers = { Origin: 'https://app.test', 'Content-Type': 'application/json' }
      await call('/api/me', { token: adminToken })
      await call('/api/me', { token: 'forged.token.value' })
      await call('/api/me', { method: 'POST', token: memberToken, headers, body })
      await call('/api/nothing-here', { method: 'POST', token: adminToken, headers, body })
      await call('/api/nothing-here', { method: 'POST', token: adminToken, headers: { Origin: 'https://evil.test' }, body })
      // A request that blows up: the error's own message echoes its input, which must not reach the logs.
      const crash = await callWith('https://app.test/api/me', { ACCESS_TEAM_DOMAIN: 'secret@leak.test bad host' }, { token: adminToken })
      expect(crash.status).toBe(500)

      const output = logged.join(' ')
      expect(output).toContain('request.failed') // the failure is logged by event name and error class only
      expect(output).toContain('TypeError')
      for (const secret of ['@', adminToken, memberToken, 'forged.token.value', 'COUNTDOWN', '12.34', 'leak.test', 'bad host'])
        expect(output).not.toContain(secret)
    } finally {
      vi.restoreAllMocks()
    }
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

  describe('switching between an Admin and a Member', () => {
    const asCookie = (value: string) => ({ Cookie: `fernledger_dev_as=${value}` })
    const local = 'http://localhost:5173'

    it('becomes the Admin when asked, whoever DEV_USER_EMAIL is', async () => {
      const res = await call('/api/me', { origin: local, headers: asCookie('admin') })
      expect(await res.json()).toEqual({ email: 'admin@example.com', role: 'admin' })
    })

    it('becomes a read-only Member when asked, even if DEV_USER_EMAIL is the Admin', async () => {
      const res = await callWith(`${local}/api/me`, { DEV_USER_EMAIL: 'admin@example.com' }, { headers: asCookie('member') })
      expect(await res.json()).toEqual({ email: 'dev.member@example.com', role: 'member' })
    })

    it('keeps the Member read-only on writes', async () => {
      const res = await call('/api/me', { origin: local, method: 'POST', headers: asCookie('member') })
      expect(res.status).toBe(403)
    })

    it('falls back to DEV_USER_EMAIL for an unknown value', async () => {
      const res = await call('/api/me', { origin: local, headers: asCookie('root') })
      expect(await res.json()).toEqual({ email: 'dev@example.com', role: 'member' })
    })

    it('does not make Admin of anyone when ADMIN_EMAIL is not set', async () => {
      const res = await callWith(`${local}/api/me`, { ADMIN_EMAIL: undefined }, { headers: asCookie('admin') })
      expect(await res.json()).toEqual({ email: 'dev@example.com', role: 'member' })
    })

    it('is ignored on any other host, so the cookie cannot grant Admin', async () => {
      expect((await call('/api/me', { headers: asCookie('admin') })).status).toBe(401)
    })

    it('cannot be spoofed with a Host header on a non-localhost URL', async () => {
      const res = await call('/api/me', { headers: { ...asCookie('admin'), Host: 'localhost' } })
      expect(res.status).toBe(401)
    })

    it('works on 127.0.0.1 as on localhost', async () => {
      const res = await callWith('http://127.0.0.1:5173/api/me', {}, { headers: asCookie('admin') })
      expect(await res.json()).toEqual({ email: 'admin@example.com', role: 'admin' })
    })

    it('is ignored when DEV_USER_EMAIL is not set, as in production', async () => {
      const res = await callWith(`${local}/api/me`, { DEV_USER_EMAIL: undefined }, { headers: asCookie('admin') })
      expect(res.status).toBe(401)
    })

    it('does not weaken a real Access token elsewhere', async () => {
      const token = await sign({ email: 'sib@example.com' })
      const res = await call('/api/me', { token, headers: asCookie('admin') })
      expect(await res.json()).toEqual({ email: 'sib@example.com', role: 'member' })
    })
  })
})

describe('local D1', () => {
  it('is available to the Worker under test', async () => {
    expect(await env.DB.prepare('select 1 as ok').first('ok')).toBe(1)
  })
})
