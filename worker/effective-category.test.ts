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

// The one definition of a Transfer, read from the Transaction's stored pair and Rule flag, and cut off by an Override.
describe('whether a Transaction is a Transfer', () => {
  const resolveTransfer = async (
    transferOf: number | null,
    ruleTransfer: number | null,
    override: string | null,
    slots: readonly CategorySlot[] = CATEGORY_SLOTS,
    notTransferWith: number | null = null,
  ) => {
    const effective = effectiveCategory(slots)
    return env.DB.prepare(
      `SELECT ${effective.transfer} AS transfer, ${effective.isTransfer} AS isTransfer
       FROM (SELECT ? AS transfer_of, ? AS rule_transfer, ? AS override_category, ? AS not_transfer_with, NULL AS rule_category) t ${effective.joins}`,
    )
      .bind(transferOf, ruleTransfer, override === null ? null : ids[override]!, notTransferWith)
      .first<{ transfer: string | null; isTransfer: number }>()
  }

  it('is a pair when the Transaction is paired', async () => {
    expect(await resolveTransfer(7, null, null)).toEqual({ transfer: 'pair', isTransfer: 1 })
  })

  it('is the Rule when a Rule marks it and nothing paired it', async () => {
    expect(await resolveTransfer(null, 1, null)).toEqual({ transfer: 'rule', isTransfer: 1 })
  })

  it('is a pair, not the Rule, when both apply', async () => {
    expect(await resolveTransfer(7, 1, null)).toEqual({ transfer: 'pair', isTransfer: 1 })
  })

  it('is not a Transfer when it is neither paired nor marked', async () => {
    expect(await resolveTransfer(null, null, null)).toEqual({ transfer: null, isTransfer: 0 })
  })

  it('is not a Transfer when the Admin has set an Override, however it is paired or marked', async () => {
    expect(await resolveTransfer(7, 1, 'Precedence Override')).toEqual({ transfer: null, isTransfer: 0 })
    expect(await resolveTransfer(null, 1, 'Precedence Override')).toEqual({ transfer: null, isTransfer: 0 })
  })

  it('is a Transfer again when the Override is of a Category that has been removed', async () => {
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-01T00:00:00.000Z' WHERE name = 'Precedence Override'").run()
    try {
      expect(await resolveTransfer(7, null, 'Precedence Override')).toEqual({ transfer: 'pair', isTransfer: 1 })
    } finally {
      await env.DB.prepare("UPDATE categories SET removed_at = NULL WHERE name = 'Precedence Override'").run()
    }
  })

  it('has no Override to defer to when no slot supplies one', async () => {
    expect(await resolveTransfer(7, null, null, [{ source: 'override', column: null }])).toEqual({ transfer: 'pair', isTransfer: 1 })
  })

  it('is not a Transfer once the Admin has said Not a Transfer, whether it is paired, marked by a Rule, or both', async () => {
    // Marking clears the pairing, but the marker is what decides, so it holds whatever else is stored.
    expect(await resolveTransfer(null, 1, null, CATEGORY_SLOTS, 8)).toEqual({ transfer: null, isTransfer: 0 })
    expect(await resolveTransfer(7, null, null, CATEGORY_SLOTS, 8)).toEqual({ transfer: null, isTransfer: 0 })
    expect(await resolveTransfer(7, 1, null, CATEGORY_SLOTS, 8)).toEqual({ transfer: null, isTransfer: 0 })
    // Alone, a Transaction holds its own ID; any ID marks it.
    expect(await resolveTransfer(null, 1, null, CATEGORY_SLOTS, 1)).toEqual({ transfer: null, isTransfer: 0 })
  })

  it('is a Transfer again when the marker is taken off', async () => {
    expect(await resolveTransfer(null, 1, null, CATEGORY_SLOTS, null)).toEqual({ transfer: 'rule', isTransfer: 1 })
  })

  it('is not a Transfer with no Override slot either, and an Override stays spending', async () => {
    expect(await resolveTransfer(null, 1, null, [{ source: 'override', column: null }], 8)).toEqual({ transfer: null, isTransfer: 0 })
    expect(await resolveTransfer(null, 1, 'Precedence Override', CATEGORY_SLOTS, 8)).toEqual({ transfer: null, isTransfer: 0 })
  })
})
