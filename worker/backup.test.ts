import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_CRON } from './backup'
import { BackupFormatError, checkPart, insertStatements, parseManifest, type Manifest } from './backup-format'
import worker from './index'

// Seam 1: a scheduled event into the Worker, with the real local D1 and R2 from wrangler.jsonc.
const sunday = new Date('2026-10-11T15:00:00Z') // 04:00 Monday 12 Oct in NZ (NZDT)
const daily = '0 18 * * *'
const restoreTarget = (env as unknown as { RESTORE_TARGET: D1Database }).RESTORE_TARGET

async function runCron(cron: string, scheduledTime: Date, bindings: Env = env) {
  await worker.scheduled(createScheduledController({ cron, scheduledTime }), bindings)
}

async function readManifest(prefix: string): Promise<Manifest> {
  const object = await env.BACKUPS.get(`${prefix}/manifest.json`)
  expect(object, `no manifest under ${prefix}`).not.toBeNull()
  return parseManifest(await object!.text())
}

const partBytes = async (key: string) => new Uint8Array(await (await env.BACKUPS.get(key))!.arrayBuffer())

// Wraps the bindings and counts every D1 query and R2 call, which the free plan limits to 50 each per invocation.
function counted() {
  const ops = { d1: 0, r2: 0, deletes: 0 }
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
        return value.apply(target, args)
      }
    },
  })
  return { ops, bindings: { ...env, DB, BACKUPS } as Env }
}

const tableNames = async (db: D1Database = env.DB) =>
  (
    await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>()
  ).results.map((t) => t.name)

// Each test starts from the migrated schema with no rows, no extra tables and an empty bucket.
const reset = async (db: D1Database) => {
  for (const name of await tableNames(db)) {
    if (name === 'settings' || name === 'change_log') await db.prepare(`DELETE FROM "${name}"`).run()
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
    const rows = new TextDecoder().decode(bytes).trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(rows).toMatchObject([{ id: 1, summary: 'Line one\nO\'Brien "quoted"', after: null }, { id: 2, summary: 'Second' }])
  })

  it('keeps every earlier backup and deletes nothing', async () => {
    const { ops, bindings } = counted()
    await runCron(BACKUP_CRON, sunday, bindings)
    await runCron(BACKUP_CRON, new Date('2026-10-18T15:00:00Z'), bindings)

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

  it('is split over invocations that each stay inside the free-plan limits, and loses no rows', async () => {
    const total = 30_000
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${total})
       INSERT INTO change_log (actor, summary) SELECT 'a@example.com', 'Change ' || i FROM n`,
    ).run()

    const invocations: { d1: number; r2: number }[] = []
    const invoke = async (cron: string, time: Date) => {
      const { ops, bindings } = counted()
      await runCron(cron, time, bindings)
      invocations.push({ d1: ops.d1, r2: ops.r2 })
    }
    await invoke(BACKUP_CRON, sunday)
    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json'), 'one invocation cannot finish 30,000 rows').toBeNull()
    for (let day = 0; day < 5 && !(await env.BACKUPS.head('backups/2026-10-12/manifest.json')); day++) {
      await invoke(daily, new Date(`2026-10-1${2 + day}T18:00:00Z`))
    }

    for (const { d1, r2 } of invocations) {
      expect(d1).toBeLessThanOrEqual(50)
      expect(r2).toBeLessThanOrEqual(50)
    }
    const log = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'change_log')!
    expect(log.rows).toBe(total)
    expect(log.parts.length).toBeGreaterThan(1)
    const ids = new Set<number>()
    for (const part of log.parts) {
      await checkPart(part, await partBytes(part.key))
      for (const line of new TextDecoder().decode(await partBytes(part.key)).trimEnd().split('\n')) ids.add(JSON.parse(line).id)
    }
    expect(ids.size).toBe(total)
  }, 60_000)

  it('leaves a resumable run and no manifest when a read fails, and logs only the error class', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    const { bindings } = counted()
    const failing = new Proxy(bindings.DB, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop)
        let reads = 0
        return (query: string) => {
          if (query.includes('group_concat') && ++reads === 1) throw new TypeError('boom zz-secret')
          return target.prepare(query)
        }
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(runCron(BACKUP_CRON, sunday, { ...bindings, DB: failing })).rejects.toThrow()

    expect(await env.BACKUPS.head('backups/2026-10-12/manifest.json')).toBeNull()
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('backup.failed') && l.includes('TypeError'))).toBe(true)
    expect(lines.join('\n')).not.toContain('zz-secret')
    await runCron(daily, new Date('2026-10-12T18:00:00Z')) // the next cron picks the run up
    expect((await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'settings')?.rows).toBe(1)
  })
})

describe('restoring a backup', () => {
  const dump = async (db: D1Database) => {
    const out: Record<string, unknown[]> = {}
    for (const name of await tableNames()) out[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results
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

  it('refuses a part that was changed after it was written', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_title', 'Fern')").run()
    await runCron(BACKUP_CRON, sunday)
    const part = (await readManifest('backups/2026-10-12')).tables.find((t) => t.name === 'settings')!.parts[0]!
    const original = new TextDecoder().decode(await partBytes(part.key))

    const tampered = new TextEncoder().encode(original.replace('Fern', 'Fexn'))

    await expect(checkPart(part, tampered)).rejects.toBeInstanceOf(BackupFormatError)
    await expect(checkPart(part, tampered)).rejects.not.toThrow(/Fern|Fexn/)
  })

  it('refuses a number too large to restore exactly', () => {
    const table = { name: 't', createSql: '', columns: ['n'], rows: 1, parts: [] }

    expect(() => insertStatements(table, '{"n":9007199254740993}\n', 'p')).toThrow(BackupFormatError)
  })
})
