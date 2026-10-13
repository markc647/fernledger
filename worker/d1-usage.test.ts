import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRAPHQL_URL } from './d1-usage'
import worker from './index'

// Seam 1: GET /api/d1-usage, the Admin's D1 usage bar. It asks Cloudflare's GraphQL Analytics API how many rows the whole account has
// read and written today (UTC), and only when both secrets are set (worker/features.ts: D1_USAGE; ADR 0010). `fetch` is replaced by a
// stub that answers as the API does, so nothing here reaches Cloudflare.

// Fake values, deliberately recognisable so a leak into a response or a log is obvious. Not a real token or account.
const TOKEN = 'cf_token_SECRET_VALUE_1'
const ACCOUNT = 'account_SECRET_VALUE_2'
const SECRETS = { CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT }

/** What the API answers with when it has the figures: one group, since the query has no dimensions. */
const answer = (sum: Record<string, unknown>) => ({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum }] }] } }, errors: null })

const asJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; init: RequestInit }
let calls: Call[] = []
let logged: string[] = []
const stubCloudflare = (respond: (call: Call) => Response | Promise<Response>) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: input instanceof Request ? input.url : String(input), init }
    calls.push(call)
    return respond(call)
  })

beforeEach(() => {
  calls = []
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(' ')))
  // Only the clock is faked, so the day it asks about is the test's to choose.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-14T05:30:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Calls the Worker with the secrets set or unset, which is why this goes through `worker.fetch` rather than the exported handler. */
async function getUsage(as: 'admin' | 'member', secrets: Partial<Env> = SECRETS) {
  const ctx = createExecutionContext()
  const request = new Request('http://localhost:5173/api/d1-usage', { headers: { Cookie: `fernledger_dev_as=${as}` } })
  const res = await worker.fetch!(request as never, { ...env, CF_ANALYTICS_TOKEN: undefined, CF_ACCOUNT_ID: undefined, ...secrets }, ctx)
  await waitOnExecutionContext(ctx)
  return { res, text: await res.clone().text() }
}

/** Neither the token nor the account ID reached the answer or a log line. */
const expectNoSecrets = (text: string) => {
  expect(text).not.toContain('SECRET_VALUE')
  expect(logged.join('\n')).not.toContain('SECRET_VALUE')
}

