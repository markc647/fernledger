// Run with `npm run test:scripts`. The weekly update check that Deploy-button copies run (spec story 115):
// .github/workflows/upgrade-check.yml decides with scripts/upgrade-check.mjs and opens a pull request.
// Git runs for real, on throwaway repositories in the temp folder; nothing here reaches GitHub.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { PR_REFUSED, applyRelease, checkUpstream, compareVersions, openPullRequest, parseTag, planUpgrade } from './upgrade-check.mjs'

const root = resolve(import.meta.dirname, '..')
const cleanup = []
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fernledger-test-upgrade-'))
  cleanup.push(dir)
  return dir
}

// Git ignores the developer's own configuration (signing, hooks, autocrlf, a default branch), here and in the scripts
// under test, which inherit this environment.
const emptyGitConfig = join(tempDir(), 'gitconfig')
writeFileSync(emptyGitConfig, '')
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...identity } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
/** A repository with these files committed (a value of null deletes a file from the previous commit). */
function commit(dir, files, message = 'commit') {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    if (content === null) rmSync(file, { force: true })
    else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}
const pkg = (version) => JSON.stringify({ name: 'fernledger', version })
/** File text with Windows line endings (git's autocrlf on checkout) normalised. */
const read = (dir, path) => readFileSync(join(dir, path), 'utf8').replaceAll('\r\n', '\n')
const tracked = (dir) => git(dir, 'ls-files').split('\n').filter(Boolean).sort()

