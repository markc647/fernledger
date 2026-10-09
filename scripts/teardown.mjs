// Leaves Fernledger: takes a final backup of everything and downloads it, deletes the D1 database once you have
// typed its name, then tries to delete the R2 bucket. README: "Leaving Fernledger".
// Usage: node scripts/teardown.mjs [--dry-run] [--yes] [--out FOLDER]
//   --dry-run  prints every step and the commands, and runs nothing
//   --yes      skips the "use this account?" prompt (it does not skip the typed confirmation)
//   --out      where the final backup is saved; default: a fernledger-final-backup-<date> folder in your home folder.
//              It must be empty or new, and outside this repository, which is public.
//
// The bucket is the one step left to you. Wrangler can't list or bulk-delete a bucket's objects, and a bucket
// that holds any can't be deleted, so the script prints how to empty it and exits 0: that is the normal end.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { backupPrefix } from '../worker/backup.ts'
import { databaseHasTables, downloadBackup, liveDifferences, takeBackup } from './backup-run.mjs'
import { ScriptError, askTyped, bucketExists, confirmAccount, createRunner, databaseExists, main, readResourceNames, root } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const outFlag = args.indexOf('--out')

// Emptying the bucket destroys every backup in it, not just the final one, so the warning comes with the how.
function emptyBucketInstructions(bucket) {
  return [
    `Last step, by hand: the R2 bucket "${bucket}" still holds backups, so it was not deleted. Wrangler can't list or bulk-delete objects.`,
    'Emptying the bucket destroys every backup in it, including the weekly ones. Download anything you want to keep first',
    `(Cloudflare dashboard > R2 > ${bucket} > Objects). The final backup you just downloaded is only the latest data.`,
    '  A. In the dashboard: select everything and delete it.',
    `  B. Or add a lifecycle rule that expires every object (npx wrangler r2 bucket lifecycle add ${bucket} --help), wait for it to empty the bucket, and remove the rule.`,
    `  Then delete the bucket: npx wrangler r2 bucket delete ${bucket}  (or re-run npm run teardown, which finishes the job)`,
  ].join('\n')
}

// What the script can't do for you. The Akahu step depends on whether you ever used Akahu Sync (ADR 0008).
function remainingSteps() {
  return [
    '',
    'By hand',
    '  - Delete the Worker, which also deletes the secrets it holds: npx wrangler delete',
    '  - Delete the Access application: Cloudflare Zero Trust > Access > Applications > Fernledger.',
    '  - If you used Akahu Sync, revoke Fernledger\'s access in your Akahu account (README: "Leaving Fernledger"). With CSV Imports only, skip this.',
    '  - Keep or destroy the final backup folder as you see fit. It holds every Transaction.',
  ].join('\n')
}

function exportFolder() {
  const date = backupPrefix(Date.now()).slice('backups/'.length)
  let out = resolve(homedir(), `fernledger-final-backup-${date}`)
  if (outFlag !== -1) {
    const value = args[outFlag + 1]
    if (!value || value.startsWith('--')) throw new ScriptError('--out needs a folder.')
    out = resolve(value)
  }
  const fromRepo = relative(root, out)
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !isAbsolute(fromRepo))) {
    throw new ScriptError(`The final backup folder ${out} is inside the repository, which is public. Choose a folder outside it with --out.`)
  }
  return out
}

// Checked only when a backup is about to be saved: a re-run that finishes the bucket step needs no folder.
function requireEmptyFolder(out) {
  if (existsSync(out) && readdirSync(out).length) throw new ScriptError(`The final backup folder ${out} is not empty. Choose a new folder with --out.`)
}

