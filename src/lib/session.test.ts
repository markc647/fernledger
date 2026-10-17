import { afterEach, describe, expect, it } from 'vitest'
import { forgetSessionProblem, isAccessRedirect, sessionAwareFetch, sessionProblem, signInAgainUrl, withoutSignInParam } from './session'

afterEach(forgetSessionProblem)

describe('isAccessRedirect', () => {
  it('is true for the opaque redirect a browser hands back when it is told not to follow one', () => {
    expect(isAccessRedirect({ type: 'opaqueredirect', status: 0 })).toBe(true)
  })

  it('is true for any 3xx, which the API never sends: only Access in front of it does', () => {
    expect(isAccessRedirect({ type: 'basic', status: 302 })).toBe(true)
    expect(isAccessRedirect({ type: 'basic', status: 307 })).toBe(true)
  })

  it.each([200, 204, 304, 400, 401, 403, 404, 500, 502])('is false for a %i', (status) => {
    expect(isAccessRedirect({ type: 'basic', status })).toBe(false)
  })
})

describe('sessionAwareFetch', () => {
  const answering = (status: number, answer: ResponseInit = {}) => {
    const calls: RequestInit[] = []
    const inner: typeof fetch = async (_input, init) => {
      calls.push(init ?? {})
      return new Response(null, { status, ...answer })
    }
    return { calls, fetch: sessionAwareFetch(inner) }
  }

  it('asks not to follow a redirect, so a sign-in page on another host is never fetched', async () => {
    const { calls, fetch } = answering(200)
    await fetch('/api/me', { method: 'GET', headers: { Accept: 'application/json' } })
    expect(calls).toEqual([{ method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual' }])
  })

  it('records an expired sign-in when Access redirects, and hands the answer back', async () => {
    const { fetch } = answering(302, { headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/app.test' } })
    const res = await fetch('/api/transactions')
    expect(res.status).toBe(302)
    expect(sessionProblem()).toBe('expired')
  })

  it('records "not signed in" for a 401 from the Worker, which is a different thing', async () => {
    const { fetch } = answering(401)
    await fetch('/api/me')
    expect(sessionProblem()).toBe('not-signed-in')
  })

  it.each([200, 403, 404, 409, 429, 500])('records nothing for a %i', async (status) => {
    const { fetch } = answering(status)
    await fetch('/api/me')
    expect(sessionProblem()).toBeNull()
  })

  it('lets an expired sign-in win over "not signed in", and keeps it once seen, whatever the next answer is', async () => {
    await answering(401).fetch('/api/me')
    await answering(302).fetch('/api/me')
    expect(sessionProblem()).toBe('expired')
    forgetSessionProblem()
    await answering(302).fetch('/api/me')
    await answering(401).fetch('/api/me')
    await answering(200).fetch('/api/me')
    expect(sessionProblem()).toBe('expired')
  })
})

describe('signInAgainUrl', () => {
  it('goes to the same page with a changing value added, so the browser cannot answer from its cache', () => {
    expect(signInAgainUrl({ pathname: '/transactions', search: '', hash: '' }, 1729000000000)).toBe('/transactions?_signin=1729000000000')
  })

  it('keeps the query as it was, byte for byte, and the hash', () => {
    expect(signInAgainUrl({ pathname: '/transactions', search: '?q=a%20b&page=2', hash: '#top' }, 5)).toBe('/transactions?q=a%20b&page=2&_signin=5#top')
  })

  it('does not add the value twice', () => {
    expect(signInAgainUrl({ pathname: '/', search: '?_signin=4&x=1', hash: '' }, 5)).toBe('/?x=1&_signin=5')
  })
})

describe('withoutSignInParam', () => {
  it('takes the value out and keeps the rest of the address', () => {
    expect(withoutSignInParam('/transactions?q=a%20b&_signin=5&page=2#top')).toBe('/transactions?q=a%20b&page=2#top')
    expect(withoutSignInParam('/transactions?_signin=5')).toBe('/transactions')
    expect(withoutSignInParam('/?_signin')).toBe('/')
  })

  it('returns an address without it as it was', () => {
    expect(withoutSignInParam('/transactions?q=_signin')).toBe('/transactions?q=_signin')
    expect(withoutSignInParam('/')).toBe('/')
  })
})
