// Run by `npm install` (the `prepare` script): points git at the committed hooks in .githooks/.
// Does nothing, never fails, when this package isn't the root of its own git checkout (a tarball,
// or a package nested in another repo) or when someone has already chosen a different hooks path.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const git = (...args) => spawnSync('git', args, { cwd: packageDir, encoding: 'utf8' })
const packageDir = resolve(import.meta.dirname, '..')
const norm = (p) => (process.platform === 'win32' ? realpathSync(p).toLowerCase() : realpathSync(p))
const same = (a, b) => norm(a) === norm(b)

const top = git('rev-parse', '--show-toplevel')
if (top.status !== 0 || !same(top.stdout.trim(), packageDir)) {
  console.log('install-hooks: not the repo root, leaving core.hooksPath alone.')
} else {
  const current = git('config', 'core.hooksPath').stdout.trim()
  if (current && current !== '.githooks') console.log(`install-hooks: core.hooksPath is already set to ${current}, leaving it.`)
  else git('config', 'core.hooksPath', '.githooks')
}
