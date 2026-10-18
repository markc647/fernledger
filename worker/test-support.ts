import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import worker from './index'
import type { SettingKey } from './settings'

// Shared by the Worker tests (seam 1), and by nothing else: tsconfig.worker.json leaves this file out of the Worker.
const origin = 'http://localhost:5173'

/**
 * A request as the Admin through a database that runs `before` just ahead of the request's write, to stand for another request landing between the handler's reads
 * and its write. The write is the batch `recordChange` runs (the one that ends with the Change Log entry), so a handler that reads in a batch of its own is
 * interrupted after its reads and not before them. Calls `worker.fetch` directly because the test changes the Worker's env (CODING_STANDARDS.md: Tests).
 */
export async function callWhileInterrupted(path: string, method: string, body: unknown, before: () => Promise<unknown>) {
  // Statements are wrapped to remember their SQL, and unwrapped for D1 (which wants its own).
  const original = new WeakMap<object, D1PreparedStatement>()
  const sqlOf = new WeakMap<object, string>()
  const track = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => track(target.bind(...values), sql)
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    original.set(wrapped, statement)
    sqlOf.set(wrapped, sql)
    return wrapped
  }
  let interrupted = false
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => track(target.prepare(sql), sql)
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!interrupted && sqlOf.get(statements.at(-1)!)?.startsWith('INSERT INTO change_log')) {
            interrupted = true
            await before()
          }
          return target.batch(statements.map((statement) => original.get(statement) ?? statement))
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const ctx = createExecutionContext()
  const request = new Request(`${origin}${path}`, { method, headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const res = await worker.fetch!(request as never, { ...env, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  // A test that interrupts nothing proves nothing: if the handler's write stopped ending with the Change Log insert, say so rather than pass.
  if (!interrupted) throw new Error('callWhileInterrupted: the request never ran a batch ending in the Change Log insert, so nothing was interrupted')
  return res
}

/**
 * D1 that totals the rows D1 says it read and wrote for what is run on it (what the free plan bills: ADR 0004), and how many queries it was asked (a statement in a batch is one
 * each, as the 50 a request may run count them), batches included. Pass it to `callAsAdminWith`. Its statements are wrappers, so only `bind`, `first`, `all` and `run` work on them,
 * and a batch takes the ones it made.
 */
export function meteredDb() {
  const usage = { rowsRead: 0, rowsWritten: 0, queries: 0 }
  const count = (result: D1Result) => {
    usage.rowsRead += result.meta.rows_read
    usage.rowsWritten += result.meta.rows_written
    usage.queries += 1
  }
  const original = new WeakMap<object, D1PreparedStatement>()
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const read = async () => {
      const result = await statement.all()
      count(result)
      return result
    }
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: read,
      first: async () => (await read()).results[0] ?? null,
      run: async () => {
        const result = await statement.run()
        count(result)
        return result
      },
    }
    original.set(wrapped, statement)
    return wrapped as unknown as D1PreparedStatement
  }
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await env.DB.batch(statements.map((statement) => original.get(statement)!))
      for (const result of results) count(result)
      return results
    },
  } as unknown as D1Database
  return { db, usage }
}

/** A request as the Admin with `db` standing in for D1 (see `meteredDb`). */
export async function callAsAdminWith(db: D1Database, path: string, method: string, body: unknown) {
  const ctx = createExecutionContext()
  const request = new Request(`${origin}${path}`, { method, headers: { Cookie: 'fernledger_dev_as=admin', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const res = await worker.fetch!(request as never, { ...env, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

/**
 * The Admin has kept a Report with these choices (the Report page asks for that when it shows one: worker/kept-reports.ts), so a Member may read it. The tests of a Report's figures read as
 * the Admin, who is not held to the list; the ones that show a Member reads the same call this first. A test that does clears `kept_reports` in its `beforeEach`.
 */
export async function keepReport(report: string, { accountId = null, categoryId = null, from = null, to }: { accountId?: number | null; categoryId?: number | null; from?: string | null; to: string }) {
  await env.DB.prepare('INSERT OR IGNORE INTO kept_reports (report, account_id, category_id, from_date, to_date, made_by) VALUES (?, ?, ?, ?, ?, ?)').bind(report, accountId, categoryId, from, to, 'admin@example.com').run()
}

/** A statement that sets a Setting outright, for the tests of `recordChange` and the schema, which need some change to log. The Admin's own change is `updateSettings` (settings.ts). */
export const putSetting = (db: D1Database, key: SettingKey, value: string): D1PreparedStatement =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value)

/** The Setting's value, or null if it has never been set. */
export const getSetting = (db: D1Database, key: SettingKey): Promise<string | null> => db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<string>('value')
