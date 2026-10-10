import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

// Seam 1: requests through the Worker's exported handler, as the local-development Admin or a read-only Member.
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

/** A made-up ASB row on the given date, with a unique ID of its own. */
const row = (id: string, date: string) => ({ date, uniqueId: id, tranType: 'EFTPOS', chequeNumber: null, payee: `EXAMPLE SHOP ${id}`, bankMemo: 'EFTPOS', amountCents: -1000 })

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

type AccountJson = { id: number; name: string; accountNumber: string; cutoverDate: string | null }
const accounts = async (): Promise<AccountJson[]> => (await call('/api/accounts')).json()
const accountId = async (number = savings) => (await accounts()).find((a) => a.accountNumber === number)!.id
const putCutover = (id: number, cutoverDate: unknown, who: Who = 'admin') => call(`/api/accounts/${id}/cutover-date`, { who, method: 'PUT', body: { cutoverDate } })
const changeLog = async () => (await env.DB.prepare('SELECT summary, actor, before, after FROM change_log ORDER BY id').all()).results
const stored = async (number = savings) =>
  (
    await env.DB.prepare(
      'SELECT t.date, t.bank_unique_id AS id, t.source FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.account_number = ? ORDER BY t.bank_unique_id',
    )
      .bind(number)
      .all<{ date: string; id: string; source: string }>()
  ).results
const storedIds = async (number = savings) => (await stored(number)).map((t) => t.id)

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
  await env.DB.batch(['transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
})

describe('PUT /api/accounts/:id/cutover-date', () => {
  it('lets the Admin set the Cutover Date, shows it on the Account, and logs the change with before and after', async () => {
    await sendChunk([row('A1', '2026-09-01')])
    const id = await accountId()
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await putCutover(id, '2026-10-02')

    expect(res.status).toBe(200)
    expect((await accounts())[0]!.cutoverDate).toBe('2026-10-02')
    expect(await changeLog()).toEqual([
      {
        actor: 'admin@example.com',
        summary: `Set the Cutover Date for ${savings} to 2026-10-02`,
        before: '{"cutoverDate":null}',
        after: '{"cutoverDate":"2026-10-02"}',
      },
    ])
  })

  it('lets the Admin clear it, and logs that', async () => {
    await sendChunk([row('A1', '2026-09-01')])
    const id = await accountId()
    await putCutover(id, '2026-10-02')
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await putCutover(id, null)

    expect(res.status).toBe(200)
    expect((await accounts())[0]!.cutoverDate).toBeNull()
    expect(await changeLog()).toMatchObject([
      { summary: `Cleared the Cutover Date for ${savings}`, before: '{"cutoverDate":"2026-10-02"}', after: '{"cutoverDate":null}' },
    ])
  })

  it('refuses a Member, and changes nothing', async () => {
    await sendChunk([row('A1', '2026-09-01')])
    const id = await accountId()
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await putCutover(id, '2026-10-02', 'member')

    expect(res.status).toBe(403)
    expect((await accounts())[0]!.cutoverDate).toBeNull()
    expect(await changeLog()).toEqual([])
  })

  it('answers 404 for an Account that does not exist, with no Change Log entry', async () => {
    expect((await putCutover(9999, '2026-10-02')).status).toBe(404)
    expect(await changeLog()).toEqual([])
  })

  it.each([['2026-02-30'], ['20261002'], ['2026-10-2'], [''], [42], [undefined]])('refuses the date %j', async (date) => {
    await sendChunk([row('A1', '2026-09-01')])

    const res = await putCutover(await accountId(), date)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'cutoverDate' })
    expect((await accounts())[0]!.cutoverDate).toBeNull()
  })

  it('does not delete anything already saved', async () => {
    await sendChunk([row('A1', '2026-10-01'), row('A2', '2026-10-03')])

    await putCutover(await accountId(), '2026-10-02')

    expect(await storedIds()).toEqual(['A1', 'A2'])
  })
})

