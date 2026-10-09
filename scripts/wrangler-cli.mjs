// Shared by scripts/setup.mjs and scripts/deploy.mjs: reads resource names from wrangler.jsonc,
// validates REGION, and runs Wrangler (or, in a dry run, only prints what it would run).
//
// Never put Cloudflare resource IDs anywhere in this repo (AGENTS.md). Wrangler finds the D1
// database and R2 bucket by the names in wrangler.jsonc, so nothing here needs an ID.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

export const root = resolve(import.meta.dirname, '..')

// Locations accepted by both `wrangler d1 create --location` and `wrangler r2 bucket create --location`.
export const REGIONS = ['oc', 'apac', 'weur', 'eeur', 'wnam', 'enam']

export class ScriptError extends Error {}

// Removes // and /* */ comments, leaving anything inside a string alone.
export function stripJsonComments(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else out += c
  }
  return out
}

// The D1 database and R2 bucket names, read from wrangler.jsonc so they have one home.
export function readResourceNames(configPath = resolve(root, 'wrangler.jsonc')) {
  const config = JSON.parse(stripJsonComments(readFileSync(configPath, 'utf8')))
  const database = config.d1_databases?.[0]?.database_name
  const bucket = config.r2_buckets?.[0]?.bucket_name
  if (!database || !bucket) throw new ScriptError('wrangler.jsonc must name a D1 database (database_name) and an R2 bucket (bucket_name).')
  return { database, bucket, migrationsDir: config.d1_databases[0].migrations_dir ?? 'migrations' }
}

export function regionFromEnv(env = process.env) {
  const region = env.REGION || 'oc'
  if (!REGIONS.includes(region)) throw new ScriptError(`REGION must be one of ${REGIONS.join(', ')}, not "${region}".`)
  return region
}

// FERNLEDGER_WRANGLER swaps in a fake Wrangler so the tests can run these scripts end to end
// without touching Cloudflare.
const wranglerBin = () => process.env.FERNLEDGER_WRANGLER || resolve(root, 'node_modules/wrangler/bin/wrangler.js')

// Returns { run, runJson }. In a dry run, run() prints "$ npx wrangler ..." and runs nothing. Otherwise it
// prints the same line, then runs Wrangler against `accountId`. CI=true stops Wrangler prompting and
// stops it writing resource IDs back into wrangler.jsonc, which would put them in a public repo.
export function createWrangler({ dryRun, accountId, log = console.log }) {
  function run(args, { note, allowFailure = false } = {}) {
    log(`$ npx wrangler ${args.join(' ')}${note ? `  # ${note}` : ''}`)
    if (dryRun) return { status: 0, stdout: '', stderr: '', dryRun: true }
    const env = { ...process.env, CI: 'true' }
    if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId
    const r = spawnSync(process.execPath, [wranglerBin(), ...args], { cwd: root, encoding: 'utf8', env })
    if (r.status !== 0 && !allowFailure) {
      throw new ScriptError(`wrangler ${args[0]} ${args[1] ?? ''} failed (exit ${r.status}).\n${r.stderr || r.stdout}`.trim())
    }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  function runJson(args, options) {
    const r = run(args, options)
    if (r.dryRun || r.status !== 0) return r.dryRun ? null : undefined
    try {
      return JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)))
    } catch {
      throw new ScriptError(`wrangler ${args[0]} ${args[1] ?? ''} did not return JSON.`)
    }
  }
  return { run, runJson }
}

// Works out which Cloudflare account Wrangler is signed in to, and asks the Deployer to confirm it.
// CLOUDFLARE_ACCOUNT_ID picks one when the login has several. Fails closed: with no TTY and no --yes it stops.
export async function confirmAccount(wrangler, { dryRun, yes, env = process.env }) {
  const who = wrangler.runJson(['whoami', '--json'])
  if (dryRun) {
    console.log('Dry run: the account in use, and a confirmation prompt (skipped with --yes), would come next.')
    return undefined
  }
  const accounts = who?.accounts ?? []
  if (accounts.length === 0) throw new ScriptError('Wrangler is not signed in to a Cloudflare account. Run `npx wrangler login` first.')
  const wanted = env.CLOUDFLARE_ACCOUNT_ID
  const account = wanted ? accounts.find((a) => a.id === wanted) : accounts.length === 1 ? accounts[0] : undefined
  if (!account) {
    throw new ScriptError(
      wanted
        ? 'CLOUDFLARE_ACCOUNT_ID is not one of the accounts this login can reach.'
        : `This login reaches ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to the one you want.`,
    )
  }
  console.log(`Target Cloudflare account: ${account.name} (${account.id})`)
  if (!yes) {
    if (!process.stdin.isTTY) throw new ScriptError('Not confirmed: re-run with --yes to proceed without a prompt.')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('Use this account? [y/N] ')
    rl.close()
    if (!/^y(es)?$/i.test(answer.trim())) throw new ScriptError('Cancelled. Nothing was changed.')
  }
  return account.id
}

export async function main(fn) {
  try {
    await fn()
  } catch (e) {
    if (!(e instanceof ScriptError)) throw e
    console.error(e.message)
    process.exitCode = 1
  }
}
