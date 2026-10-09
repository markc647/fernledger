// `npm run seed`: applies the local migrations, then loads the made-up data in seed/*.sql into the local D1.
// The conventions for seed files are in docs/setup.md (Local development). Local only: every command passes --local.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

export function seedFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function wrangler(...args) {
  const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`seed: wrangler ${args.slice(0, 2).join(' ')} failed (exit ${result.status}).`)
    process.exit(result.status ?? 1)
  }
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  // wrangler errors when there are no migrations yet; that is the state before the first table lands.
  if (seedFiles(join(root, 'migrations')).length) wrangler('d1', 'migrations', 'apply', 'DB', '--local')
  else console.log('seed: no migrations yet, nothing to apply.')
  const dir = join(root, 'seed')
  const files = seedFiles(dir)
  for (const file of files) wrangler('d1', 'execute', 'DB', '--local', '--file', join(dir, file))
  console.log(`seed: loaded ${files.length} seed file(s) into the local database.`)
}
