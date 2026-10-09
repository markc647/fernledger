// The backup file format, shared by the Worker (which writes it) and scripts/restore.mjs (which reads it),
// so the format has one home. Pure functions, no bindings. Node runs this file directly for the script,
// so it uses the global Web Crypto and stays within erasable TypeScript.
import { z } from 'zod/mini'

/** An identifier quoted for SQL: "name", with any quote inside it doubled. */
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

const part = z.object({ key: z.string(), rows: z.int(), bytes: z.int(), sha256: z.string() })
export const tableSchema = z.object({
  name: z.string().check(z.minLength(1)),
  /** The table's CREATE statement, for reference when reading a backup by hand. */
  createSql: z.string(),
  columns: z.array(z.string()),
  rows: z.int(),
  parts: z.array(part),
})
const skippedTable = z.object({ name: z.string(), reason: z.string() })
const manifest = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  prefix: z.string(),
  /** Names of the migrations the database had applied when the backup was made, for whoever reads it. */
  migrations: z.array(z.string()),
  tables: z.array(tableSchema),
  /** Tables that were not copied, and why. A restore must not be mistaken for a complete copy of these. */
  skipped: z.array(skippedTable),
  /** The prefix of the run this one replaced when that never finished. */
  previousIncomplete: z.optional(z.string()),
})

export type ManifestPart = z.infer<typeof part>
export type ManifestTable = z.infer<typeof tableSchema>
export type SkippedTable = z.infer<typeof skippedTable>
export type Manifest = z.infer<typeof manifest>

/** A backup that can't be trusted or read. Messages name a table, part, line number or count, never a value. */
export class BackupFormatError extends Error {}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads a manifest. With `expectedPrefix` (the backup the caller asked for) it also refuses a manifest that
 * names a different backup, or any part key outside that prefix, so a doctored manifest can't make a restore
 * read some other object in the bucket.
 */
export function parseManifest(text: string, expectedPrefix?: string): Manifest {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BackupFormatError('The manifest is not valid JSON.')
  }
  const result = manifest.safeParse(json)
  if (!result.success) throw new BackupFormatError('The manifest is not in a format this version can read.')
  if (expectedPrefix !== undefined && result.data.prefix !== expectedPrefix) throw new BackupFormatError('The manifest belongs to a different backup.')
  for (const t of result.data.tables) {
    const total = t.parts.reduce((sum, p) => sum + p.rows, 0)
    if (total !== t.rows) throw new BackupFormatError(`The manifest's row counts for table ${t.name} don't add up.`)
    if (expectedPrefix === undefined) continue
    for (const p of t.parts) {
      const rest = p.key.slice(expectedPrefix.length + 1)
      const confined = p.key.startsWith(`${expectedPrefix}/`) && rest !== '' && rest.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
      if (!confined || p.key.includes('\\')) throw new BackupFormatError(`Part ${p.key} of table ${t.name} is outside the backup.`)
    }
  }
  return result.data
}

/** Checks a part's bytes against the manifest's size and checksum, and its line count against its row count. */
export async function checkPart(entry: ManifestPart, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== entry.bytes) throw new BackupFormatError(`Part ${entry.key} has the wrong size.`)
  if ((await sha256Hex(bytes)) !== entry.sha256) throw new BackupFormatError(`Part ${entry.key} fails its checksum.`)
  if (lines(new TextDecoder().decode(bytes)).length !== entry.rows) throw new BackupFormatError(`Part ${entry.key} has the wrong number of rows.`)
}

const lines = (ndjson: string) => ndjson.split('\n').filter((line) => line !== '')

type Cell = string | null | { $number: string } | { $blob: string }

// A SQL string literal with no raw line breaks in it: D1's local runner can read a file one line per
// statement, so a Transaction note containing a newline must not split an INSERT.
function textLiteral(value: string): string {
  const pieces = value.split(/(\r|\n)/).filter((piece) => piece !== '')
  if (pieces.length === 0) return "''"
  return pieces.map((piece) => (piece === '\n' ? 'char(10)' : piece === '\r' ? 'char(13)' : `'${piece.replaceAll("'", "''")}'`)).join(' || ')
}

const NUMBER_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/

function literal(value: Cell | undefined, where: string): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return textLiteral(value)
  if (value && typeof value === 'object' && '$number' in value) {
    // The number as the backup wrote it, so a REAL keeps all its digits and its decimal point. Only a whole
    // number needs a check: past 2^53 it can't be told from the neighbouring ones, so refuse it.
    const text = value.$number
    if (!NUMBER_TEXT.test(text)) throw new BackupFormatError(`${where} has a number that isn't one.`)
    if (/^-?\d+$/.test(text) && !Number.isSafeInteger(Number(text))) throw new BackupFormatError(`${where} has a whole number too large to restore exactly.`)
    return text
  }
  if (value && typeof value === 'object' && '$blob' in value && typeof value.$blob === 'string' && /^[0-9A-Fa-f]*$/.test(value.$blob)) return `X'${value.$blob}'`
  throw new BackupFormatError(`${where} has a value of a kind a backup never contains.`)
}

// Keeps each number's source text, which JSON.parse would otherwise round to a double.
const keepNumberText = (_key: string, value: unknown, context?: { source?: string }) =>
  typeof value === 'number' ? { $number: context?.source ?? String(value) } : value

/** One INSERT per row (D1 limits a statement to 100 KB and the bound parameters of one to 100). */
export function insertStatements(entry: ManifestTable, ndjson: string, partKey: string): string[] {
  const columns = entry.columns.map(quote).join(', ')
  return lines(ndjson).map((line, i) => {
    const where = `Part ${partKey} line ${i + 1}`
    let row: Record<string, Cell>
    try {
      row = JSON.parse(line, keepNumberText)
    } catch {
      throw new BackupFormatError(`${where} is not valid JSON.`)
    }
    const values = entry.columns.map((c) => {
      if (!Object.hasOwn(row, c)) throw new BackupFormatError(`${where} is missing column ${c}.`)
      return literal(row[c], where)
    })
    return `INSERT INTO ${quote(entry.name)} (${columns}) VALUES (${values.join(', ')});`
  })
}

/**
 * The order to load a backup's tables in: a table comes after every table it has a foreign key to, so no row
 * is inserted before the row it refers to. `references` are [table, referenced table] pairs read from the
 * database being restored into, because that database is the one enforcing the keys. Tables with no
 * dependency between them keep the manifest's order. Pairs that name a table outside the backup, and a
 * table's reference to itself, are ignored.
 */
export function loadOrder(tables: ManifestTable[], references: Array<[string, string]>): ManifestTable[] {
  const byName = new Map(tables.map((t) => [t.name, t]))
  const needs = new Map<string, Set<string>>(tables.map((t) => [t.name, new Set()]))
  for (const [table, referenced] of references) {
    if (table !== referenced && byName.has(table) && byName.has(referenced)) needs.get(table)!.add(referenced)
  }
  const ordered: ManifestTable[] = []
  const placed = new Set<string>()
  while (ordered.length < tables.length) {
    const next = tables.find((t) => !placed.has(t.name) && [...needs.get(t.name)!].every((n) => placed.has(n)))
    if (!next) {
      const stuck = tables.filter((t) => !placed.has(t.name)).map((t) => t.name)
      throw new BackupFormatError(`Tables ${stuck.join(', ')} refer to each other, so there is no order to load them in.`)
    }
    placed.add(next.name)
    ordered.push(next)
  }
  return ordered
}
