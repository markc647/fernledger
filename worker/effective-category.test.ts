import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { CATEGORY_SLOTS, effectiveCategory, type CategorySlot } from './effective-category'

// Rule and Akahu Sync have no column yet, so the order is proven on a stand-in row that does have all three.
const allThree: CategorySlot[] = [
  { source: 'override', column: 't.o' },
  { source: 'rule', column: 't.r' },
  { source: 'akahu', column: 't.a' },
]

const ids: Record<string, number> = {}
beforeAll(async () => {
  for (const name of ['Precedence Override', 'Precedence Rule', 'Precedence Akahu']) {
    const { meta } = await env.DB.prepare('INSERT INTO categories (name) VALUES (?)').bind(name).run()
    ids[name] = meta.last_row_id
  }
})

const resolve = async (o: string | null, r: string | null, a: string | null, slots = allThree) => {
  const effective = effectiveCategory(slots)
  const id = (name: string | null) => (name === null ? null : ids[name]!)
  return env.DB.prepare(`SELECT ${effective.id} AS id, ${effective.name} AS name, ${effective.source} AS source FROM (SELECT ? AS o, ? AS r, ? AS a) t ${effective.joins}`)
    .bind(id(o), id(r), id(a))
    .first<{ id: number | null; name: string | null; source: string | null }>()
}

describe('the effective Category', () => {
  it('is the Override when there is one, whatever else is set', async () => {
    expect(await resolve('Precedence Override', 'Precedence Rule', 'Precedence Akahu')).toEqual({ id: ids['Precedence Override'], name: 'Precedence Override', source: 'override' })
  })

  it('is the Rule when there is no Override', async () => {
    expect(await resolve(null, 'Precedence Rule', 'Precedence Akahu')).toEqual({ id: ids['Precedence Rule'], name: 'Precedence Rule', source: 'rule' })
  })

  it("is Akahu's category only when there is no Override or Rule", async () => {
    expect(await resolve(null, null, 'Precedence Akahu')).toEqual({ id: ids['Precedence Akahu'], name: 'Precedence Akahu', source: 'akahu' })
  })

  it('is Uncategorised (nothing) when no source names a Category', async () => {
    expect(await resolve(null, null, null)).toEqual({ id: null, name: null, source: null })
  })

  it('skips a removed Category and falls through to the next source', async () => {
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-01T00:00:00.000Z' WHERE name = 'Precedence Override'").run()
    try {
      expect(await resolve('Precedence Override', 'Precedence Rule', null)).toMatchObject({ name: 'Precedence Rule', source: 'rule' })
      expect(await resolve('Precedence Override', null, null)).toEqual({ id: null, name: null, source: null })
    } finally {
      await env.DB.prepare("UPDATE categories SET removed_at = NULL WHERE name = 'Precedence Override'").run()
    }
  })

  it('has no Rule or Akahu source yet, so only an Override can supply a Category', () => {
    expect(CATEGORY_SLOTS.filter((slot) => slot.column !== null).map((slot) => slot.source)).toEqual(['override'])
    expect(CATEGORY_SLOTS.map((slot) => slot.source)).toEqual(['override', 'rule', 'akahu']) // the order of precedence
  })

  it('is always Uncategorised when no slot has a column', async () => {
    expect(await resolve(null, null, null, [{ source: 'override', column: null }])).toEqual({ id: null, name: null, source: null })
  })
})
