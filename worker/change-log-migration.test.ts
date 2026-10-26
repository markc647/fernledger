import type { D1Migration } from '@cloudflare/vitest-plugin'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

// The twin database (see worker/test-setup.ts) is re-run from the schema as it stood at 0202, so this checks 2401's backfill of old entries.
const testEnv = env as unknown as {
  TEST_MIGRATIONS: D1Migration[]
  RESTORE_TARGET: D1Database
}
const db = testEnv.RESTORE_TARGET
const run = (name: string) => testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith(name))!.queries.map((q) => db.prepare(q))

it('gives entries written before 2401 a type from their summary, and leaves an unrecognised one without', async () => {
  await db.batch([db.prepare('DROP TABLE change_log'), ...run('0202')])
  await db.batch(
    ['Changed settings: app title', 'Imported 3 rows into Account A', 'Renamed Account A to B', 'Something else entirely'].map((summary) =>
      db.prepare("INSERT INTO change_log (actor, summary) VALUES ('admin@example.com', ?)").bind(summary),
    ),
  )

  await db.batch(run('2401'))

  const { results } = await db.prepare('SELECT type FROM change_log ORDER BY id').all<{ type: string | null }>()
  expect(results.map((r) => r.type)).toEqual(['settings', 'import', 'account', null])
})
