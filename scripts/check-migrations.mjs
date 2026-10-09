// Usage: node scripts/check-migrations.mjs [dir]   (default: migrations/ at the repo root)
// Enforces ADR 0009 and the naming convention in CODING_STANDARDS.md:
//   - files are named <ticket number x 100 + n>_<name>.sql, n from 01 to 99 (ticket 8 -> 0801_...)
//   - no two files share a prefix, so parallel tickets can't collide
//   - nothing non-additive: no DROP (table, index, column) and no RENAME
// Exits 0 when clean, 1 with one line per problem.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = /^(\d{4,})_[a-z0-9][a-z0-9_]*\.sql$/
const NON_ADDITIVE = /\b(DROP|RENAME)\b/i

/** Blanks out comments and string literals, keeping line breaks, so keywords inside them don't count. */
const blank = (text) => text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => m.replace(/[^\n]/g, ' '))

/** Returns a list of problems, empty when the migrations are fine. */
export function checkMigrations(dir) {
  if (!existsSync(dir)) return []
  const problems = []
  const byPrefix = new Map()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const match = NAME.exec(file)
    const prefix = match && Number(match[1])
    if (!match || prefix % 100 === 0) {
      problems.push(`${file}: bad name, expected <ticket number x 100 + n>_<name>.sql with n from 01 to 99 and a lower-case name`)
    } else {
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file])
    }
    const lines = blank(readFileSync(resolve(dir, file), 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const found = NON_ADDITIVE.exec(line)
      if (found) problems.push(`${file}:${i + 1}: ${found[1].toUpperCase()} is not additive (ADR 0009); drop or rename in a later release`)
    })
  }
  for (const [prefix, files] of byPrefix) {
    if (files.length > 1) problems.push(`duplicate prefix ${String(prefix).padStart(4, '0')}: ${files.join(', ')}`)
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../migrations', import.meta.url)))
  const problems = checkMigrations(dir)
  for (const problem of problems) console.error(problem)
  process.exitCode = problems.length ? 1 : 0
}
