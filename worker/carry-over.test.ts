import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { APPLY_HELD, HOLD_REMOVED, MARK_APPLIED } from './carry-over'
import worker from './index'

// Seam 1: replacing imported history carries the Admin's Overrides and Notes over to the re-imported Transactions
// (ticket 36). Requests go through the Worker's exported handler as the local-development Admin or a read-only Member.
const origin = 'http://localhost:5173'
const savings = '99-9999-9999999-99'
const current = '99-9999-9999999-98'

type Who = 'admin' | 'member'

async function call(path: string, opts: { who?: Who; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: `fernledger_dev_as=${opts.who ?? 'admin'}` }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(
    new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
}

/** A made-up ASB row on the given date, with a unique ID of its own. `cents` differs between a file and its replacement. */
const row = (id: string, date = '2026-09-01', cents = -1000) => ({ date, uniqueId: id, tranType: 'EFTPOS', chequeNumber: null, payee: `EXAMPLE SHOP ${id}`, bankMemo: 'EFTPOS', amountCents: cents })

type Extra = { number?: string; index?: number; count?: number; cutoverDate?: string; replace?: boolean }
const chunkBody = (rows: unknown[], extra: Extra = {}) => ({
  account: { number: extra.number ?? savings },
  chunk: { index: extra.index ?? 0, count: extra.count ?? 1 },
  file: { adapterId: 'asb', rowCount: rows.length, skipped: 0, from: '2026-09-01', to: '2026-10-03', ledgerBalance: { cents: 0, date: '2026-10-03' } },
  rows,
  ...(extra.cutoverDate !== undefined ? { cutoverDate: extra.cutoverDate } : {}),
  ...(extra.replace !== undefined ? { replace: extra.replace } : {}),
})
const sendChunk = (rows: unknown[], extra: Extra = {}, who: Who = 'admin') => call('/api/imports/chunks', { who, method: 'POST', body: chunkBody(rows, extra) })
/** Sends a chunk that must succeed, and returns what the Worker said. */
const importOk = async (rows: unknown[], extra: Extra = {}) => {
  const res = await sendChunk(rows, extra)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

const accountId = async (number = savings) => (await env.DB.prepare('SELECT id FROM accounts WHERE account_number = ?').bind(number).first<{ id: number }>())!.id
const transactionId = async (bankId: string, number = savings) =>
  (
    await env.DB.prepare('SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.account_number = ? AND t.bank_unique_id = ?')
      .bind(number, bankId)
      .first<{ id: number }>()
  )!.id
const categoryId = async (name: string) => (await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>())!.id
const removeCategory = (name: string) => env.DB.prepare("UPDATE categories SET removed_at = '2026-10-01T00:00:00Z' WHERE name = ?").bind(name).run()

/** Sets an Override and/or a Note the way the Admin does, through the API. */
async function annotate(bankId: string, what: { category?: string; note?: string }, number = savings) {
  const id = await transactionId(bankId, number)
  if (what.category) expect((await call(`/api/transactions/${id}/override`, { method: 'PUT', body: { categoryId: await categoryId(what.category) } })).status).toBe(200)
  if (what.note) expect((await call(`/api/transactions/${id}/note`, { method: 'PUT', body: { note: what.note } })).status).toBe(200)
}

type Stored = { id: string; category: string | null; note: string | null; source: string }
/** Every Transaction of an Account with the Override (raw column) and Note it holds. */
const stored = async (number = savings) =>
  (
    await env.DB.prepare(
      `SELECT t.bank_unique_id AS id, c.name AS category, t.note, t.source
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.override_category
       WHERE a.account_number = ? ORDER BY t.bank_unique_id`,
    )
      .bind(number)
      .all<Stored>()
  ).results
const withoutAnnotations = (id: string, source = 'import'): Stored => ({ id, category: null, note: null, source })

/** What is waiting to be carried over: the holding table (migrations/3601_carry_over.sql). */
const waiting = async () =>
  (
    await env.DB.prepare(
      `SELECT a.account_number AS account, h.bank_unique_id AS id, c.name AS category, h.note, h.applied
       FROM carry_over h JOIN accounts a ON a.id = h.account_id LEFT JOIN categories c ON c.id = h.override_category ORDER BY a.account_number, h.bank_unique_id`,
    ).all()
  ).results
const changeLog = async () => (await env.DB.prepare('SELECT summary, type, after FROM change_log ORDER BY id').all<{ summary: string; type: string; after: string }>()).results
const lastEntry = async () => {
  const log = await changeLog()
  return { ...log.at(-1)!, after: JSON.parse(log.at(-1)!.after) as Record<string, unknown> }
}
const imported = async (id: number) => (await call(`/api/imports/imported/${id}`)).json()

/** Puts `count` Import-sourced rows straight into an Account (bypassing the API), to reach the limits. */
const seedImportRows = (id: number, count: number) =>
  env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id)
     SELECT ?1, '2020-01-01', -100, 'EXAMPLE', 'import', 'SEED' || i FROM n`,
  )
    .bind(id, count)
    .run()

const addSyncRow = (id: number, uniqueId: string) =>
  env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source, bank_unique_id) VALUES (?, '2026-10-01', -500, 'EXAMPLE SYNCED', 'sync', ?)")
    .bind(id, uniqueId)
    .run()

beforeEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS fail_insert').run()
  await env.DB.prepare("UPDATE categories SET removed_at = NULL WHERE name IN ('Groceries', 'Fuel')").run()
  await env.DB.batch(['carry_over', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
})

describe('Replace imported history: carrying Overrides and Notes over', () => {
  it('gives a re-imported Transaction the Override and Note of the one it replaces, matched by the bank unique ID alone', async () => {
    await importOk([row('A1'), row('A2'), row('A3'), row('A4')])
    await annotate('A1', { category: 'Groceries', note: 'Weekly shop' })
    await annotate('A2', { category: 'Fuel' })
    await annotate('A3', { note: 'Birthday present' })

    // Same bank IDs, but the file is a corrected export: other amounts, and a row that is new.
    const result = await importOk([row('A1', '2026-09-01', -2000), row('A2', '2026-09-01', -2000), row('A3', '2026-09-01', -2000), row('A4', '2026-09-01', -2000), row('A5', '2026-09-01', -2000)], { replace: true })

    expect(result).toMatchObject({ added: 5, removed: 4, carried: 3, carriedTotal: 3, lost: 0 })
    expect(await stored()).toEqual([
      { id: 'A1', category: 'Groceries', note: 'Weekly shop', source: 'import' },
      { id: 'A2', category: 'Fuel', note: null, source: 'import' },
      { id: 'A3', category: null, note: 'Birthday present', source: 'import' },
      withoutAnnotations('A4'),
      withoutAnnotations('A5'),
    ])
    expect(await waiting()).toEqual([])
  })

  it('shows the carried Override as the Transaction’s Category in the list, the way the Admin set it', async () => {
    await importOk([row('A1')])
    await annotate('A1', { category: 'Groceries', note: 'Weekly shop' })

    await importOk([row('A1', '2026-09-01', -2000)], { replace: true })

    const page = (await (await call('/api/transactions')).json()) as { transactions: { description: string; categoryName: string | null; categorySource: string | null; note: string | null }[] }
    expect(page.transactions).toMatchObject([{ description: 'EXAMPLE SHOP A1', categoryName: 'Groceries', categorySource: 'override', note: 'Weekly shop' }])
  })

  it('carries over to the Account it came from, and no other Account that happens to hold the same bank ID', async () => {
    await importOk([row('A1'), row('A2')])
    await importOk([row('A1'), row('A2')], { number: current })
    await annotate('A1', { category: 'Groceries', note: 'Savings only' })
    await annotate('A2', { note: 'Current only' }, current)

    await importOk([row('A1'), row('A2')], { replace: true })

    expect(await stored(savings)).toEqual([{ id: 'A1', category: 'Groceries', note: 'Savings only', source: 'import' }, withoutAnnotations('A2')])
    expect(await stored(current)).toEqual([withoutAnnotations('A1'), { id: 'A2', category: null, note: 'Current only', source: 'import' }])
  })

  it('carries across the chunks of an Import, and the last chunk reports the totals', async () => {
    await importOk([row('A1'), row('A2'), row('A3'), row('A4')])
    await annotate('A1', { note: 'In the first chunk' })
    await annotate('A3', { category: 'Fuel' })
    await annotate('A4', { note: 'Not in the file' })

    const first = await importOk([row('A1'), row('A2')], { replace: true, count: 2 })
    expect(first).toMatchObject({ added: 2, removed: 4, carried: 1, carriedTotal: null, lost: null })
    // A3 and A4 are waiting for their rows; A1 has been given its Note and is kept only to be counted.
    expect(await waiting()).toMatchObject([
      { id: 'A1', applied: 1 },
      { id: 'A3', category: 'Fuel', applied: 0 },
      { id: 'A4', note: 'Not in the file', applied: 0 },
    ])
    expect(await imported(await accountId())).toMatchObject({ carryOverWaiting: 2 })

    const last = await importOk([row('A3'), row('A5')], { index: 1, count: 2 })

    expect(last).toMatchObject({ added: 2, removed: 0, carried: 1, carriedTotal: 2, lost: 1 })
    expect(await stored()).toEqual([
      { id: 'A1', category: null, note: 'In the first chunk', source: 'import' },
      withoutAnnotations('A2'),
      { id: 'A3', category: 'Fuel', note: null, source: 'import' },
      withoutAnnotations('A5'),
    ])
    expect(await waiting()).toEqual([])
    expect(await imported(await accountId())).toMatchObject({ carryOverWaiting: 0 })
  })

  it('carries across the stepwise clear-history path, from the steps and from the final replace alike', async () => {
    await importOk([row('OLD1')])
    const id = await accountId()
    await seedImportRows(id, 5200) // 5,201 Import-sourced rows in all: the first 5,000 by ID go in the step
    await annotate('SEED10', { category: 'Groceries', note: 'Removed in the step' })
    await annotate('SEED5100', { note: 'Removed with the replace' })

    const step = await call('/api/imports/clear-history', { method: 'POST', body: { accountId: id } })
    expect(await step.json()).toEqual({ removed: 5000, remaining: 201 })
    expect(await waiting()).toMatchObject([{ id: 'SEED10', category: 'Groceries', note: 'Removed in the step', applied: 0 }])

    const result = await importOk([row('SEED10'), row('SEED5100'), row('NEW1')], { replace: true })

    expect(result).toMatchObject({ added: 3, removed: 201, carried: 2, carriedTotal: 2, lost: 0 })
    expect(await stored()).toEqual([
      withoutAnnotations('NEW1'),
      { id: 'SEED10', category: 'Groceries', note: 'Removed in the step', source: 'import' },
      { id: 'SEED5100', category: null, note: 'Removed with the replace', source: 'import' },
    ])
    expect(await waiting()).toEqual([])
  })

  it('says in the Change Log how many Overrides and Notes a clear-history step kept, and counts them in the end', async () => {
    await importOk([row('OLD1')])
    const id = await accountId()
    await seedImportRows(id, 5200)
    await annotate('SEED10', { note: 'One' })
    await annotate('SEED20', { category: 'Fuel' })
    await annotate('SEED5100', { note: 'Beyond the step' })
    await env.DB.prepare('DELETE FROM change_log').run()

    await call('/api/imports/clear-history', { method: 'POST', body: { accountId: id } })

    const step = await lastEntry()
    expect(step.summary).toBe(`Removed 5000 imported rows from ${savings} to replace its imported history (201 left), keeping the Overrides and Notes of 2 Transactions to carry over`)
    expect(step.after).toEqual({ removed: 5000, remaining: 201, heldForCarryOver: 2 })
    expect(await waiting()).toHaveLength(2)

    // The file has neither of them, so they are lost, and the Change Log says so.
    await importOk([row('NEW1')], { replace: true })
    expect(await lastEntry()).toMatchObject({ after: { carried: 0, carriedTotal: 0, lost: 3 } })
  })

  it('takes nothing from a clear-history step that held nothing, and leaves its Change Log entry as it was', async () => {
    await importOk([row('OLD1')])
    await seedImportRows(await accountId(), 5200)
    await env.DB.prepare('DELETE FROM change_log').run()

    await call('/api/imports/clear-history', { method: 'POST', body: { accountId: await accountId() } })

    expect((await lastEntry()).summary).toBe(`Removed 5000 imported rows from ${savings} to replace its imported history (201 left)`)
    expect(await waiting()).toEqual([])
  })
})

describe('Replace imported history: Categories that were removed', () => {
  it('does not revive an Override to a Category removed before the replace, but still carries the Note on the same Transaction', async () => {
    await importOk([row('A1'), row('A2'), row('A3')])
    await annotate('A1', { category: 'Fuel', note: 'Note outlives its Category' })
    await annotate('A2', { category: 'Fuel' })
    await annotate('A3', { category: 'Groceries' })
    await removeCategory('Fuel')

    const result = await importOk([row('A1'), row('A2'), row('A3')], { replace: true })

    expect(await stored()).toEqual([{ id: 'A1', category: null, note: 'Note outlives its Category', source: 'import' }, withoutAnnotations('A2'), { id: 'A3', category: 'Groceries', note: null, source: 'import' }])
    // A2 had nothing left to carry (the Admin removed its Category, which takes the Override away), so it is neither carried nor lost.
    expect(result).toMatchObject({ carried: 2, carriedTotal: 2, lost: 0 })
    expect(await waiting()).toEqual([])
  })

  it('does not revive an Override whose Category is removed while the Import is part way', async () => {
    await importOk([row('A1'), row('A2'), row('A3'), row('A4')])
    await annotate('A1', { category: 'Groceries' })
    await annotate('A2', { category: 'Fuel', note: 'Note stays' })
    await annotate('A3', { category: 'Fuel' })
    await annotate('A4', { category: 'Fuel' })
    await importOk([row('A1')], { replace: true, count: 2 })

    await removeCategory('Fuel')
    const last = await importOk([row('A2'), row('A3'), row('A4')], { index: 1, count: 2 })

    expect(await stored()).toEqual([
      { id: 'A1', category: 'Groceries', note: null, source: 'import' },
      { id: 'A2', category: null, note: 'Note stays', source: 'import' },
      withoutAnnotations('A3'),
      withoutAnnotations('A4'),
    ])
    // Only A1 and A2 have something to carry; A3 and A4 lost their Overrides when the Category was removed.
    expect(last).toMatchObject({ carried: 1, carriedTotal: 2, lost: 0 })
    expect(await waiting()).toEqual([])
  })

  it('does not hold the Override of a Category the replace finds already removed', async () => {
    await importOk([row('A1')])
    await annotate('A1', { category: 'Fuel' })
    await removeCategory('Fuel')

    await importOk([row('A1')], { replace: true, count: 2 })

    expect(await waiting()).toEqual([])
  })
})

describe('Replace imported history: Overrides and Notes with no match are reported', () => {
  it('counts them in the response and in the Change Log entry, and holds none back', async () => {
    await importOk([row('A1'), row('A2'), row('A3'), row('A4')])
    await annotate('A1', { category: 'Groceries', note: 'Matches' })
    await annotate('A2', { note: 'Not in the new file' })
    await annotate('A3', { category: 'Fuel' })
    await env.DB.prepare('DELETE FROM change_log').run()

    const result = await importOk([row('A1'), row('B9')], { replace: true })

    expect(result).toMatchObject({ added: 2, removed: 4, carried: 1, carriedTotal: 1, lost: 2 })
    expect(await stored()).toEqual([{ id: 'A1', category: 'Groceries', note: 'Matches', source: 'import' }, withoutAnnotations('B9')])
    expect(await waiting()).toEqual([])
    expect(await changeLog()).toEqual([
      {
        summary: `Replaced imported history in ${savings}: removed 4 rows, imported 2 rows, Overrides and Notes carried over for 1 Transaction, lost for 2 Transactions`,
        type: 'import',
        after: expect.any(String),
      },
    ])
    expect((await lastEntry()).after).toMatchObject({ replaced: true, removed: 4, added: 2, carried: 1, carriedTotal: 1, lost: 2 })
  })

  it('counts an Override or Note on a row dated on or after the Cutover Date as lost, because that row is not imported', async () => {
    await importOk([row('A1', '2026-09-01'), row('A2', '2026-09-20')])
    await annotate('A1', { note: 'Before' })
    await annotate('A2', { note: 'After' })

    const result = await importOk([row('A1', '2026-09-01'), row('A2', '2026-09-20')], { replace: true, cutoverDate: '2026-09-10' })

    expect(result).toMatchObject({ dropped: 1, carried: 1, carriedTotal: 1, lost: 1 })
    expect(await stored()).toEqual([{ id: 'A1', category: null, note: 'Before', source: 'import' }])
  })

  it('says nothing about carrying when there was nothing to carry, and the Change Log summary is as it always was', async () => {
    await importOk([row('A1')])
    await env.DB.prepare('DELETE FROM change_log').run()

    const result = await importOk([row('A1')], { replace: true })

    expect(result).toMatchObject({ carried: 0, carriedTotal: 0, lost: 0 })
    expect(await changeLog()).toMatchObject([{ summary: `Replaced imported history in ${savings}: removed 1 rows, imported 1 rows` }])
  })

  it('reports the totals on the last part of the Import, and each part’s own count on the others', async () => {
    await importOk([row('A1'), row('A2'), row('A3')])
    await annotate('A1', { note: 'One' })
    await annotate('A2', { note: 'Two' })
    await annotate('A3', { note: 'Three' })
    await env.DB.prepare('DELETE FROM change_log').run()

    await importOk([row('A1')], { replace: true, count: 3 })
    await importOk([row('A2')], { index: 1, count: 3 })
    await importOk([row('X9')], { index: 2, count: 3 })

    expect((await changeLog()).map((e) => e.summary)).toEqual([
      `Replaced imported history in ${savings}: removed 3 rows, imported 1 rows, Overrides and Notes carried over for 1 Transaction (part 1 of 3)`,
      `Imported 1 rows into ${savings}, Overrides and Notes carried over for 1 Transaction (part 2 of 3)`,
      `Imported 1 rows into ${savings}, Overrides and Notes carried over for 2 Transactions in all, lost for 1 Transaction (part 3 of 3)`,
    ])
    expect((await lastEntry()).after).toMatchObject({ part: 3, carried: 0, carriedTotal: 2, lost: 1 })
  })
})

describe('Replace imported history: Sync rows', () => {
  it('leaves a Sync row and its Override and Note exactly as they were, and neither carries nor loses them', async () => {
    await importOk([row('A1')])
    const id = await accountId()
    await addSyncRow(id, 'SYNC1')
    await annotate('SYNC1', { category: 'Fuel', note: 'From Sync' })
    await annotate('A1', { note: 'Imported' })

    const first = await importOk([row('A1')], { replace: true, count: 2 })

    expect(first).toMatchObject({ removed: 1, carried: 1 })
    expect(await waiting()).toMatchObject([{ id: 'A1', applied: 1 }]) // the Sync row's Override and Note were not held
    const last = await importOk([row('A2')], { index: 1, count: 2 })
    expect(last).toMatchObject({ carried: 0, carriedTotal: 1, lost: 0 })
    expect(await stored()).toEqual([
      { id: 'A1', category: null, note: 'Imported', source: 'import' },
      withoutAnnotations('A2'),
      { id: 'SYNC1', category: 'Fuel', note: 'From Sync', source: 'sync' },
    ])
  })

  it('does not hold a Sync row’s Override or Note when the history is cleared in steps', async () => {
    await importOk([row('OLD1')])
    const id = await accountId()
    await seedImportRows(id, 5000)
    await addSyncRow(id, 'SYNC1')
    await annotate('SYNC1', { note: 'From Sync' })

    await call('/api/imports/clear-history', { method: 'POST', body: { accountId: id } })

    expect(await waiting()).toEqual([])
    expect(await stored()).toContainEqual({ id: 'SYNC1', category: null, note: 'From Sync', source: 'sync' })
  })

  it('does not give a Sync row the Override or Note held for an imported row with the same bank ID, and counts that as lost', async () => {
    await importOk([row('A1'), row('A2')])
    await annotate('A2', { note: 'Held for A2' })
    await importOk([row('A1')], { replace: true, count: 3 })
    // Sync saves a Transaction under the bank ID the replace is still waiting for, before the part that has it arrives.
    await addSyncRow(await accountId(), 'A2')

    const second = await importOk([row('A2')], { index: 1, count: 3 })
    expect(second).toMatchObject({ added: 0, carried: 0 })
    expect(await waiting()).toMatchObject([{ id: 'A2', applied: 0 }]) // still waiting: nothing was given, so nothing is marked
    const last = await importOk([row('A3')], { index: 2, count: 3 })

    expect(last).toMatchObject({ added: 1, carried: 0, carriedTotal: 0, lost: 1 })
    expect(await stored()).toEqual([withoutAnnotations('A1'), withoutAnnotations('A2', 'sync'), withoutAnnotations('A3')])
    expect(await waiting()).toEqual([])
  })
})

describe('Replace imported history: when it does not complete', () => {
  it('keeps the old rows with their Overrides and Notes, and holds nothing, when the first chunk fails', async () => {
    await importOk([row('A1')])
    await annotate('A1', { category: 'Groceries', note: 'Kept' })
    await env.DB.prepare("CREATE TRIGGER fail_insert BEFORE INSERT ON transactions WHEN NEW.bank_unique_id = 'NEW1' BEGIN SELECT RAISE(ABORT, 'forced'); END").run()

    const res = await sendChunk([row('NEW1')], { replace: true })

    expect(res.status).toBe(500)
    expect(await stored()).toEqual([{ id: 'A1', category: 'Groceries', note: 'Kept', source: 'import' }])
    expect(await waiting()).toEqual([])
  })

  it('holds nothing and changes nothing when a Member tries to replace', async () => {
    await importOk([row('A1')])
    await annotate('A1', { note: 'Kept' })

    const res = await sendChunk([row('A1')], { replace: true }, 'member')

    expect(res.status).toBe(403)
    expect(await waiting()).toEqual([])
    expect(await stored()).toEqual([{ id: 'A1', category: null, note: 'Kept', source: 'import' }])
  })

  it('finishes carrying over when the Admin chooses the same file again and imports it plainly, and clears what is left', async () => {
    await importOk([row('A1'), row('A2'), row('A3')])
    await annotate('A1', { note: 'One' })
    await annotate('A2', { note: 'Two' })
    await annotate('A3', { note: 'Gone from the file' })
    await importOk([row('A1')], { replace: true, count: 2 }) // stops here: the second part is never sent
    expect(await imported(await accountId())).toMatchObject({ carryOverWaiting: 2 })

    await importOk([row('A1')], { count: 2 })
    const last = await importOk([row('A2')], { index: 1, count: 2 })

    expect(last).toMatchObject({ added: 1, carried: 1, carriedTotal: 2, lost: 1 })
    expect(await stored()).toEqual([
      { id: 'A1', category: null, note: 'One', source: 'import' },
      { id: 'A2', category: null, note: 'Two', source: 'import' },
    ])
    expect(await waiting()).toEqual([])
    expect(await imported(await accountId())).toMatchObject({ carryOverWaiting: 0 })
  })

  it('keeps what an interrupted replace was waiting for when the replace is started again, and does not count the same Transaction twice', async () => {
    await importOk([row('A1'), row('A2'), row('A3')])
    await annotate('A1', { note: 'One' })
    await annotate('A2', { note: 'Two' })
    await annotate('A3', { note: 'Three' })
    await importOk([row('A1')], { replace: true, count: 2 }) // stops after the first part

    const result = await importOk([row('A1'), row('A2'), row('A3')], { replace: true })

    expect(result).toMatchObject({ removed: 1, carried: 3, carriedTotal: 3, lost: 0 })
    expect(await stored()).toEqual([
      { id: 'A1', category: null, note: 'One', source: 'import' },
      { id: 'A2', category: null, note: 'Two', source: 'import' },
      { id: 'A3', category: null, note: 'Three', source: 'import' },
    ])
    expect(await waiting()).toEqual([])
  })

  it('forgets what an earlier attempt gave out when a replace starts again, so the new totals count only the new attempt', async () => {
    await importOk([row('A1'), row('A2')])
    await annotate('A1', { note: 'One' })
    await annotate('A2', { note: 'Two' })
    await importOk([row('A1')], { replace: true, count: 2 }) // stops after the first part: A1 was given its Note
    // The Admin takes that Note off the new row, so starting again holds nothing for A1.
    expect((await call(`/api/transactions/${await transactionId('A1')}/note`, { method: 'PUT', body: { note: '' } })).status).toBe(200)

    await importOk([row('A1')], { replace: true, count: 2 })
    const last = await importOk([row('A2')], { index: 1, count: 2 })

    expect(last).toMatchObject({ carried: 1, carriedTotal: 1, lost: 0 })
    expect(await waiting()).toEqual([])
  })

  // A clear-history step of a second attempt holds the rows the first attempt gave back, before the first chunk forgets them.
  it('holds a Transaction again, up to date and waiting, when an earlier attempt had already held and given it back', async () => {
    await importOk([row('A1')])
    await annotate('A1', { note: 'Now' })
    const id = await accountId()
    await env.DB.prepare("INSERT INTO carry_over (account_id, bank_unique_id, note, applied) VALUES (?, 'A1', 'Earlier', 1)").bind(id).run()

    await env.DB.prepare(HOLD_REMOVED).bind(id, 5000).run()

    expect(await waiting()).toMatchObject([{ id: 'A1', note: 'Now', applied: 0 }])
  })

  it('counts the Overrides and Notes still waiting, for the Account that has them and no other', async () => {
    await importOk([row('A1')])
    await importOk([row('A1')], { number: current })
    await annotate('A1', { note: 'Waiting' })
    await importOk([row('B1')], { replace: true, count: 2 })

    expect(await imported(await accountId())).toMatchObject({ imported: 1, withOverrideOrNote: 0, carryOverWaiting: 1 })
    expect(await imported(await accountId(current))).toMatchObject({ carryOverWaiting: 0 })
  })
})

describe('an Import with nothing to carry over', () => {
  it('reports zero carried and no totals, and writes no carry fields in the Change Log entry', async () => {
    const result = await importOk([row('A1')])

    expect(result).toMatchObject({ carried: 0, carriedTotal: null, lost: null })
    expect((await lastEntry()).after).not.toHaveProperty('carried')
  })
})

describe('the cost of carrying over (ADR 0004)', () => {
  /** The SQL of every statement a chunk request prepares, which is what counts against the 50 D1 queries of an invocation. */
  async function prepared(body: unknown) {
    const sql: string[] = []
    const countingDb = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') return (text: string) => (sql.push(text), target.prepare(text))
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const ctx = createExecutionContext()
    const request = new Request(`${origin}/api/imports/chunks`, { method: 'POST', headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const res = await worker.fetch!(request as never, { ...env, DB: countingDb }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    return sql
  }

  it('adds no statement to a plain chunk when nothing is waiting: it only reads, in the count it already made', async () => {
    await importOk([row('A1')])

    const sql = await prepared(chunkBody([row('A2')], { index: 1, count: 3 }))

    // find the Account, count the rows, then insert and write the Change Log entry
    expect(sql).toHaveLength(4)
    expect(sql.filter((s) => /UPDATE transactions|DELETE FROM carry_over|INSERT INTO carry_over/.test(s))).toEqual([])
  })

  it('gives a chunk that has something waiting two statements more, however many rows it carries', async () => {
    await importOk(Array.from({ length: 200 }, (_, i) => row(`A${i}`)))
    await env.DB.prepare("UPDATE transactions SET note = 'Example note'").run() // every row has a Note: set directly, 200 requests would be slow
    await importOk([row('A0')], { replace: true, count: 3 })

    const sql = await prepared(chunkBody(Array.from({ length: 199 }, (_, i) => row(`A${i + 1}`)), { index: 1, count: 3 }))

    // find the Account, count the rows, insert, give the rows what was held, mark it given, write the Change Log entry
    expect(sql).toHaveLength(6)
  })

  const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail)

  it('looks held rows up by the chunk’s own IDs, never by reading everything held or every Transaction', async () => {
    for (const sql of [APPLY_HELD, MARK_APPLIED]) {
      const details = await plan(sql, 1, '[]')
      expect(details.filter((d) => /^SCAN (h|carry_over|t|transactions)\b/.test(d)), details.join('\n')).toEqual([])
      expect(details.some((d) => /^SEARCH (h|carry_over) USING .*\(account_id=\? AND bank_unique_id=\?\)/.test(d)), details.join('\n')).toBe(true)
    }
  })
})