test('parseTag takes only vMAJOR.MINOR.PATCH', () => {
  assert.deepEqual(parseTag('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseTag('v10.0.12'), [10, 0, 12])
  for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3 ', 'v1.2.3\n', 'v01.2.3', 'v1.2.3;rm -rf', '', 'latest']) assert.equal(parseTag(bad), null, JSON.stringify(bad))
})

test('compareVersions orders numerically, not as text', () => {
  assert.ok(compareVersions([1, 10, 0], [1, 9, 0]) > 0)
  assert.ok(compareVersions([2, 0, 0], [1, 99, 99]) > 0)
  assert.ok(compareVersions([1, 2, 3], [1, 2, 4]) < 0)
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0)
})

const release = (overrides = {}) => ({ tag_name: 'v1.3.0', html_url: 'https://github.com/example/fernledger/releases/tag/v1.3.0', body: '## 1.3.0\n\n- New things', draft: false, prerelease: false, ...overrides })

test('plans an upgrade when the latest release is newer, with the release notes in the body', () => {
  const plan = planUpgrade({ currentVersion: '1.2.5', release: release() })
  assert.equal(plan.upgrade, true)
  assert.equal(plan.tag, 'v1.3.0')
  assert.equal(plan.branch, 'fernledger-update/v1.3.0')
  assert.match(plan.title, /1\.3\.0/)
  assert.match(plan.body, /New things/)
  assert.match(plan.body, /releases\/tag\/v1\.3\.0/)
  assert.doesNotMatch(plan.body, /major/i)
})

test('a minor or patch release says what to expect; a major release says to read the upgrade notes first', () => {
  assert.match(planUpgrade({ currentVersion: '1.2.5', release: release({ tag_name: 'v1.2.6' }) }).body, /fixes only/i)
  assert.match(planUpgrade({ currentVersion: '1.2.5', release: release({ tag_name: 'v2.0.0' }) }).body, /major release.*upgrade notes.*before you merge/i)
})

test('plans nothing when the copy is current, ahead, or the release is not usable', () => {
  for (const [currentVersion, overrides] of [
    ['1.3.0', {}],
    ['1.4.0', {}],
    ['1.2.0', { draft: true }],
    ['1.2.0', { prerelease: true }],
    ['1.2.0', { tag_name: 'v1.3.0-rc.1' }],
    ['1.2.0', { tag_name: 'nightly' }],
  ]) {
    const plan = planUpgrade({ currentVersion, release: release(overrides) })
    assert.equal(plan.upgrade, false, JSON.stringify({ currentVersion, overrides }))
    assert.ok(plan.reason)
  }
})

test('refuses a current version it cannot read, rather than guess', () => {
  assert.throws(() => planUpgrade({ currentVersion: 'banana', release: release() }), /package\.json/)
})

test('a very long set of release notes is cut to fit a pull request body', () => {
  const plan = planUpgrade({ currentVersion: '1.0.0', release: release({ body: 'x'.repeat(200_000) }) })
  assert.ok(plan.body.length < 65_536)
  assert.match(plan.body, /release page/i)
})

// A stand-in for the upstream repository, and a copy of it that was made without shared history (the Deploy button).
function upstreamWithRelease(version, files) {
  const upstream = tempDir()
  git(upstream, 'init', '-q')
  commit(upstream, { 'package.json': pkg(version), ...files })
  git(upstream, 'tag', `v${version}`)
  return { source: pathToFileURL(upstream).href, dir: upstream }
}
function copyWith(files) {
  const copy = tempDir()
  git(copy, 'init', '-q')
  commit(copy, files)
  return copy
}

test('applyRelease makes the copy match the release: files updated, added and removed, with unrelated history', () => {
  const { source } = upstreamWithRelease('1.3.0', {
    'src/app.ts': 'new app\n',
    'src/added.ts': 'added\n',
    'migrations/0801_a.sql': 'CREATE TABLE a (id INTEGER);\n',
    'migrations/0901_b.sql': 'ALTER TABLE a ADD COLUMN x TEXT;\n',
    '.github/workflows/ci.yml': 'name: new ci\n',
  })
  const copy = copyWith({
    'package.json': pkg('1.2.0'),
    'src/app.ts': 'old app\n',
    'src/removed.ts': 'gone upstream\n',
    'migrations/0801_a.sql': 'CREATE TABLE a (id INTEGER);\n',
    '.github/workflows/ci.yml': 'name: old ci\n',
    '.github/workflows/mine.yml': 'name: my own workflow\n',
  })

  const { changedWorkflows } = applyRelease({ repoDir: copy, source, tag: 'v1.3.0' })

  assert.equal(read(copy, 'src/app.ts'), 'new app\n')
  assert.equal(read(copy, 'src/added.ts'), 'added\n')
  assert.ok(!existsSync(join(copy, 'src/removed.ts')))
  assert.equal(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version, '1.3.0')
  assert.deepEqual(tracked(copy), ['.github/workflows/ci.yml', '.github/workflows/mine.yml', 'migrations/0801_a.sql', 'migrations/0901_b.sql', 'package.json', 'src/added.ts', 'src/app.ts'])
  // Workflows are never touched: GitHub refuses a push from Actions that changes them. They are reported instead.
  assert.equal(read(copy, '.github/workflows/ci.yml'), 'name: old ci\n')
  assert.deepEqual(changedWorkflows, ['.github/workflows/ci.yml'])
  // Staged, not committed: the workflow commits.
  assert.match(git(copy, 'status', '--porcelain'), /^M[M ] src\/app\.ts$/m)
})

test('applyRelease leaves files git does not track alone', () => {
  const { source } = upstreamWithRelease('1.3.0', {})
  const copy = copyWith({ 'package.json': pkg('1.2.0'), '.gitignore': '.dev.vars\n' })
  writeFileSync(join(copy, '.dev.vars'), 'ADMIN_EMAIL=admin@example.com\n')

  applyRelease({ repoDir: copy, source, tag: 'v1.3.0' })

  assert.equal(readFileSync(join(copy, '.dev.vars'), 'utf8'), 'ADMIN_EMAIL=admin@example.com\n')
})

test('applyRelease stops if the tag is not a plain release tag, before it fetches anything', () => {
  const copy = copyWith({ 'package.json': pkg('1.2.0') })
  for (const tag of ['main', '--upload-pack=x', 'v1.3.0-rc.1', 'v1.3']) assert.throws(() => applyRelease({ repoDir: copy, source: 'file:///no/such/place', tag }), /release tag/)
})

test('applyRelease stops if the tag and the version in package.json disagree, since the copy would never catch up', () => {
  const { source, dir } = upstreamWithRelease('1.2.9', {})
  git(dir, 'tag', 'v1.3.0')
  const copy = copyWith({ 'package.json': pkg('1.2.0') })

  assert.throws(() => applyRelease({ repoDir: copy, source, tag: 'v1.3.0' }), /package\.json says 1\.2\.9/)
  assert.equal(git(copy, 'status', '--porcelain'), '', 'the copy is left as it was')
})

test('applyRelease stops on a copy with uncommitted changes, so nothing of the Deployer\'s is lost', () => {
  const { source } = upstreamWithRelease('1.3.0', {})
  const copy = copyWith({ 'package.json': pkg('1.2.0') })
  writeFileSync(join(copy, 'package.json'), pkg('1.2.1'))

  assert.throws(() => applyRelease({ repoDir: copy, source, tag: 'v1.3.0' }), /uncommitted/)
})

test('the plan command writes the workflow outputs and the pull request body, and says nothing when there is nothing to do', () => {
  const dir = tempDir()
  const releaseFile = join(dir, 'release.json')
  const outputs = join(dir, 'outputs.txt')
  const bodyFile = join(dir, 'body.md')
  const run = (version, rel) => {
    writeFileSync(releaseFile, JSON.stringify(rel))
    writeFileSync(join(dir, 'package.json'), pkg(version))
    writeFileSync(outputs, '')
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'upgrade-check.mjs'), 'plan', releaseFile, bodyFile], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputs } })
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(outputs, 'utf8')
  }

  assert.equal(run('1.3.0', release()), 'upgrade=false\n')
  const out = run('1.2.0', release())
  assert.match(out, /^upgrade=true\ntag=v1\.3\.0\nbranch=fernledger-update\/v1\.3\.0\ntitle=.*1\.3\.0.*\n$/)
  assert.match(readFileSync(bodyFile, 'utf8'), /New things/)
})

