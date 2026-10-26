// Practises a restore on your Cloudflare account with the text a restore is likeliest to get wrong (docs/setup.md, "Restore practice
// run"). Everything it uses is its own and goes again at the end: two throwaway D1 databases and a throwaway R2 bucket. It never reads
// or writes the live database or the backup bucket: a backup run keeps its state in the bucket (backups/run-state.json), and the Worker's
// crons carry on whatever run that file names, so a practice backup in the live bucket could end up copying the live database.
//   1. creates the D1 databases fernledger-practice-source and fernledger-practice and the R2 bucket fernledger-practice, and applies the
//      migrations to both databases
//   2. writes made-up rows (bank code 99) into the source: Settings, an Account and Transactions holding scripts/hard-text.mjs's text,
//      written as hex so Wrangler's rewriting of a --file can't reach it, and checks the text arrived as written
//   3. backs the source up into the practice bucket with the Worker's backup code (scripts/backup-run.mjs), as a deploy does
//   4. restores that backup into fernledger-practice with scripts/restore.mjs, as you would after losing the database
//   5. compares every row, value and type of the two databases
//   6. deletes the bucket's objects, the bucket and both databases, whether the practice passed or not
// Usage: node scripts/restore-practice.mjs [--dry-run] [--yes]
//   --dry-run  prints what a real run would create, run and delete, and runs none of it
//   --yes      skips the account and go-ahead prompts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { toHex } from '../worker/backup-format.ts'
import { BACKUP_STATE_KEY } from '../worker/backup.ts'
import { takeBackup } from './backup-run.mjs'
import { HARD_TEXTS } from './hard-text.mjs'
import { ScriptError, askYesNo, bucketExists, confirmAccount, createRunner, databaseExists, main, readResourceNames, regionFromEnv, root } from './wrangler-cli.mjs'

const SOURCE = 'fernledger-practice-source'
const TARGET = 'fernledger-practice'
const BUCKET = 'fernledger-practice'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const yes = args.includes('--yes')

// Text as hex: Wrangler can rewrite a --file's text before D1 sees it, but not the inside of X'...'.
const text = (s) => `CAST(X'${toHex(new TextEncoder().encode(s))}' AS TEXT)`

const SEED = [
  ...HARD_TEXTS.map((s, i) => `INSERT INTO settings (key, value) VALUES ('practice ${String(i).padStart(2, '0')}', ${text(s)});`),
  `INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-97', 'Practice');`,
  ...HARD_TEXTS.map((s, i) => `INSERT INTO transactions (account_id, date, amount_cents, description, bank_memo, source, note) VALUES (1, '2026-10-01', ${-(i + 1) * 100}, ${text(s)}, ${text(s)}, 'import', ${text(s)});`),
].join('\n') + '\n'

// What the two databases must agree on: every row of the tables the seed wrote, and the type of every text that came from HARD_TEXTS.
const COMPARED = {
  settings: "SELECT key, value, typeof(value) AS value_type FROM settings WHERE key LIKE 'practice %' ORDER BY key",
  accounts: 'SELECT * FROM accounts ORDER BY id',
  transactions: 'SELECT *, typeof(description) AS description_type, typeof(bank_memo) AS bank_memo_type, typeof(note) AS note_type FROM transactions ORDER BY id',
}

