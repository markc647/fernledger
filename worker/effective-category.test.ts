import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { CATEGORY_SLOTS, effectiveCategory, type CategorySlot } from './effective-category'

// Akahu Sync has no column yet, so the full order is proven on a stand-in row that does have all three.
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

// The real slots, on a stand-in row with the real column names of the `transactions` table.
const resolveStored = async (override: number | null, rule: number | null) => {
  const effective = effectiveCategory()
  return env.DB.prepare(
    `SELECT ${effective.id} AS id, ${effective.name} AS name, ${effective.source} AS source FROM (SELECT ? AS override_category, ? AS rule_category) t ${effective.joins}`,
  )
    .bind(override, rule)
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

  it('has no Akahu source yet, so only an Override or a Rule can supply a Category', () => {
    expect(CATEGORY_SLOTS.filter((slot) => slot.column !== null).map((slot) => slot.source)).toEqual(['override', 'rule'])
    expect(CATEGORY_SLOTS.map((slot) => slot.source)).toEqual(['override', 'rule', 'akahu']) // the order of precedence
  })

  it('reads the Rule slot from the Transaction\'s stored Rule result, below its Override', async () => {
    const stored = (override: string | null, rule: string | null) =>
      resolveStored(override === null ? null : ids[override]!, rule === null ? null : ids[rule]!)
    expect(await stored('Precedence Override', 'Precedence Rule')).toEqual({ id: ids['Precedence Override'], name: 'Precedence Override', source: 'override' })
    expect(await stored(null, 'Precedence Rule')).toEqual({ id: ids['Precedence Rule'], name: 'Precedence Rule', source: 'rule' })
    expect(await stored(null, null)).toEqual({ id: null, name: null, source: null })
  })

  it('is always Uncategorised when no slot has a column', async () => {
    expect(await resolve(null, null, null, [{ source: 'override', column: null }])).toEqual({ id: null, name: null, source: null })
  })
})
