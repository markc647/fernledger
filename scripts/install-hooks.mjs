// Run by `npm install` (the `prepare` script): points git at the committed hooks in .githooks/.
// Does nothing outside a git checkout (e.g. a source tarball), so it can never break an install.
import { spawnSync } from 'node:child_process'

const inRepo = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0
if (inRepo) spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