describe('GET /api/d1-usage', () => {
  it("gives the Admin the day's rows read and written, the free plan's limits and when the day ends", async () => {
    stubCloudflare(() => asJson(answer({ rowsRead: 1_234_567, rowsWritten: 4_321 })))
    const { res, text } = await getUsage('admin')

    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toEqual({
      rowsRead: 1_234_567,
      rowsWritten: 4_321,
      readLimit: 5_000_000,
      writeLimit: 100_000,
      // D1's allowance resets at 00:00 UTC (developers.cloudflare.com/d1/platform/pricing).
      resetsAt: '2026-10-15T00:00:00.000Z',
    })
    expectNoSecrets(text)
  })

  it("asks the GraphQL Analytics API once, for the whole account's D1 rows today (UTC), with the token as a bearer and a time limit", async () => {
    stubCloudflare(() => asJson(answer({ rowsRead: 1, rowsWritten: 2 })))
    await getUsage('admin')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql')
    expect(url).toBe(GRAPHQL_URL)
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('Content-Type')).toBe('application/json')
    // A call that can hang would hold the request open: it has a time limit, and it has not run out.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal!.aborted).toBe(false)

    const sent = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> }
    // The day is the UTC date, from midnight to midnight, because that is D1's day. The account ID goes in as a variable, not into the text.
    expect(sent.variables).toEqual({ accountTag: ACCOUNT, start: '2026-10-14', end: '2026-10-14' })
    expect(sent.query).toContain('d1AnalyticsAdaptiveGroups')
    expect(sent.query).toContain('accounts(filter: { accountTag: $accountTag })')
    expect(sent.query).toContain('date_geq: $start')
    expect(sent.query).toContain('date_leq: $end')
    expect(sent.query).toMatch(/sum\s*\{\s*rowsRead\s*rowsWritten\s*\}/)
    // Account-wide: D1's allowance is the account's, not one database's.
    expect(sent.query).not.toContain('databaseId')
    for (const part of [url, String(init.body)]) expect(part).not.toContain(TOKEN)
    expect(sent.query).not.toContain(ACCOUNT)
  })

  it('asks about the new UTC day as soon as it starts, which is midday or 1 pm in New Zealand', async () => {
    vi.setSystemTime(new Date('2026-10-14T23:59:59Z'))
    stubCloudflare(() => asJson(answer({ rowsRead: 0, rowsWritten: 0 })))
    const first = await getUsage('admin')
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))
    const second = await getUsage('admin')

    expect(calls.map((call) => JSON.parse(String(call.init.body)).variables.start)).toEqual(['2026-10-14', '2026-10-15'])
    expect(JSON.parse(first.text).resetsAt).toBe('2026-10-15T00:00:00.000Z')
    expect(JSON.parse(second.text).resetsAt).toBe('2026-10-16T00:00:00.000Z')
  })

  it('adds up the groups if the API returns more than one', async () => {
    stubCloudflare(() =>
      asJson({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 10, rowsWritten: 1 } }, { sum: { rowsRead: 5, rowsWritten: 2 } }] }] } }, errors: null }),
    )
    const { text } = await getUsage('admin')
    expect(JSON.parse(text)).toMatchObject({ rowsRead: 15, rowsWritten: 3 })
  })

  it('says zero before the day has recorded anything', async () => {
    stubCloudflare(() => asJson({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } }, errors: null }))
    const { res, text } = await getUsage('admin')
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ rowsRead: 0, rowsWritten: 0 })
  })

  describe('who may ask', () => {
    it('refuses a Member, whether or not it is set up, and calls no one', async () => {
      stubCloudflare(() => asJson(answer({ rowsRead: 1, rowsWritten: 1 })))
      for (const secrets of [SECRETS, {}]) {
        const { res, text } = await getUsage('member', secrets)
        expect(res.status).toBe(403)
        expect(JSON.parse(text)).toEqual({ error: 'Admin only' })
      }
      expect(calls).toEqual([])
    })

    it('refuses a visitor who is not signed in, and calls no one', async () => {
      stubCloudflare(() => asJson(answer({ rowsRead: 1, rowsWritten: 1 })))
      const res = await exports.default.fetch(new Request('https://app.test/api/d1-usage'))
      expect(res.status).toBe(401)
      expect(calls).toEqual([])
    })
  })

  describe('when it is not set up', () => {
    it.each([
      ['neither secret', {}],
      ['only the token', { CF_ANALYTICS_TOKEN: TOKEN }],
      ['only the account ID', { CF_ACCOUNT_ID: ACCOUNT }],
      ['blank values', { CF_ANALYTICS_TOKEN: '  ', CF_ACCOUNT_ID: '' }],
    ])('answers Not set up with %s, and calls no one', async (_name, secrets) => {
      stubCloudflare(() => asJson(answer({ rowsRead: 1, rowsWritten: 1 })))
      const { res, text } = await getUsage('admin', secrets)

      expect(res.status).toBe(503)
      expect(JSON.parse(text)).toEqual({ error: 'Not set up', feature: 'd1-usage' })
      expectNoSecrets(text)
      expect(calls).toEqual([])
    })
  })

  describe('when Cloudflare cannot give the figures', () => {
    const unavailable = async () => {
      const { res, text } = await getUsage('admin')
      expect(res.status).toBe(502)
      expect(JSON.parse(text)).toEqual({ error: 'Usage unavailable' })
      expectNoSecrets(text)
      return logged.filter((line) => line.includes('d1-usage'))
    }

    it('says unavailable, and logs only the event and the error class, when the call fails', async () => {
      // An error whose message holds the token, as a badly behaved library's might.
      stubCloudflare(() => {
        throw new TypeError(`fetch failed for Bearer ${TOKEN} and ${ACCOUNT}`)
      })
      expect(await unavailable()).toEqual(['{"event":"d1-usage.failed","errorClass":"TypeError"}'])
    })

    it('says unavailable when the call runs out of time', async () => {
      stubCloudflare(() => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      })
      expect(await unavailable()).toEqual(['{"event":"d1-usage.failed","errorClass":"DOMException"}'])
    })

    it.each([401, 403])('says unavailable, and logs that Cloudflare refused, when it answers %i (the token or account ID is wrong)', async (status) => {
      stubCloudflare(() => asJson({ data: null, errors: [{ message: `not authorized, token ${TOKEN}` }] }, status))
      expect(await unavailable()).toEqual(['{"event":"d1-usage.refused"}'])
    })

    it.each([400, 429, 500, 503])('says unavailable when it answers %i', async (status) => {
      stubCloudflare(() => asJson({ data: null, errors: [{ message: `try later ${ACCOUNT}` }] }, status))
      expect(await unavailable()).toEqual(['{"event":"d1-usage.failed"}'])
    })

    it('says unavailable when a 200 carries errors, and does not pass their message on', async () => {
      stubCloudflare(() => asJson({ data: null, errors: [{ message: `unknown field, ${TOKEN}`, path: ['viewer'] }] }))
      expect(await unavailable()).toEqual(['{"event":"d1-usage.failed"}'])
    })

    it.each([
      ['an empty object', {}],
      ['no account in the answer (the account ID is not one the token can see)', { data: { viewer: { accounts: [] } }, errors: null }],
      ['figures that are not numbers', answer({ rowsRead: '5', rowsWritten: 1 })],
      ['a missing figure', answer({ rowsRead: 5 })],
      ['a negative figure', answer({ rowsRead: -1, rowsWritten: 1 })],
      ['a fraction', answer({ rowsRead: 1.5, rowsWritten: 1 })],
      ['a figure too large to be exact', answer({ rowsRead: Number.MAX_SAFE_INTEGER + 1, rowsWritten: 1 })],
    ])('says unavailable when the answer is %s', async (_name, body) => {
      stubCloudflare(() => asJson(body))
      expect(await unavailable()).toEqual(['{"event":"d1-usage.unreadable"}'])
    })

    it('says unavailable when the answer is not JSON', async () => {
      stubCloudflare(() => new Response(`<html>${TOKEN}</html>`, { status: 200 }))
      expect(await unavailable()).toEqual(['{"event":"d1-usage.unreadable"}'])
    })
  })
})
