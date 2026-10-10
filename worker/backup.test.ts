import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_CRON, BACKUP_STATE_KEY, CHUNK_BYTES, INVOCATION_BYTES } from './backup'
import { BackupFormatError, checkPart, insertStatements, loadOrder, parseManifest, type Manifest } from './backup-format'
import worker from './index'

// Seam 1: a scheduled event into the Worker, with the real local D1 and R2 from wrangler.jsonc.
const sunday = new Date('2026-10-11T15:00:00Z') // 04:00 Monday 12 Oct in NZ (NZDT)
const nextSunday = new Date('2026-10-18T15:00:00Z') // Monday 19 Oct in NZ
const daily = '0 18 * * *'
const restoreTarget = (env as unknown as { RESTORE_TARGET: D1Database }).RESTORE_TARGET

async function runCron(cron: string, scheduledTime: Date, bindings: Env = env) {
  await worker.scheduled(createScheduledController({ cron, scheduledTime }), bindings)
}

// Runs the daily cron on successive days (each its own invocation) until the backup under `prefix` has a manifest.
async function finishRun(prefix: string, bindings: Env = env, maxInvocations = 14) {
  for (let day = 0; day < maxInvocations && !(await env.BACKUPS.head(`${prefix}/manifest.json`)); day++) {
    await runCron(daily, new Date(Date.UTC(2026, 9, 12 + day, 18)), bindings)
  }
}

async function readManifest(prefix: string): Promise<Manifest> {
  const object = await env.BACKUPS.get(`${prefix}/manifest.json`)
  expect(object, `no manifest under ${prefix}`).not.toBeNull()
  return parseManifest(await object!.text())
}

const partBytes = async (key: string) => new Uint8Array(await (await env.BACKUPS.get(key))!.arrayBuffer())
const ndjson = async (key: string) => new TextDecoder().decode(await partBytes(key)).trimEnd().split('\n')
const savedState = async () => JSON.parse(await (await env.BACKUPS.get(BACKUP_STATE_KEY))!.text())
const backupKeys = async () => (await env.BACKUPS.list()).objects.map((o) => o.key)

// Wraps the bindings and counts every D1 query and R2 call, which the free plan limits to 50 each per invocation.
// `diesAfterParts` simulates the isolate being killed (for example by the CPU limit) after that many parts.
function counted({ diesAfterParts = Infinity } = {}) {
  const ops = { d1: 0, r2: 0, deletes: 0, partBytes: 0, parts: 0 }
  let dead = false
  const statement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as (...args: unknown[]) => unknown
        if (prop === 'bind') return (...args: unknown[]) => statement(value.apply(target, args) as D1PreparedStatement)
        if (prop === 'all' || prop === 'first' || prop === 'run' || prop === 'raw') {
          return (...args: unknown[]) => (ops.d1++, value.apply(target, args))
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (query: string) => statement(target.prepare(query))
      if (prop === 'batch' || prop === 'exec') throw new Error('The backup is not expected to use batch or exec')
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const BACKUPS = new Proxy(env.BACKUPS, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        ops.r2++
        if (prop === 'delete') ops.deletes++
        if (prop === 'put') {
          const isPart = String(args[0]).endsWith('.ndjson')
          if (dead || (isPart && ops.parts >= diesAfterParts)) throw ((dead = true), new Error('R2 is gone'))
          if (isPart) {
            ops.parts++
            ops.partBytes += (args[1] as Uint8Array).byteLength
          }
        }
        return value.apply(target, args)
      }
    },
  })
  return { ops, bindings: { ...env, DB, BACKUPS } as Env }
}

