// Shared by scripts/setup.mjs and scripts/deploy.mjs: reads resource names from wrangler.jsonc,
// validates REGION, and runs Wrangler through a runner that either runs it or, in a dry run,
// only prints what it would run.
//
// Never put Cloudflare resource IDs anywhere in this repo (AGENTS.md). Wrangler finds the D1
// database and R2 bucket by the names in wrangler.jsonc, so nothing here needs an ID.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

export const root = resolve(import.meta.dirname, '..')

// Locations accepted by both `wrangler d1 create --location` and `wrangler r2 bucket create --location`.
export const REGIONS = ['oc', 'apac', 'weur', 'eeur', 'wnam', 'enam']

export class ScriptError extends Error {}

// Removes // and /* */ comments, leaving anything inside a string alone.
export function stripJsonComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) throw new ScriptError('wrangler.jsonc has a string that never ends.')
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new ScriptError('wrangler.jsonc has a /* comment that never ends.')
      i = end + 2
    } else {
      out += c
      i++
    }
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
// without touching Cloudflare. Test-only.
const wranglerBin = () => process.env.FERNLEDGER_WRANGLER || resolve(root, 'node_modules/wrangler/bin/wrangler.js')

const DRY_RESULT = { dry: true, status: 0, stdout: '', stderr: '' }

// A runner has run(args, options), json(args, options) and npm(args). `dry` is true for the dry runner,
// whose methods print "$ ..." and run nothing (json() returns null). The real runner prints the same
// line, then runs Wrangler against `accountId`.
//
// Wrangler runs with CI=true: it never prompts, and never writes resource IDs back into wrangler.jsonc
// (which would put them in a public repo). The price is that its yes/no prompts answer themselves, so
// callers must not rely on a Wrangler prompt as a safeguard (see "What Wrangler answers for itself" in docs/setup.md).
//
// Options: note (comment shown in the printed line), allowFailure (return a non-zero result instead of
// throwing), show (print stdout when the command succeeds). Failures never include Wrangler's own output,
// which can contain the account email.
export function createRunner({ dryRun, accountId, log = console.log }) {
  const echo = (args, note) => log(`$ npx wrangler ${args.join(' ')}${note ? `  # ${note}` : ''}`)
  if (dryRun) {
    return {
      dry: true,
      run: (args, { note } = {}) => (echo(args, note), DRY_RESULT),
      json: (args, { note } = {}) => (echo(args, note), null),
      npm: (args) => log(`$ npm ${args.join(' ')}`),
    }
  }
  function run(args, { note, allowFailure = false, show = false } = {}) {
    echo(args, note)
    const bin = wranglerBin()
    if (!existsSync(bin)) throw new ScriptError('Wrangler is not installed. Run `npm install`, then try again.')
    const env = { ...process.env, CI: 'true' }
    if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env })
    if (r.error) throw new ScriptError(`Could not start Wrangler (${r.error.code ?? 'unknown error'}). Run \`npm install\`, then try again.`)
    if (r.status !== 0 && !allowFailure) {
      const what = args.filter((a) => !a.startsWith('-')).join(' ')
      throw new ScriptError(`\`wrangler ${what}\` failed (exit ${r.status}). Run the command printed above by hand to see Wrangler's own message.`)
    }
    if (show && r.status === 0 && r.stdout.trim()) log(r.stdout.trimEnd())
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  function json(args, options) {
    const r = run(args, options)
    try {
      return JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)))
    } catch {
      throw new ScriptError(`\`wrangler ${args[0]} ${args[1]}\` did not return JSON.`)
    }
  }
  function npm(args) {
    log(`$ npm ${args.join(' ')}`)
    const r = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) throw new ScriptError(`\`npm ${args.join(' ')}\` failed (exit ${r.status}).`)
  }
  return { dry: false, run, json, npm }
}

// Existence checks shared by setup and deploy. Each returns true or false, or undefined in a dry run
// (callers treat "unknown" as "would proceed"). An R2 error that is not "no such bucket" (code 10006) stops the script.
export function databaseExists(runner, name) {
  const list = runner.json(['d1', 'list', '--json'])
  return list ? list.some((d) => d.name === name) : undefined
}

export function bucketExists(runner, name) {
  const r = runner.run(['r2', 'bucket', 'info', name, '--json'], { allowFailure: true })
  if (r.dry) return undefined
  if (r.status === 0) return true
  if (/10006|does not exist/i.test(r.stderr + r.stdout)) return false
  throw new ScriptError(`Could not check whether R2 bucket "${name}" exists (exit ${r.status}).`)
}

// Asks a yes/no question. With no terminal there is nobody to ask, so it throws `ifNoTerminal`: fail closed.
export async function askYesNo(question, ifNoTerminal) {
  if (!process.stdin.isTTY) throw new ScriptError(ifNoTerminal)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// Works out which Cloudflare account Wrangler is signed in to and has the Deployer confirm it; returns its ID
// (undefined in a dry run). CLOUDFLARE_ACCOUNT_ID picks one when the login has several.
export async function confirmAccount(runner, { yes, env = process.env, log = console.log }) {
  const who = runner.run(['whoami', '--json'], { allowFailure: true })
  if (runner.dry) {
    log('Dry run: the account in use, and a confirmation prompt (skipped with --yes), would come next.')
    return undefined
  }
  let accounts = []
  try {
    if (who.status === 0) accounts = JSON.parse(who.stdout.slice(who.stdout.search(/[[{]/))).accounts ?? []
  } catch {
    // Treated the same as not signed in.
  }
  if (accounts.length === 0) throw new ScriptError('Wrangler is not signed in to a Cloudflare account. Run `npx wrangler login`, then try again.')
  const wanted = env.CLOUDFLARE_ACCOUNT_ID
  const account = wanted ? accounts.find((a) => a.id === wanted) : accounts.length === 1 ? accounts[0] : undefined
  if (!account) {
    throw new ScriptError(
      wanted
        ? 'CLOUDFLARE_ACCOUNT_ID is not one of the accounts this login can reach.'
        : `This login reaches ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to the one you want.`,
    )
  }
  log(`Target Cloudflare account: ${account.name} (${account.id})`)
  if (!yes && !(await askYesNo('Use this account?', 'Not confirmed: re-run with --yes to proceed without a prompt.'))) {
    throw new ScriptError('Cancelled. Nothing was changed.')
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
