import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSY_GIVE_UP_MS, busyRetryingFetch, dayLimitReached, dayLimitResets } from './member-busy'

const busy = () => Response.json({ error: 'Too many requests at once', reason: 'member-busy' }, { status: 429 })
const limit = () => Response.json({ error: 'Daily limit reached', reason: 'member-reads' }, { status: 429 })
const ok = () => Response.json({ fine: true })

/** A fetch that answers with each of `answers` in turn, the last one from then on. */
function answering(...answers: Array<() => Response>) {
  const calls: number[] = []
  const inner = vi.fn(async () => {
    calls.push(Date.now())
    return answers[Math.min(calls.length - 1, answers.length - 1)]!()
  })
  return { inner: inner as unknown as typeof fetch, calls }
}

describe('asking again while the Member is busy', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks again after a short wait until the Worker lets the request in', async () => {
    const { inner, calls } = answering(busy, busy, ok)

    const answer = busyRetryingFetch(inner)('/api/charts/net-worth')
    await vi.runAllTimersAsync()
    const res = await answer

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(3)
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(50) // half of the first 100 ms at the least
    expect(calls[1]! - calls[0]!).toBeLessThanOrEqual(150)
  })

  it('hands on the busy answer once it has asked for BUSY_GIVE_UP_MS', async () => {
    const { inner, calls } = answering(busy)

    const answer = busyRetryingFetch(inner)('/api/charts/net-worth')
    await vi.runAllTimersAsync()
    const res = await answer

    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ reason: 'member-busy' })
    expect(calls.at(-1)! - calls[0]!).toBeGreaterThanOrEqual(BUSY_GIVE_UP_MS)
    expect(calls.at(-1)! - calls[0]!).toBeLessThan(BUSY_GIVE_UP_MS + 1_600) // the last wait is at most a second and a half
  })

  it('never asks again for the day\'s limit, another error, or a request with a body', async () => {
    for (const answer of [limit, () => new Response('Something went wrong', { status: 500 }), () => new Response('not JSON', { status: 429 })]) {
      const { inner, calls } = answering(answer)
      await busyRetryingFetch(inner)('/api/transactions')
      expect(calls).toHaveLength(1)
    }
    const { inner, calls } = answering(busy)
    await busyRetryingFetch(inner)('/api/settings', { method: 'PATCH', body: '{}' })
    expect(calls).toHaveLength(1)
  })
})

describe("the Members' daily read limit", () => {
  it('is noted for the UTC day a request meets it, and not by other answers', async () => {
    const now = Date.parse('2026-10-26T23:59:00Z')
    await busyRetryingFetch(answering(ok, () => new Response('not JSON', { status: 429 })).inner)('/api/transactions')
    expect(dayLimitReached(now)).toBe(false)

    vi.useFakeTimers({ now, toFake: ['Date'] })
    await busyRetryingFetch(answering(limit).inner)('/api/transactions')
    vi.useRealTimers()
    expect(dayLimitReached(now)).toBe(true)
    expect(dayLimitReached(Date.parse('2026-10-27T00:00:00Z'))).toBe(false) // it starts again at 00:00 UTC
  })

  it('starts again at 00:00 UTC, said as New Zealand time and day', () => {
    expect(dayLimitResets(Date.parse('2026-10-26T21:00:00Z'))).toBe('1:00 pm today') // 10 am NZDT
    expect(dayLimitResets(Date.parse('2026-10-27T01:00:00Z'))).toBe('1:00 pm tomorrow') // 2 pm NZDT
    expect(dayLimitResets(Date.parse('2026-06-15T23:30:00Z'))).toBe('12:00 pm today') // 11:30 am NZST
  })
})