await main(async () => {
  const { database, bucket } = readResourceNames()
  const out = exportFolder()
  const accountId = await confirmAccount(createRunner({ dryRun }), { yes: args.includes('--yes') })

  if (dryRun) {
    requireEmptyFolder(out)
    const runner = createRunner({ dryRun, accountId })
    console.log(`Dry run: in order, a real run would\n  1. take a new complete backup of "${database}" with the Worker's backup code (never an older one), download it to ${out} and check every part against its manifest\n  2. check the database still holds exactly the rows in that backup, and stop if it doesn't\n  3. ask you to type "${database}"\n  4. delete the database, then try to delete the bucket (which works only if it is empty):`)
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

  // 1. The final backup, downloaded and checked. If it can't be made and verified, nothing is deleted.
  let skipped = []
  let backedUp // the manifest of the final backup, when one was taken
  if (hasDatabase) {
    try {
      if (!hasBucket) throw new ScriptError(`There is no R2 bucket "${bucket}" to take the backup into.`)
      if (databaseHasTables(runner, database)) {
        requireEmptyFolder(out)
        // Always a new backup: an older one from today would miss anything written since, and the database is about to go.
        const { prefix } = await takeBackup(runner, { database, bucket, fresh: true })
        const manifest = await downloadBackup(runner, { bucket, prefix, outDir: out })
        // What the backup holds must be what the database holds now. Anything written during the backup shows up here.
        const different = liveDifferences(runner, database, manifest)
        if (different.length) {
          throw new ScriptError(`the database changed while the backup was being taken, so the backup is not all of it: ${different.join('; ')}. Stop whatever writes to the database (Sync, an Import) and run this again.`)
        }
        backedUp = manifest
        skipped = manifest.skipped.map((s) => s.name)
        console.log(`\nFinal backup saved in ${out}: manifest.json plus one .ndjson file per table (one JSON row per line). Every table in the database is in it, with the same number of rows. Keep it somewhere private.`)
      } else {
        console.log(`D1 database "${database}" has no tables, so there is nothing to back up.`)
      }
    } catch (e) {
      if (!(e instanceof ScriptError)) throw e
      throw new ScriptError(
        [
          `The final backup could not be made and checked: ${e.message}`,
          'Nothing was deleted.',
          `To leave without it, make a copy by hand (npx wrangler d1 export ${database} --remote --output <file>.sql), then delete with npx wrangler d1 delete ${database} and the steps below.`,
        ].join('\n'),
      )
    }
  } else {
    console.log(`D1 database "${database}" is already gone, so there is nothing to back up.`)
  }

  // 2. The typed confirmation. A table the backup could not hold is part of what is typed.
  if (hasDatabase) console.log(`\nThis permanently deletes the D1 database "${database}". It cannot be undone.`)
  if (hasBucket) {
    console.log(`${hasDatabase ? 'It then tries' : 'This tries'} to delete the R2 bucket "${bucket}", which works only once the bucket is empty. Wrangler can't empty it, so that is the last step for you, and emptying it destroys every backup in it. Download any you want to keep first.`)
  }
  let phrase = database
  if (skipped.length) {
    phrase = `${database} without ${skipped.join(', ')}`
    console.log(`\nThese tables are NOT in the final backup (its manifest says why): ${skipped.join(', ')}. Deleting the database loses them.`)
  }
  if (!(await askTyped(`Type ${skipped.length ? `"${phrase}"` : `the database name (${database})`} to delete: `, phrase))) {
    throw new ScriptError('Not confirmed. Nothing was deleted.')
  }
  // Check again: the prompt can wait as long as you like, and anything written meanwhile is not in the backup.
  if (hasDatabase) {
    const different = backedUp ? liveDifferences(runner, database, backedUp) : databaseHasTables(runner, database) ? ['tables appeared in an empty database'] : []
    if (different.length) {
      throw new ScriptError(`The database changed after the backup was taken, so the backup is not all of it: ${different.join('; ')}. Nothing was deleted. Stop whatever writes to the database (Sync, an Import, the app) and run this again.`)
    }
  }

  // 3. The deletes: the database first. If that fails, the bucket (which holds the backup) is left alone.
  if (hasDatabase) {
    try {
      runner.run(['d1', 'delete', database, '--skip-confirmation']) // Wrangler answers its own prompt in CI mode, so the typed name above is the safeguard
    } catch (e) {
      if (!(e instanceof ScriptError)) throw e
      throw new ScriptError(`${e.message}\nThe D1 database "${database}" may still exist (npx wrangler d1 list shows). The R2 bucket was not touched, and the final backup is in ${out}.`)
    }
  }
  const databaseNote = hasDatabase ? `The D1 database "${database}" is deleted. ` : ''
  let bucketLeft = false
  if (hasBucket) {
    const r = runner.run(['r2', 'bucket', 'delete', bucket], { allowFailure: true })
    if (r.status !== 0) {
      if (!/10008|not empty/i.test(r.stdout + r.stderr)) {
        throw new ScriptError(`${databaseNote}\`wrangler r2 bucket delete\` failed (exit ${r.status}) for a reason other than the bucket holding objects. Run the command printed above by hand to see Wrangler's own message.`)
      }
      bucketLeft = true
    }
  }

  if (bucketLeft) {
    console.log(`\n${databaseNote}The R2 bucket is the one thing left.`)
    console.log(remainingSteps())
    console.log(`\n${emptyBucketInstructions(bucket)}`)
  } else {
    console.log("\nDeleted. Fernledger's data is gone from your Cloudflare account.")
    console.log(remainingSteps())
  }
})