describe('Import and the Cutover Date', () => {
  it('drops rows dated on or after the Cutover Date, boundary day included, and keeps earlier rows', async () => {
    await sendChunk([row('SEED', '2026-09-01')])
    await putCutover(await accountId(), '2026-10-01')
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await sendChunk([row('A1', '2026-09-30'), row('A2', '2026-10-01'), row('A3', '2026-10-02'), row('A4', '2026-10-03')])

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: 1, duplicates: 0, dropped: 3 })
    expect(await storedIds()).toEqual(['A1', 'SEED'])
    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry!.summary).toBe(`Imported 1 rows into ${savings}, skipped 3 dated on or after the Cutover Date`)
    expect(JSON.parse(entry!.after as string)).toMatchObject({ added: 1, duplicates: 0, dropped: 3, cutoverDate: '2026-10-01' })
  })

  it('imports every row when the Account has no Cutover Date', async () => {
    const res = await sendChunk([row('A1', '2026-09-30'), row('A2', '2099-12-31')])

    expect(await res.json()).toMatchObject({ added: 2, dropped: 0 })
    expect(await storedIds()).toEqual(['A1', 'A2'])
  })

  it('applies the Cutover Date to a later chunk of the same Import', async () => {
    await sendChunk([row('A1', '2026-09-01')], { count: 2 })
    await putCutover(await accountId(), '2026-10-01')

    const res = await sendChunk([row('B1', '2026-09-30'), row('B2', '2026-10-01')], { index: 1, count: 2 })

    expect(await res.json()).toMatchObject({ added: 1, dropped: 1 })
    expect(await storedIds()).toEqual(['A1', 'B1'])
  })

  it('does not count a dropped row as a duplicate or as added', async () => {
    await sendChunk([row('A1', '2026-10-05')])
    await putCutover(await accountId(), '2026-10-01')

    const res = await sendChunk([row('A1', '2026-10-05'), row('A2', '2026-10-06')])

    expect(await res.json()).toMatchObject({ added: 0, duplicates: 0, dropped: 2 })
  })

  it('sets the Cutover Date from the first chunk, creating the Account with it, and drops the rows on that date', async () => {
    const res = await sendChunk([row('A1', '2026-10-02'), row('A2', '2026-10-03')], { cutoverDate: '2026-10-03' })

    expect(await res.json()).toMatchObject({ added: 1, dropped: 1 })
    expect((await accounts())[0]!.cutoverDate).toBe('2026-10-03')
    expect(await storedIds()).toEqual(['A1'])
    const [entry] = await changeLog()
    expect(JSON.parse(entry!.after as string)).toMatchObject({ cutoverDate: '2026-10-03', newAccount: true, dropped: 1 })
  })

  it('changes an existing Account’s Cutover Date from the first chunk, logging the old one', async () => {
    await sendChunk([row('A1', '2026-09-01')])
    await putCutover(await accountId(), '2026-10-05')
    await env.DB.prepare('DELETE FROM change_log').run()

    await sendChunk([row('A2', '2026-10-02'), row('A3', '2026-10-04')], { cutoverDate: '2026-10-03' })

    expect((await accounts())[0]!.cutoverDate).toBe('2026-10-03')
    const [entry] = await changeLog()
    expect(JSON.parse(entry!.before as string)).toEqual({ cutoverDate: '2026-10-05' })
    expect(JSON.parse(entry!.after as string)).toMatchObject({ cutoverDate: '2026-10-03', added: 1, dropped: 1 })
  })

  it('refuses a Cutover Date on a chunk that is not the first, naming the field', async () => {
    await sendChunk([row('A1', '2026-09-01')], { count: 2 })

    const res = await sendChunk([row('A2', '2026-09-02')], { index: 1, count: 2, cutoverDate: '2026-10-03' })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'cutoverDate' })
    expect(await storedIds()).toEqual(['A1'])
  })

  it('refuses a Member who tries to set the Cutover Date through an Import, and changes nothing', async () => {
    await sendChunk([row('A1', '2026-09-01')])

    const res = await sendChunk([row('A2', '2026-09-02')], { cutoverDate: '2026-10-03' }, 'member')

    expect(res.status).toBe(403)
    expect((await accounts())[0]!.cutoverDate).toBeNull()
    expect(await storedIds()).toEqual(['A1'])
  })
})

