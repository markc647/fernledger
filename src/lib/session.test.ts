import { afterEach, describe, expect, it } from 'vitest'
import { busyRetryingFetch } from './member-busy'
import { isAccessRedirect, retryAtMost, sessionAwareFetch, sessionProblem, signInAgainUrl, withoutSignInParam } from './session'

// A call that is answered with `status` (and `answer`), recording what it was asked with.
const answering = (status: number, answer: ResponseInit = {}) => {
  const calls: RequestInit[] = []
  const inner: typeof fetch = async (_input, init) => {
    calls.push(init ?? {})
    return new Response(null, { status, ...answer })
  }
  return { calls, fetch: sessionAwareFetch(inner) }
}

// The store is the module's, so a test ends with a call that works, which is how it is cleared in the page too.
afterEach(async () => {
  await answering(200).fetch('/api/me')
})

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

  it('lets an expired sign-in win over "not signed in", whichever came first', async () => {
    await answering(401).fetch('/api/me')
    await answering(302).fetch('/api/me')
    expect(sessionProblem()).toBe('expired')
    await answering(401).fetch('/api/me')
    expect(sessionProblem()).toBe('expired')
  })

  // The banner says nothing on the page was lost, and goes when a call works again: the next one that is let through, not one that was already on its way before the sign-in ran out.
  it('clears on the next call that works, whichever problem it was', async () => {
    for (const status of [302, 401]) {
      await answering(status).fetch('/api/me')
      expect(sessionProblem()).not.toBeNull()
      await answering(200).fetch('/api/me')
      expect(sessionProblem()).toBeNull()
    }
  })

  it('is not cleared by a failure that is not a success, a 403 or a 500 included', async () => {
    await answering(302).fetch('/api/me')
    for (const status of [403, 404, 500, 302, 401]) await answering(status).fetch('/api/me')
    expect(sessionProblem()).toBe('expired')
  })

  it('is not cleared by a call that was already on its way when the problem came: only one asked after it', async () => {
    let finish!: () => void
    const slow = sessionAwareFetch(() => new Promise<Response>((resolve) => (finish = () => resolve(new Response(null, { status: 200 })))))
    const onItsWay = slow('/api/transactions')
    await answering(302).fetch('/api/me') // the sign-in ran out while that was being answered
    finish()
    await onItsWay
    expect(sessionProblem()).toBe('expired')
    await answering(200).fetch('/api/me')
    expect(sessionProblem()).toBeNull()
  })
})

// A read that fails is asked for again a few times, and not once the sign-in is known to be gone, which asking again would only meet again.
describe('retryAtMost', () => {
  it('allows the number of tries asked for, and no more', () => {
    expect([0, 1, 2].map((failures) => retryAtMost(2)(failures))).toEqual([true, true, false])
    expect(retryAtMost(1)(0)).toBe(true)
    expect(retryAtMost(1)(1)).toBe(false)
  })

  it('allows none while the sign-in is gone, whatever it was, and again once a call has worked', async () => {
    for (const status of [302, 401]) {
      await answering(status).fetch('/api/me')
      expect(retryAtMost(3)(0)).toBe(false)
      await answering(200).fetch('/api/me')
      expect(retryAtMost(3)(0)).toBe(true)
    }
  })

  it("allows none once a read has met the Members' daily read limit", async () => {
    expect(retryAtMost(3)(0)).toBe(true)
    await busyRetryingFetch(async () => Response.json({ error: 'Daily limit reached', reason: 'member-reads' }, { status: 429 }))('/api/transactions')
    expect(retryAtMost(3)(0)).toBe(false)
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

  // `https://app//evil.test/x` has the path `//evil.test/x`, which as an address to go to is another site's: it must stay a path on this one.
  it.each([
    ['//evil.test/x', '/evil.test/x?_signin=5'],
    ['///evil.test', '/evil.test?_signin=5'],
    ['/\\evil.test', '/evil.test?_signin=5'], // a browser reads /\ as //
    ['//', '/?_signin=5'],
  ])('never goes to another site: %s', (pathname, expected) => {
    const url = signInAgainUrl({ pathname, search: '', hash: '' }, 5)
    expect(url).toBe(expected)
    expect(url.startsWith('//')).toBe(false)
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

  it('keeps the address on this site, whatever its path begins with', () => {
    expect(withoutSignInParam('//evil.test/x?_signin=5')).toBe('/evil.test/x')
    expect(withoutSignInParam('///evil.test/x?a=1&_signin=5#h')).toBe('/evil.test/x?a=1#h')
  })
})
