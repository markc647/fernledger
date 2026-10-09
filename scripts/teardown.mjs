// Leaves Fernledger: takes a final export of everything, then deletes the D1 database and R2 bucket, but only
// once you have typed the database name. README: "Leaving Fernledger".
// Usage: node scripts/teardown.mjs [--dry-run] [--yes] [--out FOLDER]
//   --dry-run  prints every step and the commands, and runs nothing
//   --yes      skips the "use this account?" prompt (it does not skip the typed confirmation)
//   --out      where the final export is saved; default: a fernledger-final-export-<date> folder in your home folder.
//              It must be empty or new, and outside this repository, which is public.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { backupPrefix } from '../worker/backup.ts'
import { databaseHasTables, downloadBackup, takeBackup } from './backup-run.mjs'
import { ScriptError, askTyped, bucketExists, confirmAccount, createRunner, databaseExists, main, readResourceNames, root } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const outFlag = args.indexOf('--out')

// Wrangler can list buckets but not the objects in one, and a bucket that still holds objects can't be deleted.
function emptyBucketInstructions(bucket) {
  return [
    `The R2 bucket "${bucket}" still holds backups, so it was not deleted. Wrangler can't list or bulk-delete objects, so empty it yourself, then delete it:`,
    '  A. In the Cloudflare dashboard: R2 > ' + bucket + ' > Objects: select everything and delete it.',
    `  B. Or add a lifecycle rule that expires every object (npx wrangler r2 bucket lifecycle add ${bucket} --help), wait for it to empty the bucket, and remove the rule.`,
    `  Then: npx wrangler r2 bucket delete ${bucket}`,
  ].join('\n')
}

// What the script can't do for you. The Akahu step depends on whether you ever used Akahu Sync (ADR 0008).
function remainingSteps() {
  return [
    '',
    'By hand',
    '  - Delete the Worker, which also deletes the secrets it holds: npx wrangler delete',
    '  - Delete the Access application: Cloudflare Zero Trust > Access > Applications > Fernledger.',
    '  - If you used Akahu Sync: revoke the access you gave Fernledger in your Akahu account (remove the personal',
    '    app Fernledger used, or disconnect the bank connections it syncs), so its tokens stop working. Deleting the',
    '    Worker removes Fernledger\'s copies but does not revoke them. If you only ever used CSV Imports, skip this.',
    '  - Keep or destroy the final export folder as you see fit. It holds every Transaction.',
  ].join('\n')
}

function exportFolder() {
  const date = backupPrefix(Date.now()).slice('backups/'.length)
  const out = resolve(outFlag === -1 ? resolve(homedir(), `fernledger-final-export-${date}`) : args[outFlag + 1] ?? '')
  if (outFlag !== -1 && !args[outFlag + 1]) throw new ScriptError('--out needs a folder.')
  const fromRepo = relative(root, out)
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !isAbsolute(fromRepo))) {
    throw new ScriptError(`The export folder ${out} is inside the repository, which is public. Choose a folder outside it with --out.`)
  }
  if (existsSync(out) && readdirSync(out).length) throw new ScriptError(`The export folder ${out} is not empty. Choose a new folder with --out.`)
  return out
}

await main(async () => {
  const { database, bucket } = readResourceNames()
  const out = exportFolder()
  const accountId = await confirmAccount(createRunner({ dryRun }), { yes: args.includes('--yes') })

  if (dryRun) {
    const runner = createRunner({ dryRun, accountId })
    console.log(`Dry run: in order, a real run would\n  1. take a complete backup of "${database}" with the Worker's backup code and save a checked copy in ${out}\n  2. ask you to type "${database}"\n  3. delete the database and the bucket:`)
    runner.run(['d1', 'delete', database, '--skip-confirmation'])
    runner.run(['r2', 'bucket', 'delete', bucket])
    console.log(remainingSteps())
    console.log('\nDry run only. Nothing was changed.')
    return
  }

  const runner = createRunner({ dryRun, accountId })
  const hasDatabase = databaseExists(runner, database)
  const hasBucket = bucketExists(runner, bucket)
  if (!hasDatabase && !hasBucket) {
    console.log(`Nothing to tear down: there is no D1 database "${database}" or R2 bucket "${bucket}" in this account.`)
    console.log(remainingSteps())
    return
  }

  // 1. The final export. If it can't be made and checked, nothing is deleted.
  if (hasDatabase) {
    try {
      if (!hasBucket) throw new ScriptError(`There is no R2 bucket "${bucket}" to hold an export.`)
      if (databaseHasTables(runner, database)) {
        const { prefix } = await takeBackup(runner, { database, bucket })
        await downloadBackup(runner, { bucket, prefix, outDir: out })
        console.log(`\nFinal export saved in ${out}: manifest.json plus one .ndjson file per table (one JSON row per line). Keep it somewhere private.`)
      } else {
        console.log(`D1 database "${database}" has no tables, so there is nothing to export.`)
      }
    } catch (e) {
      if (!(e instanceof ScriptError)) throw e
      throw new ScriptError(
        [
          `The final export could not be made: ${e.message}`,
          'Nothing was deleted.',
          `To leave without it, make a copy by hand (npx wrangler d1 export ${database} --remote --output <file>.sql), then delete with npx wrangler d1 delete ${database} and the steps below.`,
        ].join('\n'),
      )
    }
  } else {
    console.log(`D1 database "${database}" is already gone, so there is nothing to export.`)
  }

  // 2. The typed confirmation.
  console.log(`\nThis permanently deletes${hasDatabase ? ` the D1 database "${database}"` : ''}${hasDatabase && hasBucket ? ' and' : ''}${hasBucket ? ` the R2 bucket "${bucket}"` : ''}, with every backup in it. It cannot be undone.`)
  if (!(await askTyped(`Type the database name (${database}) to delete: `, database))) {
    throw new ScriptError('Not confirmed. Nothing was deleted.')
  }

  // 3. The deletes.
  if (hasDatabase) runner.run(['d1', 'delete', database, '--skip-confirmation']) // Wrangler answers its own prompt in CI mode, so the typed name above is the safeguard
  if (hasBucket) {
    const r = runner.run(['r2', 'bucket', 'delete', bucket], { allowFailure: true })
    if (r.status !== 0) {
      if (!/10008|not empty/i.test(r.stdout + r.stderr)) throw new ScriptError(`\`wrangler r2 bucket delete\` failed (exit ${r.status}). Run the command printed above by hand to see Wrangler's own message.`)
      console.log(`\n${hasDatabase ? `The D1 database "${database}" is deleted. ` : ''}${emptyBucketInstructions(bucket)}`)
      console.log(remainingSteps())
      process.exitCode = 1
      return
    }
  }
  console.log('\nDeleted. Fernledger\'s data is gone from your Cloudflare account.')
  console.log(remainingSteps())
})