// The ordinary tables the backup copies. Virtual tables, their shadow tables and WITHOUT ROWID tables are skipped.
const tableNames = async (db: D1Database = env.DB) =>
  (
    await db
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND wr = 0 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((t) => t.name)

// Each test starts from the migrated schema with no rows, no extra tables and an empty bucket.
const reset = async (db: D1Database) => {
  const named = async (where: string) =>
    (await db.prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND ${where}`).all<{ name: string }>()).results.map((t) => t.name)
  for (const name of await named("type = 'virtual'")) await db.prepare(`DROP TABLE "${name}"`).run() // takes its shadow tables with it
  for (const name of await named("type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'")) {
    // Kept, empty: the daily crons look in data_migration_progress for a Rules re-run to carry on (worker/rule-rerun.ts).
    if (name === 'settings' || name === 'change_log' || name === 'data_migration_progress') await db.prepare(`DELETE FROM "${name}"`).run()
    else await db.prepare(`DROP TABLE "${name}"`).run()
  }
  await db.prepare('DELETE FROM sqlite_sequence').run()
}
beforeEach(async () => {
  await reset(env.DB)
  await reset(restoreTarget)
  const { objects } = await env.BACKUPS.list()
  if (objects.length) await env.BACKUPS.delete(objects.map((o) => o.key))
})
afterEach(() => vi.restoreAllMocks())

const seedChangeLog = (rows: number) =>
  env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
     INSERT INTO change_log (actor, summary) SELECT 'a@example.com', 'Change ' || i FROM n`,
  ).run()

describe('weekly backup', () => {
  it('writes a manifest under the NZ date, with a row count for each table', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()

    await runCron(BACKUP_CRON, sunday)

    const manifest = await readManifest('backups/2026-10-12')
    expect(manifest.tables.find((t) => t.name === 'settings')?.rows).toBe(1)
    expect(manifest.tables.find((t) => t.name === 'change_log')?.rows).toBe(0)
  })

  it('has every table the database has, including ones this code has never heard of', async () => {
    await env.DB.prepare('CREATE TABLE "future table" (id INTEGER PRIMARY KEY, "odd ""name" TEXT)').run()
    await env.DB.prepare('INSERT INTO "future table" ("odd ""name") VALUES (\'x\')').run()

    await runCron(BACKUP_CRON, sunday)

    const manifest = await readManifest('backups/2026-10-12')
    const inDatabase = await tableNames()
    expect(inDatabase).toContain('future table')
    expect(manifest.tables.map((t) => t.name).sort()).toEqual(inDatabase)
    expect(manifest.tables.find((t) => t.name === 'future table')?.rows).toBe(1)
  })

  it('skips tables it cannot page by rowid, and says so in the manifest', async () => {
    await env.DB.prepare('CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID').run()
    await env.DB.prepare('CREATE VIRTUAL TABLE search USING fts5(body)').run()
    await env.DB.prepare("INSERT INTO pairs VALUES ('x', 'y')").run()
    await env.DB.prepare("INSERT INTO search (body) VALUES ('hello')").run()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCron(BACKUP_CRON, sunday)

    const manifest = await readManifest('backups/2026-10-12')
    const skipped = manifest.skipped.map((s) => s.name)
    expect(skipped).toEqual(expect.arrayContaining(['pairs', 'search', 'search_data', 'search_content']))
    expect(manifest.skipped.every((s) => s.reason.length > 0)).toBe(true)
    expect(manifest.tables.map((t) => t.name).sort()).toEqual(await tableNames()) // everything else is still there
    expect(manifest.tables.map((t) => t.name)).not.toContain('pairs')
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining('backup.tables_skipped')]))
  })

  it('records the migrations the database had applied', async () => {
    await runCron(BACKUP_CRON, sunday)

    const applied = (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((m) => m.name)
    expect(applied.length).toBeGreaterThan(0)
    expect((await readManifest('backups/2026-10-12')).migrations).toEqual(applied)
  })

  it('writes NDJSON parts whose checksums and row counts match the manifest', async () => {
    await env.DB.prepare("INSERT INTO change_log (actor, summary, after) VALUES ('a@example.com', 'Line one\nO''Brien \"quoted\"', NULL)").run()
    await env.DB.prepare("INSERT INTO change_log (actor, summary) VALUES ('b@example.com', 'Second')").run()

    await runCron(BACKUP_CRON, sunday)

    const log = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'change_log')!
    expect(log.rows).toBe(2)
    const [only] = log.parts
    expect(log.parts).toHaveLength(1)
    const bytes = await partBytes(only!.key)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    expect(only!.sha256).toBe([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''))
    const rows = (await ndjson(only!.key)).map((l) => JSON.parse(l))
    expect(rows).toMatchObject([{ id: 1, summary: 'Line one\nO\'Brien "quoted"', after: null }, { id: 2, summary: 'Second' }])
  })

  it('keeps every earlier backup and deletes nothing', async () => {
    const { ops, bindings } = counted()
    await runCron(BACKUP_CRON, sunday, bindings)
    await runCron(BACKUP_CRON, nextSunday, bindings)

    expect(ops.deletes).toBe(0)
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).not.toBeNull()
    expect(await env.BACKUPS.head('backups/2026-10-19/manifest.json')).not.toBeNull()
  })

  it('logs counts and error classes only, never row contents', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('about_contact', 'zz-private-contact')").run()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCron(BACKUP_CRON, sunday)

    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('backup.complete'))).toBe(true)
    expect(lines.join('\n')).not.toContain('zz-private-contact')
    expect(lines.join('\n')).not.toContain('about_contact')
  })

  it('does nothing on another cron when no backup is unfinished', async () => {
    await runCron(daily, new Date('2026-10-13T18:00:00Z'))

    expect((await env.BACKUPS.list()).objects).toEqual([])
  })
})

