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
  return res
}

/** A statement that sets a Setting outright, for the tests of `recordChange` and the schema, which need some change to log. The Admin's own change is `updateSettings` (settings.ts). */
export const putSetting = (db: D1Database, key: SettingKey, value: string): D1PreparedStatement =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value)

/** The Setting's value, or null if it has never been set. */
export const getSetting = (db: D1Database, key: SettingKey): Promise<string | null> => db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<string>('value')
