// Creates the D1 database and R2 bucket with location hint ${REGION:-oc} (ADR 0007). Safe to re-run: it
// creates only what is missing. Usage: node scripts/setup.mjs [--dry-run] [--yes]
import { ScriptError, bucketExists, confirmAccount, createRunner, databaseExists, main, readResourceNames, regionFromEnv } from './wrangler-cli.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

await main(async () => {
  const region = regionFromEnv()
  const { database, bucket } = readResourceNames()
  const accountId = await confirmAccount(createRunner({ dryRun }), { yes: args.includes('--yes') })
  const runner = createRunner({ dryRun, accountId })

  if (databaseExists(runner, database) === true) console.log(`D1 database "${database}" already exists; leaving it alone.`)
  else runner.run(['d1', 'create', database, '--location', region], { note: 'only if the database is missing' })

  if (bucketExists(runner, bucket) === true) console.log(`R2 bucket "${bucket}" already exists; leaving it alone.`)
  else runner.run(['r2', 'bucket', 'create', bucket, '--location', region], { note: 'only if the bucket is missing' })

  // Checked last, so a re-run after fixing it only has this left to do. A missing field is a failure, not a pass.
  const info = runner.json(['d1', 'info', database, '--json'], { note: 'checks read replication is off' })
  if (info) {
    const mode = info.read_replication?.mode
    if (!mode) throw new ScriptError(`Wrangler did not report a read replication setting for "${database}", so it can't be confirmed off. Check D1 > ${database} > Settings in the Cloudflare dashboard (ADR 0007 keeps it off).`)
    if (mode !== 'disabled') throw new ScriptError(`D1 read replication is "${mode}" on "${database}". Turn it off in the Cloudflare dashboard (D1 > ${database} > Settings); ADR 0007 keeps it off.`)
  }

  console.log(
    dryRun
      ? '\nDry run only. Nothing was created.'
      : `\nDone. Anything created above was created with location hint "${region}". Resources that already existed keep the location they were created with. Next: npm run deploy`,
  )
})