describe('free-plan limits', () => {
  // 42 tables of one row each: every chunk is then limited by the operation budget, not by bytes.
  async function seedManyTinyTables() {
    for (let i = 1; i <= 40; i++) {
      await env.DB.prepare(`CREATE TABLE tiny_${String(i).padStart(2, '0')} (id INTEGER PRIMARY KEY, v TEXT)`).run()
      await env.DB.prepare(`INSERT INTO tiny_${String(i).padStart(2, '0')} (v) VALUES ('x')`).run()
    }
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    await seedChangeLog(1)
  }

  it('uses exactly the operation budget it is given: 38 on the weekly cron, 16 on a continuation', async () => {
    await seedManyTinyTables()

    const weekly = counted()
    await runCron(BACKUP_CRON, sunday, weekly.bindings)
    // R2: read the saved run, check for a finished backup, then per table a part and a cursor save.
    // D1: the schema and the applied migrations, then one read per table. A short page needs no empty read after it.
    // (The table of Rules re-run progress is one of them, and empty: it costs a read and no part.)
    expect(weekly.ops).toMatchObject({ d1: 2 + 12, r2: 2 + 11 * 2 })
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull()

    const next = counted()
    await runCron(daily, new Date('2026-10-12T18:00:00Z'), next.bindings)
    // D1: 5 for the backup and 1 more, which the Rules re-run spends to look for a job to carry on (the weekly cron does not).
    expect(next.ops).toMatchObject({ d1: 5 + 1, r2: 1 + 5 * 2 })

    // The 50-query and 50-subrequest limits leave room: Sync shares the daily crons. (A running re-run adds at most CRON_CHUNKS * 4 + 2
    // more on those, pinned in rule-rerun.test.ts: 14 and the backup's 20 are well inside 50.)
    expect(weekly.ops.d1 + weekly.ops.r2).toBeLessThanOrEqual(40)
    expect(next.ops.d1 + next.ops.r2).toBeLessThanOrEqual(20 + 1) // the backup's 20, and the re-run's look
  })

  it('stops at about 1 MB of NDJSON per invocation, so the CPU spent on encoding and hashing stays small', async () => {
    const text = 'x'.repeat(4000)
    const rows = 500 // 2 MB: more than one invocation may write
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
       INSERT INTO change_log (actor, summary) SELECT 'a@example.com', ?1 || i FROM n`,
    )
      .bind(text)
      .run()

    const weekly = counted()
    await runCron(BACKUP_CRON, sunday, weekly.bindings)

    expect(weekly.ops.partBytes).toBeGreaterThanOrEqual(INVOCATION_BYTES - CHUNK_BYTES)
    expect(weekly.ops.partBytes).toBeLessThanOrEqual(INVOCATION_BYTES + CHUNK_BYTES)
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull()

    await finishRun('backups/2026-10-12')
    const log = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'change_log')!
    expect(log.rows).toBe(rows)
    expect(log.parts.every((p) => p.bytes <= CHUNK_BYTES)).toBe(true)
    expect(log.parts.length).toBeGreaterThan(4)
  })

  it('finishes a run bigger than one invocation across invocations, each inside the limits, and loses no rows', async () => {
    const total = 30_000
    await seedChangeLog(total)

    const invocations: { d1: number; r2: number; partBytes: number }[] = []
    const first = counted()
    await runCron(BACKUP_CRON, sunday, first.bindings)
    invocations.push(first.ops)
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json'), 'one invocation cannot finish 30,000 rows').toBeNull()
    for (let day = 0; day < 14 && !(await env.BACKUPS.head('backups/2026-10-12/manifest.json')); day++) {
      const next = counted()
      await runCron(daily, new Date(Date.UTC(2026, 9, 12 + day, 18)), next.bindings)
      invocations.push(next.ops)
    }

    for (const { d1, r2, partBytes } of invocations) {
      expect(d1).toBeLessThanOrEqual(50)
      expect(r2).toBeLessThanOrEqual(50)
      expect(partBytes).toBeLessThanOrEqual(INVOCATION_BYTES + CHUNK_BYTES)
    }
    const log = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'change_log')!
    expect(log.rows).toBe(total)
    expect(log.parts.length).toBeGreaterThan(1)
    const ids = new Set<number>()
    for (const part of log.parts) {
      await checkPart(part, await partBytes(part.key))
      for (const line of await ndjson(part.key)) ids.add(JSON.parse(line).id)
    }
    expect(ids.size).toBe(total)
  }, 60_000)

  it('keeps the progress of an invocation that is killed part-way, and never redoes its chunks', async () => {
    const total = 5000
    await seedChangeLog(total)
    const dying = counted({ diesAfterParts: 2 })

    await expect(runCron(BACKUP_CRON, sunday, dying.bindings)).rejects.toThrow()

    // The cursor was saved after each chunk, before the invocation died: no manifest, but two parts are safe.
    const state = await savedState()
    const done = state.tables.find((t: { name: string }) => t.name === 'change_log')
    expect(done.parts).toHaveLength(2)
    expect(state.after).toBe(done.rows)
    const kept = await Promise.all(done.parts.map((p: { key: string }) => env.BACKUPS.head(p.key)))
    await finishRun('backups/2026-10-12')
    const log = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'change_log')!
    expect(log.rows).toBe(total)
    expect(log.parts.slice(0, 2)).toEqual(done.parts)
    const after = await Promise.all(done.parts.map((p: { key: string }) => env.BACKUPS.head(p.key)))
    expect(after.map((o) => o!.version)).toEqual(kept.map((o) => o!.version)) // not rewritten
  })
})

describe('runs and dates', () => {
  it('never overwrites a completed backup when the cron runs again on the same date', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    await runCron(BACKUP_CRON, sunday)
    const before = await Promise.all((await backupKeys()).map(async (k) => [k, (await env.BACKUPS.head(k))!.version]))
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('about_contact', 'Sam')").run()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCron(BACKUP_CRON, sunday)

    const after = await Promise.all((await backupKeys()).map(async (k) => [k, (await env.BACKUPS.head(k))!.version]))
    expect(after).toEqual(before)
    expect((await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'settings')?.rows).toBe(1)
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining('backup.skipped')]))
  })

  it('carries on an unfinished run of the same date instead of starting another', async () => {
    await seedChangeLog(30_000)
    await runCron(BACKUP_CRON, sunday)
    const partsBefore = (await savedState()).tables.find((t: { name: string }) => t.name === 'change_log').parts.length

    await runCron(BACKUP_CRON, sunday)

    const parts = (await savedState()).tables.find((t: { name: string }) => t.name === 'change_log').parts
    expect(parts.length).toBeGreaterThan(partsBefore)
    expect((await backupKeys()).every((k) => k.startsWith('backups/2026-10-12/') || k === BACKUP_STATE_KEY)).toBe(true)
  })

  // Seeds 30,000 Change Log rows: about 3 s alone, over the 5 s default when the suite runs on a busy machine.
  it('records a run it abandons for a new week, in R2, in the logs and in the next manifest', { timeout: 30_000 }, async () => {
    await seedChangeLog(30_000)
    await runCron(BACKUP_CRON, sunday)
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCron(BACKUP_CRON, nextSunday)

    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.find((l) => l.includes('backup.abandoned'))).toMatch(/"count":\d+/)
    const marker = await env.BACKUPS.get('backups/2026-10-12/incomplete.json')
    expect(marker, 'the abandoned run is marked').not.toBeNull()
    await finishRun('backups/2026-10-19')
    expect((await readManifest('backups/2026-10-19')).previousIncomplete).toBe('backups/2026-10-12')
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull() // still not a backup anyone can restore
  })

  it('starts afresh when the saved cursor is not one it wrote', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    await env.BACKUPS.put(BACKUP_STATE_KEY, JSON.stringify({ status: 'running', prefix: 5, tables: 'nope' }))

    await runCron(daily, new Date('2026-10-13T18:00:00Z')) // a continuation finds nothing it can use
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull()
    await runCron(BACKUP_CRON, sunday)

    expect((await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'settings')?.rows).toBe(1)
  })
})

describe('values that cannot round-trip', () => {
  async function failsLoudly(setup: string) {
    await env.DB.prepare('CREATE TABLE amounts (id INTEGER PRIMARY KEY, n NUMERIC)').run()
    await env.DB.prepare(setup).run()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(runCron(BACKUP_CRON, sunday)).rejects.toThrow()

    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.find((l) => l.includes('backup.failed'))).toContain('BackupFormatError')
    expect(lines.join('\n')).not.toMatch(/9007199254740993|9\.0e\+999|Inf/)
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull()
  }

  it('refuses a whole number above 2^53, which JSON would round', () => failsLoudly('INSERT INTO amounts (n) VALUES (9007199254740993)'))
  it('refuses infinity', () => failsLoudly('INSERT INTO amounts (n) VALUES (1e999)'))
})

describe('restoring a backup', () => {
  const dump = async (db: D1Database) => {
    // Enumerated from sqlite_master of the database being dumped, not from a list in this test, so a table that
    // is added later or missing from the restore shows up as a difference.
    const names = (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name")
        .all<{ name: string }>()
    ).results.map((t) => t.name)
    const out: Record<string, unknown[]> = {}
    for (const name of names) out[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results
    return out
  }

  async function restoreInto(db: D1Database, prefix: string) {
    const manifest = await readManifest(prefix)
    for (const table of manifest.tables) {
      for (const part of table.parts) {
        const bytes = await partBytes(part.key)
        await checkPart(part, bytes)
        for (const sql of insertStatements(table, new TextDecoder().decode(bytes), part.key)) await db.prepare(sql).run()
      }
    }
  }

  it('reproduces every table, row for row, in an empty database', async () => {
    await env.DB.prepare('CREATE TABLE odd (id INTEGER PRIMARY KEY, label TEXT, amount_cents INTEGER, ratio REAL, data BLOB, empty TEXT)').run()
    await restoreTarget.prepare('CREATE TABLE odd (id INTEGER PRIMARY KEY, label TEXT, amount_cents INTEGER, ratio REAL, data BLOB, empty TEXT)').run()
    await env.DB.prepare("INSERT INTO odd (label, amount_cents, ratio, data, empty) VALUES ('Tab\there, \"q\" ''s'' \r\n; DROP', -12345, 0.25, x'00ff10', '')").run()
    await env.DB.prepare('INSERT INTO odd (label, amount_cents, ratio, data, empty) VALUES (NULL, 0, NULL, NULL, NULL)').run()
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern'), ('about_contact', 'Sam')").run()
    await env.DB.prepare("INSERT INTO change_log (actor, summary, before, after) VALUES ('a@example.com', 'Changed it', '{\"a\":1}', NULL)").run()
    await runCron(BACKUP_CRON, sunday)

    await restoreInto(restoreTarget, 'backups/2026-10-12')

    expect(await dump(restoreTarget)).toEqual(await dump(env.DB))
    expect((await dump(restoreTarget)).odd).toHaveLength(2)
  })

  it('restores decimal values needing 17 significant digits exactly', async () => {
    const values = [0.1 + 0.2, 1 / 3, Math.PI, 1e22, 5e-324, 123456789.12345678, -2.5e-7, 1.7976931348623157e308]
    for (const db of [env.DB, restoreTarget]) await db.prepare('CREATE TABLE reals (id INTEGER PRIMARY KEY, x REAL)').run()
    for (const x of values) await env.DB.prepare('INSERT INTO reals (x) VALUES (?1)').bind(x).run()
    await runCron(BACKUP_CRON, sunday)

    await restoreInto(restoreTarget, 'backups/2026-10-12')

    const restored = (await restoreTarget.prepare('SELECT x FROM reals ORDER BY id').all<{ x: number }>()).results.map((r) => r.x)
    expect(restored).toEqual(values)
  })

  it('refuses a part that was changed after it was written', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    await runCron(BACKUP_CRON, sunday)
    const part = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'settings')!.parts[0]!
    const original = new TextDecoder().decode(await partBytes(part.key))

    const tampered = new TextEncoder().encode(original.replace('Fern', 'Fexn'))

    await expect(checkPart(part, tampered)).rejects.toBeInstanceOf(BackupFormatError)
    await expect(checkPart(part, tampered)).rejects.toThrow(/^(?!.*(Fern|Fexn))/)
  })

  it('refuses a number too large to restore exactly', () => {
    const table = { name: 't', createSql: '', columns: ['n'], rows: 1, parts: [] }

    expect(() => insertStatements(table, '{"n":9007199254740993}\n', 'p')).toThrow(BackupFormatError)
  })

  it('refuses a manifest whose part keys leave the backup it names', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    await runCron(BACKUP_CRON, sunday)
    const manifest = await readManifest('backups/2026-10-12')
    const withKey = (key: string) => {
      const copy = structuredClone(manifest)
      copy.tables[0]!.parts = [{ ...copy.tables[0]!.parts[0]!, key }]
      return JSON.stringify(copy)
    }
    const text = JSON.stringify(manifest)

    expect(() => parseManifest(text, 'backups/2026-10-12')).not.toThrow()
    expect(() => parseManifest(text, 'backups/2026-10-19')).toThrow(BackupFormatError) // a different backup's manifest
    expect(() => parseManifest(withKey('backups/2026-10-05/settings.000001.ndjson'), 'backups/2026-10-12')).toThrow(BackupFormatError)
    expect(() => parseManifest(withKey('backups/2026-10-12/../2026-10-05/x.ndjson'), 'backups/2026-10-12')).toThrow(BackupFormatError)
    expect(() => parseManifest(withKey('backups/2026-10-12//x.ndjson'), 'backups/2026-10-12')).toThrow(BackupFormatError)
  })
})

describe('loadOrder', () => {
  const table = (name: string) => ({ name, createSql: '', columns: [], rows: 0, parts: [] })
  const names = (tables: ReturnType<typeof table>[], refs: Array<[string, string]>) => loadOrder(tables, refs).map((t) => t.name)

  it('puts a table after the tables it refers to and otherwise keeps the backup order', () => {
    const tables = ['accounts', 'transactions', 'settings', 'categories'].map(table)
    expect(names(tables, [['transactions', 'accounts'], ['transactions', 'categories']])).toEqual(['accounts', 'settings', 'categories', 'transactions'])
  })

  it('ignores a table that refers to itself or to one outside the backup', () => {
    expect(names(['a', 'b'].map(table), [['a', 'a'], ['a', 'elsewhere']])).toEqual(['a', 'b'])
  })

  it('refuses tables that refer to each other', () => {
    expect(() => loadOrder(['a', 'b'].map(table), [['a', 'b'], ['b', 'a']])).toThrow(BackupFormatError)
  })
})
