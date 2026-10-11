import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

// Seam 1: a change with nothing to say (removing a Category or a Rule, starting, stepping or stopping a re-run) takes the empty JSON object
// the change-request guard wants, and refuses a body with anything in it (worker/validate.ts `nothing`, a strict schema). The refusal names the
// body, not a value, and changes nothing. Not a Transfer's two routes are pinned the same way in not-a-transfer.test.ts.
const origin = 'http://localhost:5173'

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Cookie: 'fernledger_dev_as=admin' }
  if (opts.body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' })
  return exports.default.fetch(new Request(`${origin}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }))
}

const EXTRA = { extra: true }
const refused = { error: 'Invalid request', field: '' }

type Job = { status: string }
const job = async () => ((await (await call('/api/rules/rerun')).json()) as { job: Job | null }).job
const changeLogCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM change_log').first<{ n: number }>())!.n

beforeEach(async () => {
  await env.DB.batch(['data_migration_progress', 'rules', 'transactions', 'accounts', 'change_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  await env.DB.prepare('UPDATE categories SET removed_at = NULL').run()
  // Something for a re-run to walk.
  const account = await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example savings') RETURNING id").first<{ id: number }>()
  await env.DB.prepare("INSERT INTO transactions (account_id, date, amount_cents, description, source) VALUES (?, '2026-10-01', -1000, 'EXAMPLE SHOP', 'import')").bind(account!.id).run()
})

describe('DELETE /api/categories/:id', () => {
  it('refuses a body with anything in it, and removes the Category for the empty one', async () => {
    const created = await call('/api/categories', { method: 'POST', body: { name: 'Example strict body' } })
    const { id } = (await created.json()) as { id: number }
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call(`/api/categories/${id}`, { method: 'DELETE', body: EXTRA })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(refused)
    expect(await env.DB.prepare('SELECT removed_at FROM categories WHERE id = ?').bind(id).first()).toEqual({ removed_at: null })
    expect(await changeLogCount()).toBe(0)
    expect((await call(`/api/categories/${id}`, { method: 'DELETE', body: {} })).status).toBe(200)
  })
})

describe('DELETE /api/rules/:id', () => {
  it('refuses a body with anything in it, and removes the Rule for the empty one', async () => {
    const category = await env.DB.prepare("SELECT id FROM categories WHERE name = 'Groceries'").first<{ id: number }>()
    const created = await call('/api/rules', { method: 'POST', body: { textContains: 'EXAMPLE', categoryId: category!.id } })
    const { id } = (await created.json()) as { id: number }
    await env.DB.prepare('DELETE FROM change_log').run()

    const res = await call(`/api/rules/${id}`, { method: 'DELETE', body: EXTRA })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(refused)
    expect(await env.DB.prepare('SELECT removed_at FROM rules WHERE id = ?').bind(id).first()).toEqual({ removed_at: null })
    expect(await changeLogCount()).toBe(0)
    expect((await call(`/api/rules/${id}`, { method: 'DELETE', body: {} })).status).toBe(200)
  })
})

describe('the re-run routes', () => {
  it('POST /api/rules/rerun refuses a body with anything in it, starts nothing, and starts a re-run for the empty one', async () => {
    const res = await call('/api/rules/rerun', { method: 'POST', body: EXTRA })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(refused)
    expect(await job()).toBeNull()
    expect((await call('/api/rules/rerun', { method: 'POST', body: {} })).status).toBe(201)
    expect(await job()).toMatchObject({ status: 'running' })
  })

  it('POST /api/rules/rerun/step refuses a body with anything in it, takes no step, and takes one for the empty one', async () => {
    expect((await call('/api/rules/rerun', { method: 'POST', body: {} })).status).toBe(201)

    const res = await call('/api/rules/rerun/step', { method: 'POST', body: EXTRA })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(refused)
    expect(await job()).toMatchObject({ status: 'running' })
    const step = await call('/api/rules/rerun/step', { method: 'POST', body: {} })
    expect(step.status).toBe(200)
    expect(await job()).toMatchObject({ status: 'done' })
  })

  it('POST /api/rules/rerun/stop refuses a body with anything in it, stops nothing, and stops the re-run for the empty one', async () => {
    expect((await call('/api/rules/rerun', { method: 'POST', body: {} })).status).toBe(201)

    const res = await call('/api/rules/rerun/stop', { method: 'POST', body: EXTRA })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(refused)
    expect(await job()).toMatchObject({ status: 'running' })
    expect((await call('/api/rules/rerun/stop', { method: 'POST', body: {} })).status).toBe(200)
    expect(await job()).toMatchObject({ status: 'stopped' })
  })
})
