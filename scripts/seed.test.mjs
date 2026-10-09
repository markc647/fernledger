import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { seedFiles } from './seed.mjs'

const dirs = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const seedDirWith = (...names) => {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-seed-'))
  dirs.push(dir)
  for (const name of names) writeFileSync(join(dir, name), '-- made up\n')
  return dir
}

test('seed files run in filename order, so a ticket numbers its file after the tables it needs', () => {
  const dir = seedDirWith('10-transactions.sql', '02-accounts.sql', '03-categories.sql')
  assert.deepEqual(seedFiles(dir), ['02-accounts.sql', '03-categories.sql', '10-transactions.sql'])
})

test('only .sql files are seed files', () => {
  assert.deepEqual(seedFiles(seedDirWith('01-a.sql', 'notes.txt', '.gitkeep')), ['01-a.sql'])
})

test('no seed directory yet means nothing to load, not an error', () => {
  assert.deepEqual(seedFiles(join(seedDirWith(), 'missing')), [])
})