describe('Replace imported history', () => {
  it('removes only the Account’s Import-sourced Transactions, then imports the file, even rows with the same bank IDs', async () => {
    await sendChunk([row('OLD1', '2026-09-01'), row('OLD2', '2026-09-02')])
    await sendChunk([row('OLD1', '2026-09-01')], { number: current })
    const id = await accountId()
    await addSyncRow(id, 'SYNC1')
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await sendChunk([row('OLD1', '2026-09-01'), row('NEW1', '2026-09-03')], { replace: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ added: 2, duplicates: 0, removed: 2 })
    expect(await stored(savings)).toEqual([
      { id: 'NEW1', date: '2026-09-03', source: 'import' },
      { id: 'OLD1', date: '2026-09-01', source: 'import' },
      { id: 'SYNC1', date: '2026-10-01', source: 'sync' },
    ])
    expect(await storedIds(current)).toEqual(['OLD1'])
    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ actor: 'admin@example.com', summary: `Replaced imported history in ${savings}: removed 2 rows, imported 2 rows` })
    expect(JSON.parse(entry!.after as string)).toMatchObject({ replaced: true, removed: 2, added: 2 })
  })

  it('keeps the old history when the replacement fails, because the removal and the first chunk are one batch', async () => {
    await sendChunk([row('OLD1', '2026-09-01'), row('OLD2', '2026-09-02')])
    await env.DB.prepare('DELETE FROM change_log').run()
    await env.DB.prepare("CREATE TRIGGER fail_insert BEFORE INSERT ON transactions WHEN NEW.bank_unique_id = 'NEW1' BEGIN SELECT RAISE(ABORT, 'forced'); END").run()

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true })

    expect(res.status).toBe(500)
    expect(await storedIds()).toEqual(['OLD1', 'OLD2'])
    expect(await changeLog()).toEqual([])
  })

  it('counts the removal for an Account with nothing to remove as zero, and just imports', async () => {
    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true })

    expect(await res.json()).toMatchObject({ added: 1, removed: 0 })
    expect(await storedIds()).toEqual(['NEW1'])
  })

  it('refuses replace on a chunk that is not the first, naming the field', async () => {
    await sendChunk([row('OLD1', '2026-09-01')], { count: 2 })

    const res = await sendChunk([row('NEW1', '2026-09-03')], { index: 1, count: 2, replace: true })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'replace' })
    expect(await storedIds()).toEqual(['OLD1'])
  })

  it('refuses a Member, and removes nothing', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true }, 'member')

    expect(res.status).toBe(403)
    expect(await storedIds()).toEqual(['OLD1'])
  })

  it('removes the rows and applies the Cutover Date in the same Import', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])

    const res = await sendChunk([row('NEW1', '2026-09-03'), row('NEW2', '2026-10-03')], { replace: true, cutoverDate: '2026-10-03' })

    expect(await res.json()).toMatchObject({ added: 1, removed: 1, dropped: 1 })
    expect(await storedIds()).toEqual(['NEW1'])
  })

  it('refuses a replace whose rows are all on or after the Account’s Cutover Date, and keeps the old history', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await putCutover(await accountId(), '2026-09-03')
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await sendChunk([row('NEW1', '2026-09-03'), row('NEW2', '2026-09-04')], { replace: true })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: expect.stringContaining('dated on or after the Cutover Date') })
    expect(await storedIds()).toEqual(['OLD1'])
    expect(await changeLog()).toEqual([])
  })

  it('refuses a replace whose rows are all on or after the Cutover Date it sets, and keeps the old history and the old Cutover Date', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true, cutoverDate: '2026-09-03' })

    expect(res.status).toBe(400)
    expect(await storedIds()).toEqual(['OLD1'])
    expect((await accounts())[0]!.cutoverDate).toBeNull()
  })

  it('still replaces when at least one row of the file is before the Cutover Date', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await putCutover(await accountId(), '2026-09-03')

    const res = await sendChunk([row('NEW1', '2026-09-02'), row('NEW2', '2026-09-03')], { replace: true })

    expect(res.status).toBe(200)
    expect(await storedIds()).toEqual(['NEW1'])
  })

  it('replaces exactly 5,000 imported rows in one chunk, the most it removes at once', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await seedImportRows(await accountId(), 4999)

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true })

    expect(await res.json()).toMatchObject({ added: 1, removed: 5000 })
    expect(await storedIds()).toEqual(['NEW1'])
  })

  it('answers 429 with a plain message when D1 says the daily allowance is used up, and saves nothing', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await env.DB.prepare("CREATE TRIGGER fail_insert BEFORE INSERT ON transactions WHEN NEW.bank_unique_id = 'NEW1' BEGIN SELECT RAISE(ABORT, 'exceeded the daily rows written limit'); END").run()

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true })

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Daily limit reached' })
    expect(await storedIds()).toEqual(['OLD1'])
  })

  it('leaves the history alone and says how many remain when there are too many rows to remove with one chunk', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await seedImportRows(await accountId(), 5000) // 5,001 Import-sourced rows in all
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ remaining: 5001 })
    expect(await storedIds()).toHaveLength(5001)
    expect(await changeLog()).toEqual([])
  })
})