await main(async () => {
  const region = regionFromEnv()
  const { migrationsDir } = readResourceNames()
  const migrations = readdirSync(resolve(root, migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  if (dryRun) {
    console.log(`Dry run: in order, a real run would
  1. ask you to confirm the Cloudflare account, then create the D1 databases ${SOURCE} and ${TARGET} and the R2 bucket ${BUCKET} (location ${region}), stopping if any already exists
  2. apply the ${migrations.length} migrations to both databases, and write ${HARD_TEXTS.length} Settings and ${HARD_TEXTS.length} Transactions of made-up hard text into ${SOURCE}
  3. back ${SOURCE} up into ${BUCKET} with the Worker's backup code
  4. restore that backup into ${TARGET} with scripts/restore.mjs
  5. compare every row, value and type of the two databases
  6. delete the bucket's objects, the bucket and both databases
It never reads or writes the live database or the backup bucket.

Dry run only. Nothing was changed.`)
    return
  }

  const accountId = await confirmAccount(createRunner({ dryRun: false }), { yes })
  const runner = createRunner({ dryRun: false, accountId })
  const rows = (database, sql) => {
    const result = runner.json(['d1', 'execute', database, '--remote', '--json', '--command', sql], { quiet: true })
    return Array.isArray(result) ? (result[0]?.results ?? []) : []
  }

  const leftOver = [SOURCE, TARGET].filter((name) => databaseExists(runner, name))
  if (bucketExists(runner, BUCKET)) leftOver.push(`the bucket ${BUCKET}`)
  if (leftOver.length) {
    throw new ScriptError(`Left from a practice run that didn't finish: ${leftOver.join(', ')}. Delete them in the Cloudflare dashboard, then run this again. Nothing was changed.`)
  }
  const go = `Create ${SOURCE}, ${TARGET} and the bucket ${BUCKET}, practise a restore, and delete them all again?`
  if (!yes && !(await askYesNo(go, 'Not confirmed: re-run with --yes to proceed without a prompt.'))) throw new ScriptError('Cancelled. Nothing was changed.')

  const made = { databases: [], bucket: false, keys: [] }
  const work = mkdtempSync(join(tmpdir(), 'fernledger-practice-'))
  try {
    for (const name of [SOURCE, TARGET]) {
      runner.run(['d1', 'create', name, '--location', region])
      made.databases.push(name)
    }
    runner.run(['r2', 'bucket', 'create', BUCKET, '--location', region])
    made.bucket = true
    for (const name of [SOURCE, TARGET]) {
      console.log(`Applying ${migrations.length} migrations to ${name}`)
      for (const file of migrations) runner.run(['d1', 'execute', name, '--remote', '--file', resolve(root, migrationsDir, file)], { quiet: true })
    }
    const seedFile = join(work, 'seed.sql')
    writeFileSync(seedFile, SEED)
    runner.run(['d1', 'execute', SOURCE, '--remote', '--file', seedFile], { note: 'made-up rows of hard text' })
    const written = rows(SOURCE, COMPARED.settings)
    if (written.length !== HARD_TEXTS.length || written.some((r, i) => r.value !== HARD_TEXTS[i] || r.value_type !== 'text')) {
      throw new ScriptError(`The made-up text didn't reach ${SOURCE} as written, so there is nothing fair to restore. The practice failed before the backup.`)
    }

    // The run state is the first thing a backup writes, so it is cleared up even when the backup stops partway.
    made.keys.push(BACKUP_STATE_KEY)
    const { prefix, manifest } = await takeBackup(runner, { database: SOURCE, bucket: BUCKET, fresh: true })
    made.keys.push(`${prefix}/manifest.json`, ...manifest.tables.flatMap((t) => t.parts.map((p) => p.key)))

    const restore = spawnSync(process.execPath, [resolve(root, 'scripts/restore.mjs'), prefix.slice('backups/'.length), '--database', TARGET, '--bucket', BUCKET, '--yes'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    })
    if (restore.status !== 0) throw new ScriptError(`The restore into ${TARGET} failed (exit ${restore.status}). Its message is above.`)

    const different = Object.entries(COMPARED)
      .filter(([, sql]) => JSON.stringify(rows(SOURCE, sql)) !== JSON.stringify(rows(TARGET, sql)))
      .map(([table]) => table)
    if (different.length) throw new ScriptError(`The restore changed what it loaded: ${different.join(', ')} in ${TARGET} differ from ${SOURCE}. Treat your backups as unproven.`)
    console.log(`\nPractice restore passed: every row, value and type of ${Object.keys(COMPARED).join(', ')} came back as backed up.`)
  } finally {
    rmSync(work, { recursive: true, force: true })
    console.log('\nCleaning up')
    const failed = []
    for (const key of made.keys) {
      if (runner.run(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'], { allowFailure: true, quiet: true }).status !== 0) failed.push(`${BUCKET}/${key}`)
    }
    if (made.bucket && runner.run(['r2', 'bucket', 'delete', BUCKET], { allowFailure: true }).status !== 0) failed.push(`the bucket ${BUCKET} (empty it first if it holds objects)`)
    for (const name of made.databases) {
      if (runner.run(['d1', 'delete', name, '--skip-confirmation'], { allowFailure: true }).status !== 0) failed.push(`the D1 database ${name}`)
    }
    console.log(failed.length ? `Not deleted, so delete by hand in the Cloudflare dashboard: ${failed.join('; ')}. They hold only made-up rows.` : 'Deleted both databases and the bucket.')
  }
})
