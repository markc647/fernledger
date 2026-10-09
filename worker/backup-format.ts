// The backup file format, shared by the Worker (which writes it) and scripts/restore.mjs (which reads it),
// so the format has one home. Pure functions, no bindings. Node runs this file directly for the script,
// so it uses the global Web Crypto and stays within erasable TypeScript.
import { z } from 'zod/mini'

const part = z.object({ key: z.string(), rows: z.int(), bytes: z.int(), sha256: z.string() })
const table = z.object({
  name: z.string().check(z.minLength(1)),
  /** The table's CREATE statement, for reference when reading a backup by hand. */
  createSql: z.string(),
  columns: z.array(z.string()),
  rows: z.int(),
  parts: z.array(part),
})
const manifest = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  prefix: z.string(),
  /** Names of the migrations the database had applied, so a restore target can be checked against them. */
  migrations: z.array(z.string()),
  tables: z.array(table),
})

export type ManifestPart = z.infer<typeof part>
export type ManifestTable = z.infer<typeof table>
export type Manifest = z.infer<typeof manifest>

/** A backup that can't be trusted or read. Messages name a table, part, line number or count, never a value. */
export class BackupFormatError extends Error {}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseManifest(text: string): Manifest {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BackupFormatError('The manifest is not valid JSON.')
  }
  const result = manifest.safeParse(json)
  if (!result.success) throw new BackupFormatError('The manifest is not in a format this version can read.')
  for (const t of result.data.tables) {
    const total = t.parts.reduce((sum, p) => sum + p.rows, 0)
    if (total !== t.rows) throw new BackupFormatError(`The manifest's row counts for table ${t.name} don't add up.`)
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

type Cell = string | number | null | { $blob: string }

// A SQL string literal with no raw line breaks in it: D1's local runner can read a file one line per
// statement, so a Transaction note containing a newline must not split an INSERT.
function textLiteral(value: string): string {
  const pieces = value.split(/(\r|\n)/).filter((piece) => piece !== '')
  if (pieces.length === 0) return "''"
  return pieces.map((piece) => (piece === '\n' ? 'char(10)' : piece === '\r' ? 'char(13)' : `'${piece.replaceAll("'", "''")}'`)).join(' || ')
}

function literal(value: Cell | undefined, where: string): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return textLiteral(value)
  if (typeof value === 'number') {
    // A whole number past 2^53 has already lost digits in JSON.parse. Refuse rather than restore a wrong amount.
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new BackupFormatError(`${where} has a whole number too large to restore exactly.`)
    return String(value)
  }
  if (value && typeof value === 'object' && typeof value.$blob === 'string' && /^[0-9A-Fa-f]*$/.test(value.$blob)) return `X'${value.$blob}'`
  throw new BackupFormatError(`${where} has a value of a kind a backup never contains.`)
}

/** One INSERT per row (D1 limits a statement to 100 KB and the bound parameters of one to 100). */
export function insertStatements(entry: ManifestTable, ndjson: string, partKey: string): string[] {
  const columns = entry.columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(', ')
  return lines(ndjson).map((line, i) => {
    const where = `Part ${partKey} line ${i + 1}`
    let row: Record<string, Cell>
    try {
      row = JSON.parse(line)
    } catch {
      throw new BackupFormatError(`${where} is not valid JSON.`)
    }
    const values = entry.columns.map((c) => {
      if (!Object.hasOwn(row, c)) throw new BackupFormatError(`${where} is missing column ${c}.`)
      return literal(row[c], where)
    })
    return `INSERT INTO "${entry.name.replaceAll('"', '""')}" (${columns}) VALUES (${values.join(', ')});`
  })
}
