import type { Member } from './auth'

export type ChangeLogRow = {
  id: number
  /** UTC time, ISO 8601. */
  at: string
  /** Email of the Admin who made the change. */
  actor: string
  summary: string
  /** JSON text. */
  before: string | null
  after: string | null
}

export type ChangeEntry = {
  /** The Member making the change; their email is recorded. */
  actor: Member
  summary: string
  before?: unknown
  after?: unknown
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))

/**
 * Runs the mutation and writes its Change Log entry in one D1 batch, which is atomic:
 * if the mutation fails there is no entry, and if the entry fails the mutation is rolled back.
 * Every Admin change goes through this, so the Change Log can't miss one.
 * Returns the mutation statements' results (not the entry's), for callers that need row counts or new IDs.
 */
export async function recordChange(db: D1Database, mutation: D1PreparedStatement | D1PreparedStatement[], entry: ChangeEntry): Promise<D1Result[]> {
  const statements = Array.isArray(mutation) ? mutation : [mutation]
  const log = db
    .prepare('INSERT INTO change_log (actor, summary, before, after) VALUES (?, ?, ?, ?)')
    .bind(entry.actor.email, entry.summary, json(entry.before), json(entry.after))
  return (await db.batch([...statements, log])).slice(0, statements.length)
}