// The workflow itself. GitHub isn't available here, so the rules that make it safe are checked in its text.
const workflow = readFileSync(join(root, '.github', 'workflows', 'upgrade-check.yml'), 'utf8')

test('the workflow is a no-op in the upstream repository and runs weekly or on demand', () => {
  assert.match(workflow, /^\s{4}if: github\.repository != 'markc647\/fernledger'$/m)
  const cron = workflow.match(/- cron: "(\d+) (\d+) \* \* (\d)"/)
  assert.ok(cron, 'a weekly cron')
  assert.notEqual(cron[1], '0', 'not on the hour, when GitHub schedules are busiest')
  assert.match(workflow, /^\s{2}workflow_dispatch:/m)
  assert.equal(workflow.match(/^\s+UPSTREAM: (\S+)$/m)?.[1], 'markc647/fernledger')
})

test('the workflow asks for the least it needs: no default permissions, no secret but GITHUB_TOKEN, and that only in the steps that use gh', () => {
  assert.match(workflow, /^permissions: \{\}$/m)
  assert.match(workflow, /^\s{6}contents: write\n\s{6}pull-requests: write$/m)
  assert.deepEqual([...new Set([...workflow.matchAll(/\$\{\{\s*secrets\.(\w+)/g)].map((m) => m[1]))], ['GITHUB_TOKEN'])
  assert.doesNotMatch(workflow, /^ {4}env:\n(?: {6}.*\n)*? {6}GH_TOKEN:/m, 'GH_TOKEN is set per step, not for the whole job')
  assert.equal(workflow.match(/^ {10}GH_TOKEN: /gm)?.length, 2, 'both steps that call gh set it')
  assert.ok(!/^\s*(pull_request_target|pull_request|push):/m.test(workflow), 'only schedule and workflow_dispatch trigger it')
})

test('every action is pinned to a full commit SHA', () => {
  const uses = [...workflow.matchAll(/^\s*- uses: (\S+)/gm)].map((m) => m[1])
  assert.ok(uses.length > 0)
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use)
})

test('no expression is interpolated into a shell script, so release data cannot inject commands', () => {
  const scripts = [...workflow.matchAll(/^\s+run: \|\n((?:\s{10,}.*\n?)+)/gm)].map((m) => m[1]).concat([...workflow.matchAll(/^\s+run: (?!\|)(.+)$/gm)].map((m) => m[1]))
  assert.ok(scripts.length >= 2)
  for (const script of scripts) assert.doesNotMatch(script, /\$\{\{/, script)
})

test('the workflow runs one at a time and stays thin: the logic is in scripts/upgrade-check.mjs', () => {
  assert.match(workflow, /^concurrency:\n {2}group: \S+\n {2}cancel-in-progress: false$/m)
  assert.match(workflow, /run: node scripts\/upgrade-check\.mjs check /)
  assert.match(workflow, /run: node scripts\/upgrade-check\.mjs open /)
  assert.doesNotMatch(workflow.replace(/^\s*#.*$/gm, ''), /\bgit push\b|\bgh pr\b|\bgh api\b/, 'git and gh are driven by the script, which a copy receives in an update; this file it does not')
})

test('the update branch is force-pushed, and a refused pull request names the setting that allows it', () => {
  const script = readFileSync(join(root, 'scripts', 'upgrade-check.mjs'), 'utf8')
  assert.match(script, /\['push', '--force', 'origin', branch\]/)
  assert.match(PR_REFUSED, /Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create and approve pull requests/)
  assert.match(workflow, /Allow GitHub Actions to create and approve pull requests/)
})

test('the pull request body says that npm run deploy, not the merge, backs up and migrates the database', () => {
  const { body } = planUpgrade({ currentVersion: '1.2.5', release: release() })
  assert.match(body, /Merging does not change your database/)
  assert.match(body, /npm run deploy/)
  assert.match(body, /pre-deploy backup/)
  assert.match(body, /restore point/)
  assert.match(body, /migrations/)
  assert.match(body, /Cloudflare build[^.]*skips those steps[^.]*as well \(or instead\)/)
  assert.doesNotMatch(body, /Deploy button/, 'the Deploy button is Planned; the body does not describe it')
})

// The open command, with git real (a local bare repository stands in for GitHub) and gh faked.
function copyWithRemote() {
  const { source } = upstreamWithRelease('1.3.0', { 'src/app.ts': 'new app\n' })
  const copy = copyWith({ 'package.json': pkg('1.2.0'), 'src/app.ts': 'old app\n' })
  const remote = tempDir()
  git(remote, 'init', '-q', '--bare')
  git(copy, 'remote', 'add', 'origin', pathToFileURL(remote).href)
  git(copy, 'push', '-q', 'origin', 'main')
  const bodyFile = join(tempDir(), 'body.md')
  writeFileSync(bodyFile, 'body\n')
  const options = { repoDir: copy, source, tag: 'v1.3.0', branch: 'fernledger-update/v1.3.0', base: 'main', title: 'Update Fernledger to 1.3.0', bodyFile }
  return { copy, remote, options }
}
/** A stand-in for gh: `existing` is the number of pull requests `pr list` reports; `createFails` makes `pr create` fail. */
function fakeGh({ existing = 0, createFails = false } = {}) {
  const calls = []
  const exec = (command, args) => {
    calls.push([command, ...args])
    assert.equal(command, 'gh')
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: `${existing}\n`, stderr: '' }
    if (args[0] === 'pr' && args[1] === 'create') {
      return createFails ? { status: 1, stdout: '', stderr: 'GitHub Actions is not permitted to create or approve pull requests\n' } : { status: 0, stdout: 'https://github.com/example/x/pull/1\n', stderr: '' }
    }
    return assert.fail(`unexpected gh ${args.join(' ')}`)
  }
  return { exec, calls }
}

test('open pushes the update branch as the bot, commits the release and opens the pull request', () => {
  const { copy, remote, options } = copyWithRemote()
  const gh = fakeGh()

  assert.deepEqual(openPullRequest({ ...options, exec: gh.exec }), { opened: true })

  assert.equal(git(remote, 'show', 'fernledger-update/v1.3.0:src/app.ts'), 'new app\n')
  assert.match(git(remote, 'log', '-1', '--format=%an <%ae>', 'fernledger-update/v1.3.0'), /^github-actions\[bot\] </)
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'fernledger-update/v1.3.0').trim(), 'Update Fernledger to 1.3.0')
  const create = gh.calls.find((c) => c[2] === 'create')
  assert.deepEqual(create.slice(3), ['--base', 'main', '--head', 'fernledger-update/v1.3.0', '--title', 'Update Fernledger to 1.3.0', '--body-file', options.bodyFile])
  assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fernledger-update/v1.3.0')
})

test('open does nothing when a pull request for the release exists, open, merged or closed', () => {
  const { remote, options } = copyWithRemote()
  const gh = fakeGh({ existing: 1 })

  const result = openPullRequest({ ...options, exec: gh.exec })

  assert.equal(result.opened, false)
  assert.equal(gh.calls.length, 1)
  assert.equal(git(remote, 'branch', '--format=%(refname:short)').trim(), 'main')
})

test('a re-run after GitHub refused the pull request force-pushes the branch it already pushed, and says which setting to turn on', () => {
  const { copy, remote, options } = copyWithRemote()
  assert.throws(
    () => openPullRequest({ ...options, exec: fakeGh({ createFails: true }).exec }),
    (error) => {
      assert.ok(error.message.startsWith(PR_REFUSED))
      assert.match(error.message, /Allow GitHub Actions to create and approve pull requests/)
      return true
    },
  )
  const first = git(remote, 'rev-parse', 'fernledger-update/v1.3.0').trim()

  // A fresh run starts from a new checkout of main, a moment later, so its commit is a different one: not a fast-forward.
  git(copy, 'switch', '-q', 'main')
  git(copy, 'branch', '-q', '-D', 'fernledger-update/v1.3.0')
  process.env.GIT_COMMITTER_DATE = '2030-01-01T00:00:00Z'
  try {
    assert.deepEqual(openPullRequest({ ...options, exec: fakeGh().exec }), { opened: true })
  } finally {
    delete process.env.GIT_COMMITTER_DATE
  }

  assert.notEqual(git(remote, 'rev-parse', 'fernledger-update/v1.3.0').trim(), first, 'the branch was replaced, which a plain push would have refused')
})

test('check reads the latest release with gh: none yet is fine, any other failure is an error', () => {
  const bodyFile = join(tempDir(), 'body.md')
  const gh = (result) => (command, args) => {
    assert.deepEqual([command, ...args], ['gh', 'api', 'repos/example/fernledger/releases/latest'])
    return result
  }
  const base = { upstream: 'example/fernledger', bodyFile, currentVersion: '1.2.0' }

  assert.equal(checkUpstream({ ...base, exec: gh({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' }) }).upgrade, false)
  assert.throws(() => checkUpstream({ ...base, exec: gh({ status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n' }) }), /could not read the latest release: gh: Bad credentials/)
  const plan = checkUpstream({ ...base, exec: gh({ status: 0, stdout: JSON.stringify(release()), stderr: '' }) })
  assert.equal(plan.upgrade, true)
  assert.match(readFileSync(bodyFile, 'utf8'), /New things/)
})
