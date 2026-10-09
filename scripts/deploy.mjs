// Deploys to the Cloudflare account you confirm: takes a complete backup, records a D1 restore point (bookmark),
// applies remote migrations, deploys, then prints the bookmark with rollback instructions.
// Usage: node scripts/deploy.mjs [--dry-run] [--yes] [--workers-dev-registered] [--skip-build] [--skip-backup]
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { databaseHasTables, takeBackup } from './backup-run.mjs'
import { ScriptError, askYesNo, bucketExists, confirmAccount, createRunner, databaseExists, main, readResourceNames, root } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

// Wrangler registers a workers.dev subdomain for an account that has none, and with no prompt in some
// environments (CI mode, AI coding agents). Registering is the Deployer's decision, so this script
// only deploys once the Deployer has said the account already has one. docs/setup.md explains why.
async function requireWorkersDevSubdomain(accountId, { alreadyStated }) {
  if (dryRun) {
    console.log('Dry run: a real run stops here unless you confirm the account already has a workers.dev subdomain (--workers-dev-registered).')
    return
  }
  const url = `https://dash.cloudflare.com/${accountId}/workers/subdomain`
  console.log(`Check this account has a workers.dev subdomain: ${url}`)
  if (alreadyStated) return
  const stopped = `Not confirmed: once you have checked, re-run with --workers-dev-registered. If the account has no subdomain, register one at ${url} first.`
  if (!(await askYesNo('Does this account already have a workers.dev subdomain?', stopped))) throw new ScriptError(stopped)
}

// The account is in the commands so they run as printed even when the login reaches several accounts.
function rollbackInstructions(database, bookmark, accountId, backup) {
  const wrangler = `CLOUDFLARE_ACCOUNT_ID=${accountId ?? '<account id>'} npx wrangler`
  return [
    '',
    'Rollback',
    `  Restore point (D1 bookmark): ${bookmark}`,
    ...(backup ? [`  Backup taken first: ${backup.prefix} (docs/setup.md, "Rolling back")`] : []),
    `  1. Usual fix, code only: \`${wrangler} rollback\` (or redeploy the previous release).`,
    '     Migrations are add-only (ADR 0009), so the previous code still runs on the newer schema.',
    `  2. Last resort, data: \`${wrangler} d1 time-travel restore ${database} --bookmark=${bookmark}\``,
    '     This discards everything written since the bookmark. The free plan keeps restore points for 7 days.',
    '     In PowerShell, set the account first: $env:CLOUDFLARE_ACCOUNT_ID = "<account id>", then run the command without the prefix.',
  ].join('\n')
}

// The backup comes before the restore point and the migrations, and nothing has changed if it fails.
// Returns the backup, or null when there is none to take.
async function backupBeforeMigrations(runner, database, bucket) {
  if (args.includes('--skip-backup')) {
    console.log(`Skipping the backup (--skip-backup). Make sure you have a copy: npx wrangler d1 export ${database} --remote --output <file>.sql`)
    return null
  }
  if (dryRun) {
    console.log("Dry run: a complete backup would be taken here with the Worker's backup code, and deploy would wait for it to finish. It is skipped on a first deploy, when the database has no tables.")
    return null
  }
  try {
    if (!databaseHasTables(runner, database)) {
      console.log(`First deploy: D1 database "${database}" has no tables yet, so there is nothing to back up. Skipping the backup.`)
      return null
    }
    return await takeBackup(runner, { database, bucket })
  } catch (e) {
    if (!(e instanceof ScriptError)) throw e
    throw new ScriptError(
      [
        `The backup before the migrations did not finish: ${e.message}`,
        'Nothing was changed: no migrations were applied and nothing was deployed.',
        'Run `npm run deploy` again. An unfinished backup carries on where it stopped.',
        `To deploy without one, first make a copy by hand (npx wrangler d1 export ${database} --remote --output <file>.sql), then run \`npm run deploy -- --skip-backup\`.`,
      ].join('\n'),
    )
  }
}

await main(async () => {
  const { database, bucket, migrationsDir } = readResourceNames()
  const accountId = await confirmAccount(createRunner({ dryRun }), { yes: args.includes('--yes') })
  await requireWorkersDevSubdomain(accountId, { alreadyStated: args.includes('--workers-dev-registered') })
  const runner = createRunner({ dryRun, accountId })

  // Wrangler would create a missing D1 database or R2 bucket on deploy, with no location (ADR 0007), so check first.
  const missing = []
  if (databaseExists(runner, database) === false) missing.push(`D1 database "${database}"`)
  if (bucketExists(runner, bucket) === false) missing.push(`R2 bucket "${bucket}"`)
  if (missing.length) throw new ScriptError(`Missing ${missing.join(' and ')}. Run \`npm run setup\` first; deploying would create them without a location.`)

  if (!args.includes('--skip-build')) runner.npm(['run', 'build'])

  const backup = await backupBeforeMigrations(runner, database, bucket)

  const info = runner.json(['d1', 'time-travel', 'info', database, '--json'], { note: 'records the restore point' })
  const bookmark = dryRun ? '<bookmark>' : info?.bookmark
  if (!bookmark) throw new ScriptError('Could not record a D1 restore point, so nothing was changed.')
  console.log(`Restore point (D1 bookmark): ${bookmark}`)

  const migrations = resolve(root, process.env.FERNLEDGER_MIGRATIONS_DIR || migrationsDir)
  const hasMigrations = existsSync(migrations) && readdirSync(migrations).some((f) => f.endsWith('.sql'))
  try {
    if (hasMigrations) runner.run(['d1', 'migrations', 'apply', database, '--remote'], { show: true })
    else console.log('No migrations to apply.')
    // --strict: in CI mode Wrangler answers its own "overwrite remote changes?" prompts with yes; --strict makes it stop instead.
    runner.run(['deploy', '--strict'], { show: true })
  } catch (e) {
    if (!(e instanceof ScriptError)) throw e
    console.error(e.message)
    console.error(rollbackInstructions(database, bookmark, accountId, backup))
    process.exitCode = 1
    return
  }
  console.log(dryRun ? '\nDry run only. Nothing was changed.' : '\nDeployed.')
  console.log(rollbackInstructions(database, bookmark, accountId, backup))
})
