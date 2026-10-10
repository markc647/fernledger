import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

// Signed in through the localhost dev identity (the cookie picks the role), so these tests go through the real guard and handler.
const origin = 'http://localhost:5173'

const get = (query = '', as?: 'admin' | 'member') =>
  exports.default.fetch(new Request(`${origin}/api/change-log${query}`, { headers: as ? { Cookie: `fernledger_dev_as=${as}` } : {} }))

type Entry = { id: number; at: string; actor: string; type: string | null; summary: string; before: string | null; after: string | null }
type Listing = { total: number; entries: Entry[]; types: { id: string; label: string }[] }
const listing = async (query = '', as: 'admin' | 'member' = 'member') => {
  const res = await get(query, as)
  expect(res.status).toBe(200)
  return (await res.json()) as Listing
}

const insert = (at: string, type: string | null, summary: string, before: string | null = null, after: string | null = null) =>
  env.DB.prepare('INSERT INTO change_log (at, actor, type, summary, before, after) VALUES (?, ?, ?, ?, ?, ?)').bind(at, 'admin@example.com', type, summary, before, after)

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM change_log').run()
})

describe('GET /api/change-log', () => {
  it('lets a Member read it: who, when, what, before and after, newest first', async () => {
    await env.DB.batch([
      insert('2026-10-06T01:00:00.000Z', 'settings', 'Changed settings: app title', '{"app_title":"Fernledger"}', '{"app_title":"Mum\'s finances"}'),
      insert('2026-10-07T02:00:00.000Z', 'account', 'Renamed Account A to B', '{"name":"A"}', '{"name":"B"}'),
    ])

    const { total, entries } = await listing('', 'member')

    expect(total).toBe(2)
    expect(entries).toEqual([
      { id: 2, at: '2026-10-07T02:00:00.000Z', actor: 'admin@example.com', type: 'account', summary: 'Renamed Account A to B', before: '{"name":"A"}', after: '{"name":"B"}' },
      {
        id: 1,
        at: '2026-10-06T01:00:00.000Z',
        actor: 'admin@example.com',
        type: 'settings',
        summary: 'Changed settings: app title',
        before: '{"app_title":"Fernledger"}',
        after: '{"app_title":"Mum\'s finances"}',
      },
    ])
  })

  it('lets the Admin read it too, and says which types there are', async () => {
    const { entries, types } = await listing('', 'admin')
    expect(entries).toEqual([])
    expect(types).toEqual([
      { id: 'settings', label: 'Settings' },
      { id: 'account', label: 'Account' },
      { id: 'import', label: 'Import' },
      { id: 'category', label: 'Category' },
      { id: 'rule', label: 'Rule' },
      { id: 'budget', label: 'Budget' },
      { id: 'transaction', label: 'Transaction' },
      { id: 'transfer', label: 'Transfer' },
    ])
  })

  it('refuses someone who is not signed in', async () => {
    await env.DB.batch([insert('2026-10-06T01:00:00.000Z', 'settings', 'Changed settings: app title')])
    // Not localhost, so there is no dev identity to fall back on, and no Access token.
    const res = await exports.default.fetch(new Request('https://app.test/api/change-log'))
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('Changed settings')
  })

  it('cannot be changed through the API, even by the Admin', async () => {
    const attempt = (as: string) =>
      exports.default.fetch(
        new Request(`${origin}/api/change-log`, { method: 'DELETE', headers: { Cookie: `fernledger_dev_as=${as}`, Origin: origin, 'Content-Type': 'application/json' } }),
      )
    expect((await attempt('member')).status).toBe(403)
    expect((await attempt('admin')).status).toBe(404) // no such route
  })

  describe('filtering by type', () => {
    beforeEach(async () => {
      await env.DB.batch([
        insert('2026-10-06T01:00:00.000Z', 'settings', 'S1'),
        insert('2026-10-06T02:00:00.000Z', 'import', 'I1'),
        insert('2026-10-06T03:00:00.000Z', 'settings', 'S2'),
        insert('2026-10-06T04:00:00.000Z', null, 'Older entry with no type'),
      ])
    })

    it('shows only that type, and counts only that type', async () => {
      const { total, entries } = await listing('?type=settings')
      expect(entries.map((e) => e.summary)).toEqual(['S2', 'S1'])
      expect(total).toBe(2)
    })

    it('shows everything without a type', async () => {
      const { total, entries } = await listing('')
      expect(entries.map((e) => e.summary)).toEqual(['Older entry with no type', 'S2', 'I1', 'S1'])
      expect(total).toBe(4)
    })

    it('rejects a repeated type, naming only the field', async () => {
      const res = await get('?type=settings&type=import', 'member')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'type' })
    })

    it('rejects a type that does not exist, naming only the field', async () => {
      const res = await get('?type=secret-thing', 'member')
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(JSON.parse(body)).toEqual({ error: 'Invalid request', field: 'type' })
      expect(body).not.toContain('secret-thing')
    })
  })

  describe('filtering by NZ date', () => {
    beforeEach(async () => {
      await env.DB.batch([
        insert('2026-10-07T10:59:59.999Z', 'settings', 'Wed 7 Oct 11:59 pm NZ'), // NZ is UTC+13 in October
        insert('2026-10-07T11:00:00.000Z', 'settings', 'Thu 8 Oct midnight NZ'),
        insert('2026-10-08T10:59:59.999Z', 'settings', 'Thu 8 Oct 11:59 pm NZ'),
        insert('2026-10-08T11:00:00.000Z', 'settings', 'Fri 9 Oct midnight NZ'),
      ])
    })
    const summaries = async (query: string) => (await listing(query)).entries.map((e) => e.summary)

    it('takes whole NZ days, both ends included', async () => {
      expect(await summaries('?from=2026-10-08&to=2026-10-08')).toEqual(['Thu 8 Oct 11:59 pm NZ', 'Thu 8 Oct midnight NZ'])
    })

    it('takes an open-ended range', async () => {
      expect(await summaries('?from=2026-10-09')).toEqual(['Fri 9 Oct midnight NZ'])
      expect(await summaries('?to=2026-10-07')).toEqual(['Wed 7 Oct 11:59 pm NZ'])
    })

    it('counts only what is in range', async () => {
      expect((await listing('?from=2026-10-08&to=2026-10-08')).total).toBe(2)
    })

    it('combines with the type', async () => {
      await insert('2026-10-07T12:00:00.000Z', 'import', 'An import on 8 Oct').run()
      expect(await summaries('?from=2026-10-08&to=2026-10-08&type=import')).toEqual(['An import on 8 Oct'])
    })

    it.each([
      ['from', '?from=2026-02-30'],
      ['from', '?from=08/10/2026'],
      ['from', '?from=2026-10-08T00:00:00Z'],
      ['from', '?from=1999-12-31'], // below the range
      ['from', '?from=1900-01-01'],
      ['from', '?from=0001-01-01'],
      ['from', '?from=0002-10-08'], // Chrome emits partial years while one is typed
      ['to', '?to=2101-01-01'], // above the range
      ['to', '?to=9999-12-31'],
      ['to', '?to=yesterday'],
      ['to', '?to='],
    ])('rejects a bad %s (%s), naming only the field', async (field, query) => {
      const res = await get(query, 'member')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
    })

    it('accepts the ends of the range', async () => {
      expect((await listing('?from=2000-01-01&to=2100-12-31')).total).toBe(4)
    })

    it('rejects a range that ends before it starts', async () => {
      const res = await get('?from=2026-10-09&to=2026-10-08', 'member')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field: 'to' })
    })
  })

  describe('paging', () => {
    beforeEach(async () => {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 130)
         INSERT INTO change_log (actor, type, summary) SELECT 'admin@example.com', 'settings', 'Change ' || i FROM n`,
      ).run()
    })

    it('gives a page of 50 by default, with the total', async () => {
      const { total, entries } = await listing('')
      expect(total).toBe(130)
      expect(entries).toHaveLength(50)
      expect(entries[0]!.summary).toBe('Change 130')
    })

    it('caps a page at 100 however many are asked for', async () => {
      expect((await listing('?limit=100000')).entries).toHaveLength(100)
    })

    it('raises a limit of 0 to 1', async () => {
      expect((await listing('?limit=0')).entries.map((e) => e.summary)).toEqual(['Change 130'])
    })

    it('honours a smaller limit and an offset', async () => {
      const { entries } = await listing('?limit=5&offset=10')
      expect(entries.map((e) => e.summary)).toEqual(['Change 120', 'Change 119', 'Change 118', 'Change 117', 'Change 116'])
    })

    it.each([
      ['limit', '?limit=abc'],
      ['limit', '?limit=-1'],
      ['offset', '?offset=1.5'],
    ])('rejects a bad %s (%s), naming only the field', async (field, query) => {
      const res = await get(query, 'member')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request', field })
    })
  })
})
