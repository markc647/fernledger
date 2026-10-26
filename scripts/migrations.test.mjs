// Run with `npm run test:scripts`. Covers scripts/check-migrations.mjs, which enforces ADR 0009 and the
// naming convention in CODING_STANDARDS.md.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { checkMigrations } from './check-migrations.mjs'

const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function migrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-migrations-'))
  dirs.push(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

const ok = 'CREATE TABLE t (id INTEGER PRIMARY KEY);\n'

test('accepts additive migrations with distinct prefixes', () => {
  const dir = migrations({
    '0201_first.sql': ok,
    '0202_second.sql': 'ALTER TABLE t ADD COLUMN note TEXT;\nCREATE INDEX t_note ON t (note);\n',
    '0801_other_ticket.sql': ok,
  })
  assert.deepEqual(checkMigrations(dir), [])
})

test('passes when there is no migrations directory yet', () => {
  assert.deepEqual(checkMigrations(join(tmpdir(), 'fernledger-no-such-dir')), [])
})

test('fails on a duplicate prefix', () => {
  const dir = migrations({ '0201_a.sql': ok, '0201_b.sql': ok })
  const problems = checkMigrations(dir)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /duplicate prefix 0201.*0201_a\.sql.*0201_b\.sql/)
})

test('treats prefixes as numbers, so 0201 and 00201 collide', () => {
  const dir = migrations({ '0201_a.sql': ok, '00201_b.sql': ok })
  assert.match(checkMigrations(dir).join('\n'), /duplicate prefix/)
})

for (const [label, sql] of [
  ['DROP TABLE', 'DROP TABLE t;'],
  ['DROP INDEX', 'drop index if exists t_note;'],
  ['DROP COLUMN', 'ALTER TABLE t DROP COLUMN note;'],
  ['RENAME TABLE', 'ALTER TABLE t RENAME TO u;'],
  ['RENAME COLUMN', 'ALTER TABLE t RENAME COLUMN a TO b;'],
  ['a statement after harmless ones', `${ok}\n-- fine so far\nDROP\n  TABLE t;`],
]) {
  test(`fails on ${label}`, () => {
    const problems = checkMigrations(migrations({ '0201_bad.sql': sql }))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /0201_bad\.sql:\d+: .*(DROP|RENAME)/i)
  })
}

test('reports the line of the offending statement', () => {
  const problems = checkMigrations(migrations({ '0201_bad.sql': `${ok}\n\nDROP TABLE t;\n` }))
  assert.match(problems[0], /0201_bad\.sql:4:/)
})

test('ignores DROP and RENAME in comments and string literals', () => {
  const sql = `-- never DROP anything\n/* RENAME is not allowed */\nINSERT INTO t (note) VALUES ('DROP TABLE t; RENAME');\n`
  assert.deepEqual(checkMigrations(migrations({ '0201_ok.sql': sql })), [])
})

for (const name of ['201_short.sql', 'settings.sql', '0201-settings.sql', '0201_Settings.sql', '0200_zero.sql']) {
  test(`fails on a file named ${name}`, () => {
    const problems = checkMigrations(migrations({ [name]: ok }))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /name/)
  })
}

test('the CLI exits 1 on a problem and 0 when clean, naming the file', () => {
  const run = (dir) => spawnSync(process.execPath, [resolve('scripts/check-migrations.mjs'), dir], { encoding: 'utf8' })
  const clean = run(migrations({ '0201_a.sql': ok }))
  assert.equal(clean.status, 0)
  const bad = run(migrations({ '0201_a.sql': 'DROP TABLE t;' }))
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /0201_a\.sql/)
})

test('the real migrations directory is clean', () => {
  assert.deepEqual(checkMigrations(resolve('migrations')), [])
})