describe('POST /api/imports/clear-history', () => {
  const clear = (id: number, who: Who = 'admin') => call('/api/imports/clear-history', { who, method: 'POST', body: { accountId: id } })

  it('removes up to 5,000 Import-sourced rows of the Account, logs the count, and reports how many remain', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await sendChunk([row('OTHER1', '2026-09-01')], { number: current })
    const id = await accountId()
    await seedImportRows(id, 5200)
    await addSyncRow(id, 'SYNC1')
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await clear(id)

    expect(await res.json()).toEqual({ removed: 5000, remaining: 201 })
    expect(await storedIds()).toHaveLength(201 + 1)
    expect(await storedIds(current)).toEqual(['OTHER1'])
    const [entry, ...rest] = await changeLog()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ actor: 'admin@example.com', summary: `Removed 5000 imported rows from ${savings} to replace its imported history (201 left)` })
    expect(JSON.parse(entry!.after as string)).toEqual({ removed: 5000, remaining: 201 })
  })

  it('never removes Sync-sourced rows', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    const id = await accountId()
    await seedImportRows(id, 5000)
    await addSyncRow(id, 'SYNC1')

    expect(await (await clear(id)).json()).toEqual({ removed: 5000, remaining: 1 })

    expect((await stored()).map((t) => t.source).sort()).toEqual(['import', 'sync'])
  })

  it('leaves the Import-sourced rows of other Accounts alone', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await sendChunk([row('OTHER1', '2026-09-01')], { number: current })
    await seedImportRows(await accountId(), 5200)
    await seedImportRows(await accountId(current), 5200)

    await clear(await accountId())

    expect(await storedIds(current)).toHaveLength(5201)
  })

  it('refuses (409) when the history is small enough to replace in one go, so it is only a step of a replace, and removes nothing', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    const id = await accountId()
    await seedImportRows(id, 4999) // 5,000 Import-sourced rows: exactly what one replace removes
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await clear(id)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ remaining: 5000 })
    expect(await storedIds()).toHaveLength(5000)
    expect(await changeLog()).toEqual([])
  })

  it.each([0, -1, 'one', 1.5, null])('refuses accountId %j as an invalid request, and removes nothing', async (bad) => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await seedImportRows(await accountId(), 5200)

    const res = await call('/api/imports/clear-history', { method: 'POST', body: { accountId: bad } })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request', field: 'accountId' })
    expect(await storedIds()).toHaveLength(5201)
  })

  it('then lets the replacement go through in one chunk, so a large history is replaced in steps', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])
    await seedImportRows(await accountId(), 5000)
    expect((await clear(await accountId())).status).toBe(200)

    const res = await sendChunk([row('NEW1', '2026-09-03')], { replace: true })

    expect(await res.json()).toMatchObject({ added: 1, removed: 1 })
    expect(await storedIds()).toEqual(['NEW1'])
  })

  it('refuses a Member, and removes nothing', async () => {
    await sendChunk([row('OLD1', '2026-09-01')])

    expect((await clear(await accountId(), 'member')).status).toBe(403)

    expect(await storedIds()).toEqual(['OLD1'])
  })

  it('answers 404 for an Account that does not exist, with no Change Log entry', async () => {
    expect((await clear(9999)).status).toBe(404)
    expect(await changeLog()).toEqual([])
  })
})

describe('GET /api/imports/imported/:accountId', () => {
  const imported = (id: number | string, who: Who = 'admin') => call(`/api/imports/imported/${id}`, { who })

  it('counts only the Import-sourced rows of the Account', async () => {
    await sendChunk([row('OLD1', '2026-09-01'), row('OLD2', '2026-09-02')])
    await sendChunk([row('OTHER1', '2026-09-01')], { number: current })
    const id = await accountId()
    await addSyncRow(id, 'SYNC1')

    expect(await (await imported(id)).json()).toEqual({ imported: 2, withOwnWork: 0, paired: 0, carryOverWaiting: 0 })
  })

  it('counts the Import-sourced rows that have an Override to a Category in use or a Note, which a replace would remove', async () => {
    await sendChunk([row('A', '2026-09-01'), row('B', '2026-09-02'), row('C', '2026-09-03'), row('D', '2026-09-04'), row('E', '2026-09-05')])
    const id = await accountId()
    const category = (name: string) => env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first<{ id: number }>().then((r) => r!.id)
    const set = (bankId: string, column: 'override_category' | 'note', value: number | string) =>
      env.DB.prepare(`UPDATE transactions SET ${column} = ? WHERE account_id = ? AND bank_unique_id = ?`).bind(value, id, bankId).run()
    await set('A', 'override_category', await category('Groceries'))
    await set('A', 'note', 'Both on one row counts once')
    await set('B', 'note', 'Only a Note')
    await set('C', 'override_category', await category('Fuel'))
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-01T00:00:00Z' WHERE name = 'Fuel'").run()
    await addSyncRow(id, 'SYNC1')
    await set('SYNC1', 'note', 'Sync rows are not removed by a replace')

    expect(await (await imported(id)).json()).toEqual({ imported: 5, withOwnWork: 2, paired: 0, carryOverWaiting: 0 })
  })

  it('answers 404 for an Account that does not exist', async () => {
    expect((await imported(9999)).status).toBe(404)
    expect((await imported('x')).status).toBe(404)
  })
})
