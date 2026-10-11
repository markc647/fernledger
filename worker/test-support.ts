import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import worker from './index'

// Shared by the Worker tests (seam 1), and by nothing else: tsconfig.worker.json leaves this file out of the Worker.
const origin = 'http://localhost:5173'

/**
 * A request as the Admin through a database that runs `before` just ahead of the request's batch, to stand for another request landing between the handler's
 * reads and its write. Calls `worker.fetch` directly because the test changes the Worker's env (CODING_STANDARDS.md: Tests).
 */
export async function callWhileInterrupted(path: string, method: string, body: unknown, before: () => Promise<unknown>) {
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => (await before(), target.batch(statements))
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
