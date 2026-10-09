// Creates the D1 database and R2 bucket in ${REGION:-oc} (ADR 0007). Safe to re-run: it creates only
// what is missing. Usage: node scripts/setup.mjs [--dry-run] [--yes]
import { ScriptError, confirmAccount, createWrangler, main, readResourceNames, regionFromEnv } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

await main(async () => {
  const region = regionFromEnv()
  const { database, bucket } = readResourceNames()
  const accountId = await confirmAccount(createWrangler({ dryRun }), { dryRun, yes: args.includes('--yes') })
  const wrangler = createWrangler({ dryRun, accountId })

  const databases = wrangler.runJson(['d1', 'list', '--json'])
  if (dryRun || !databases.some((d) => d.name === database)) {
    wrangler.run(['d1', 'create', database, '--location', region], { note: 'only if the database is missing' })
  } else console.log(`D1 database "${database}" already exists; leaving it alone.`)
  const info = wrangler.runJson(['d1', 'info', database, '--json'], { note: 'checks read replication is off' })
  const replication = info?.read_replication?.mode
  if (replication && replication !== 'disabled') {
    throw new ScriptError(`D1 read replication is "${replication}" on "${database}". Turn it off in the Cloudflare dashboard (D1 > ${database} > Settings); ADR 0007 keeps it off.`)
  }

  const existing = wrangler.run(['r2', 'bucket', 'info', bucket, '--json'], { allowFailure: true })
  if (dryRun || existing.status !== 0) {
    if (!dryRun && !/10006|does not exist/i.test(existing.stderr + existing.stdout)) {
      throw new ScriptError(`Could not check R2 bucket "${bucket}".\n${existing.stderr}`.trim())
    }
    wrangler.run(['r2', 'bucket', 'create', bucket, '--location', region], { note: 'only if the bucket is missing' })
  } else console.log(`R2 bucket "${bucket}" already exists; leaving it alone.`)

  console.log(dryRun ? '\nDry run only. Nothing was created.' : `\nDone. Resources are in location "${region}". Next: npm run deploy`)
})
