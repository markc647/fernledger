import { createScheduledController } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_CRON } from './backup'
import worker from './index'

// Seam 1, privacy promise: the app contacts no one but Akahu (README: Security and privacy; ADR 0008).
// Every request below goes through the real Worker with `fetch` replaced by a recorder that refuses to answer, so
// a code path that makes an outbound call shows up here as a host that isn't allowed.
//
// Allowed hosts:
// - Akahu's API, for Akahu Sync (not built yet, so no test below can reach it).
// - The Deployer's own Cloudflare Access team domain: verifying a sign-in fetches its public keys. That is the
//   Deployer's own sign-in service, not a third party, and it is the only call the app makes today.
// Anything else, GitHub in particular, fails this test. Adding Akahu Sync means extending the exercise below, not
// widening the allowed hosts.
const AKAHU_HOST = 'api.akahu.io'
const ACCESS_HOST = env.ACCESS_TEAM_DOMAIN!
const ALLOWED_HOSTS = [AKAHU_HOST, ACCESS_HOST]

// Same as `triggers.crons` in wrangler.jsonc. scripts/wrangler-config.test.mjs checks BACKUP_CRON against it.
const CRONS = ['0 18 * * *', '0 22 * * *', BACKUP_CRON]

const origin = 'http://localhost:5173'
const attempts: string[] = []

beforeEach(() => {
  attempts.length = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    attempts.push(new Request(input, init).url)
    throw new Error('No network in tests')
  })
})
afterEach(() => vi.unstubAllGlobals())

const hostsContacted = () => [...new Set(attempts.map((url) => new URL(url).host))]

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: 'fernledger_dev_as=admin' }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

describe('outbound calls', () => {
  it('notices a call to a host that is not allowed (the tripwire itself)', async () => {
    await fetch('https://github.com/markc647/fernledger/releases/latest').catch(() => {})
    expect(hostsContacted().filter((host) => !ALLOWED_HOSTS.includes(host))).toEqual(['github.com'])
  })

  it('makes none from any route, signed in as the Admin', async () => {
    const imported = await call('/api/imports/chunks', {
      method: 'POST',
      body: {
        account: { number: '99-9999-9999999-99' },
        chunk: { index: 0, count: 1 },
        file: { adapterId: 'asb', rowCount: 1, skipped: 0, from: '2026-10-01', to: '2026-10-31' },
        rows: [{ date: '2026-10-01', uniqueId: 'ID1', tranType: 'EFTPOS', chequeNumber: null, payee: 'EXAMPLE SHOP', bankMemo: 'EFTPOS', amountCents: -1000 }],
      },
    })
    expect(imported.status).toBe(200)
    const [account] = (await (await call('/api/accounts')).json()) as { id: number }[]
    const requests: [string, { method?: string; body?: unknown }?][] = [
      ['/api/me'],
      ['/api/settings'],
      ['/api/features'],
      ['/api/accounts'],
      ['/api/transactions'],
      ['/api/settings', { method: 'PATCH', body: { app_title: 'Example family' } }],
      [`/api/accounts/${account.id}`, { method: 'PATCH', body: { name: 'Example savings' } }],
      ['/api/no-such-route'],
      ['/not-api'],
    ]
    for (const [path, opts] of requests) await call(path, opts)

    expect(attempts).toEqual([])
  })

  it('makes none from the scheduled handler, on any cron', async () => {
    for (const cron of CRONS) await worker.scheduled!(createScheduledController({ cron, scheduledTime: new Date('2026-10-11T15:00:00Z') }), env)

    expect(attempts).toEqual([])
  })

  it('contacts only the Deployer\'s own Access sign-in service when verifying a sign-in', async () => {
    const part = (value: object) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const token = `${part({ alg: 'RS256', kid: 'k1' })}.${part({ email: 'admin@example.com' })}.c2ln`
    const res = await exports.default.fetch(new Request('https://app.test/api/me', { headers: { 'Cf-Access-Jwt-Assertion': token } }))

    expect(res.status).toBe(401)
    expect(hostsContacted()).toEqual([ACCESS_HOST])
  })
})
