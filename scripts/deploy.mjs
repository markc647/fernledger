// Deploys to the Cloudflare account you confirm: records a D1 restore point (bookmark), applies remote
// migrations, deploys, then prints the bookmark with rollback instructions.
// Usage: node scripts/deploy.mjs [--dry-run] [--yes] [--skip-build]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ScriptError, confirmAccount, createWrangler, main, readResourceNames, root } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

function rollbackInstructions(database, bookmark, migrated) {
  return [
    '',
    'Rollback',
    `  Restore point (D1 bookmark): ${bookmark}`,
    '  1. Usual fix, code only: `npx wrangler rollback` (or redeploy the previous release).',
    '     Migrations are add-only (ADR 0009), so the previous code still runs on the newer schema.',
    migrated
      ? `  2. Last resort, data: \`npx wrangler d1 time-travel restore ${database} --bookmark=${bookmark}\``
      : `  2. Last resort, data (no migrations were applied this run): \`npx wrangler d1 time-travel restore ${database} --bookmark=${bookmark}\``,
    '     This discards everything written since the bookmark. The free plan keeps restore points for 7 days.',
  ].join('\n')
}

await main(async () => {
  const { database, bucket, migrationsDir } = readResourceNames()
  const accountId = await confirmAccount(createWrangler({ dryRun }), { dryRun, yes: args.includes('--yes') })
  const wrangler = createWrangler({ dryRun, accountId })

  // Wrangler would create a missing D1 database or R2 bucket on deploy, with no location (ADR 0007), so check first.
  const databases = wrangler.runJson(['d1', 'list', '--json'])
  const missing = []
  if (!dryRun && !databases.some((d) => d.name === database)) missing.push(`D1 database "${database}"`)
  if (wrangler.run(['r2', 'bucket', 'info', bucket, '--json'], { allowFailure: true }).status !== 0) missing.push(`R2 bucket "${bucket}"`)
  if (missing.length) throw new ScriptError(`Missing ${missing.join(' and ')}. Run \`npm run setup\` first; deploying would create them without a location.`)

  if (!args.includes('--skip-build')) {
    console.log('$ npm run build')
    if (!dryRun && spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }).status !== 0) {
      throw new ScriptError('Build failed. Nothing was changed.')
    }
  }

  const info = wrangler.runJson(['d1', 'time-travel', 'info', database, '--json'], { note: 'records the restore point' })
  const bookmark = dryRun ? '<bookmark>' : info?.bookmark
  if (!bookmark) throw new ScriptError('Could not record a D1 restore point, so nothing was changed.')
  console.log(`Restore point (D1 bookmark): ${bookmark}`)

  const migrations = resolve(root, process.env.FERNLEDGER_MIGRATIONS_DIR || migrationsDir)
  const hasMigrations = existsSync(migrations) && readdirSync(migrations).some((f) => f.endsWith('.sql'))
  let migrated = false
  try {
    if (hasMigrations) {
      migrated = true
      wrangler.run(['d1', 'migrations', 'apply', database, '--remote'])
    } else console.log('No migrations to apply.')
    wrangler.run(['deploy'])
  } catch (e) {
    console.error(e.message)
    console.error(rollbackInstructions(database, bookmark, migrated))
    process.exitCode = 1
    return
  }
  console.log(dryRun ? '\nDry run only. Nothing was changed.' : '\nDeployed.')
  console.log(rollbackInstructions(database, bookmark, migrated))
})
