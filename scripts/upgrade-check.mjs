// The logic behind .github/workflows/upgrade-check.yml, which Deploy-button copies run weekly (README: Updating).
// The workflow only calls this; this decides, prepares and talks to GitHub through `gh`, so it can be tested without
// GitHub. Keep the logic here: a copy receives this file in an update, but never a workflow file (GitHub refuses
// workflow changes from Actions).
//
//   node scripts/upgrade-check.mjs plan <release.json> <pr-body.md>
//       Compares package.json's version with the upstream's latest release (the JSON from GitHub's
//       "latest release" API). Writes upgrade=true|false and, when true, tag, branch and title to $GITHUB_OUTPUT
//       (stdout when it is not set), and the pull request body to <pr-body.md>.
//   node scripts/upgrade-check.mjs check <owner/repo> <pr-body.md>
//       Asks GitHub (gh) for the upstream's latest release, then does what `plan` does. No release yet is not an error.
//   node scripts/upgrade-check.mjs apply <source> <tag> <pr-body.md>
//       Fetches the tag from <source> and stages the release over the working tree. Does not commit.
//   node scripts/upgrade-check.mjs open <source> <tag> <branch> <base> <title> <pr-body.md>
//       Skips if a pull request for <branch> exists (open, merged or closed). Otherwise it branches from the working
//       tree, applies the release, commits, force-pushes <branch> and opens the pull request.
//
// A Deploy-button copy is a new repository, not a fork, so it shares no history with the upstream and a merge
// would conflict on every file. The pull request instead replaces the copy's tracked files with the release's.
// Anything else (untracked files, the copy's own workflows) is left alone, and the diff is there to review.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const WORKFLOWS = '.github/workflows/'
/** GitHub caps a pull request body at 65,536 characters. */
const NOTES_LIMIT = 60_000
/** Said when GitHub refuses `gh pr create`: the "Allow GitHub Actions to create and approve pull requests" setting is off by default. */
export const PR_REFUSED =
  'Could not open the pull request. Turn on Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create and approve pull requests, then run this workflow again.'
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com']

/** [major, minor, patch] for a plain `vMAJOR.MINOR.PATCH` release tag; null for anything else, pre-releases included. */
export const parseTag = (tag) => (TAG.exec(tag) ? TAG.exec(tag).slice(1).map(Number) : null)

export const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const expectation = (latest, current) => {
  if (latest[0] > current[0]) return '**This is a major release. Read the upgrade notes below before you merge: it may need manual steps.**'
  if (latest[1] > current[1]) return 'This is a minor release: new features, no manual steps.'
  return 'This is a patch release: fixes only.'
}

const DEPLOY_STEP =
  '**Merging does not change your database.** Run `npm run deploy` from the merged commit: that is the step that takes the pre-deploy backup, records the restore point and applies the database migrations, then deploys. If a Cloudflare build already deploys your copy when the default branch changes, it skips those steps, so run `npm run deploy` as well (or instead).'

/**
 * Decides whether the copy is behind. `release` is GitHub's latest-release JSON. Returns { upgrade: false, reason },
 * or { upgrade: true, tag, branch, title, body } for the pull request.
 */
export function planUpgrade({ currentVersion, release }) {
  const current = VERSION.exec(currentVersion)?.slice(1).map(Number)
  if (!current) throw new Error(`package.json's version "${currentVersion}" is not MAJOR.MINOR.PATCH`)
  const latest = release.draft || release.prerelease ? null : parseTag(release.tag_name)
  if (!latest) return { upgrade: false, reason: 'the latest release is a draft, a pre-release or not a plain version tag' }
  if (compareVersions(latest, current) <= 0) return { upgrade: false, reason: 'this copy is up to date' }

  const tag = release.tag_name
  const version = tag.slice(1)
  let notes = String(release.body ?? '').trim() || 'No release notes were published.'
  if (notes.length > NOTES_LIMIT) notes = `${notes.slice(0, NOTES_LIMIT)}\n\n(Release notes cut short: see the release page for the rest.)`
  const body = [
    `Fernledger ${version} is out. This pull request brings your copy from ${currentVersion} up to it.`,
    expectation(latest, current),
    `Review the changes and the release notes, then merge. ${DEPLOY_STEP}`,
    `## Release notes\n\n${notes}`,
    `Release page: ${release.html_url}`,
    `Opened by \`${WORKFLOWS}upgrade-check.yml\`. If you close this pull request without merging, this release is skipped, and the next release opens a new one.`,
  ].join('\n\n')
  return { upgrade: true, tag, branch: `fernledger-update/${tag}`, title: `Update Fernledger to ${version}`, body: `${body}\n` }
}

function git(repoDir, args, input) {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], { cwd: repoDir, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}
const nulList = (text) => text.split('\0').filter(Boolean)
const outsideWorkflows = (path) => !path.startsWith(WORKFLOWS)
const nulInput = (paths) => paths.map((p) => `${p}\0`).join('')

/**
 * Fetches `tag` from `source` and stages it over the working tree in `repoDir`: files the release has are written,
 * tracked files it no longer has are removed. Workflow files are never touched, because GitHub refuses a push from
 * Actions that changes them; the ones that differ are returned so the pull request can say so.
 * Returns { changedWorkflows }.
 */
export function applyRelease({ repoDir, source, tag }) {
  if (!parseTag(tag)) throw new Error(`"${tag}" is not a release tag (vMAJOR.MINOR.PATCH)`)
  if (git(repoDir, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('the working tree has uncommitted changes')

  git(repoDir, ['fetch', '--quiet', '--depth=1', '--no-tags', '--', source, `refs/tags/${tag}`])
  const packaged = JSON.parse(git(repoDir, ['show', 'FETCH_HEAD:package.json'])).version
  if (packaged !== tag.slice(1)) throw new Error(`${tag} is not releasable: its package.json says ${packaged}, so a copy would never see itself as up to date`)

  const wanted = nulList(git(repoDir, ['ls-tree', '-r', '-z', '--name-only', 'FETCH_HEAD'])).filter(outsideWorkflows)
  const have = nulList(git(repoDir, ['ls-files', '-z'])).filter(outsideWorkflows)
  const wantedSet = new Set(wanted)
  const gone = have.filter((path) => !wantedSet.has(path))
  if (gone.length) git(repoDir, ['rm', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], nulInput(gone))
  if (wanted.length) git(repoDir, ['checkout', 'FETCH_HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], nulInput(wanted))

  const changedWorkflows = nulList(git(repoDir, ['diff', '--name-only', '--diff-filter=AM', '-z', 'HEAD', 'FETCH_HEAD', '--', WORKFLOWS]))
  return { changedWorkflows }
}

const workflowNote = (files) =>
  `\n## Workflow files changed\n\nGitHub does not let this action change workflow files, so these were left as they are in your copy. Compare them with the release and copy the changes in by hand if you want them:\n\n${files.map((f) => `- \`${f}\``).join('\n')}\n`

/** Runs `gh`; the default `exec` for check and open, replaced in tests so nothing reaches GitHub. */
const execute = (command, args, { cwd } = {}) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
const firstLine = (text) => text.trim().split(/\r?\n/)[0]

/** `planUpgrade` for the upstream's latest release, fetched with gh. No release yet (HTTP 404) means nothing to do. */
export function checkUpstream({ upstream, bodyFile, currentVersion, exec = execute }) {
  const latest = exec('gh', ['api', `repos/${upstream}/releases/latest`])
  if (latest.status !== 0) {
    if (/HTTP 404/.test(latest.stderr)) return { upgrade: false, reason: 'no release has been published yet' }
    throw new Error(`could not read the latest release: ${firstLine(latest.stderr)}`)
  }
  const plan = planUpgrade({ currentVersion, release: JSON.parse(latest.stdout) })
  if (plan.upgrade) writeFileSync(bodyFile, plan.body)
  return plan
}

/**
 * Opens the update pull request for `tag` unless one for `branch` already exists (open, merged or closed: a closed one
 * means the Deployer skipped this release). The branch is the bot's own, namespaced `fernledger-update/...`, and is
 * rebuilt on every run, so it is force-pushed: after a refused `gh pr create` the branch is already on the remote,
 * and a plain push on the next run would be a non-fast-forward every time. Returns { opened, reason }.
 */
export function openPullRequest({ repoDir, source, tag, branch, base, title, bodyFile, exec = execute }) {
  const existing = exec('gh', ['pr', 'list', '--state', 'all', '--head', branch, '--json', 'number', '--jq', 'length'], { cwd: repoDir })
  if (existing.status !== 0) throw new Error(`could not list pull requests: ${firstLine(existing.stderr)}`)
  if (existing.stdout.trim() !== '0') return { opened: false, reason: `a pull request for ${tag} already exists (open, merged or closed)` }

  git(repoDir, ['switch', '-C', branch])
  const { changedWorkflows } = applyRelease({ repoDir, source, tag })
  if (changedWorkflows.length) appendFileSync(bodyFile, workflowNote(changedWorkflows))
  git(repoDir, [...BOT, 'commit', '-q', '-m', `Update Fernledger to ${tag.slice(1)}`])
  git(repoDir, ['push', '--force', 'origin', branch])
  const created = exec('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile], { cwd: repoDir })
  if (created.status !== 0) throw new Error(`${PR_REFUSED} (GitHub said: ${firstLine(created.stderr) || 'nothing'})`)
  return { opened: true }
}

/** Step outputs go to $GITHUB_OUTPUT, or to stdout when run by hand (Windows has no /dev/stdout). */
function reportPlan(plan) {
  const lines = plan.upgrade ? ['upgrade=true', `tag=${plan.tag}`, `branch=${plan.branch}`, `title=${plan.title}`] : ['upgrade=false']
  const text = `${lines.join('\n')}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
  if (!plan.upgrade) console.log(`upgrade-check: nothing to do, ${plan.reason}.`)
}

const currentVersion = () => JSON.parse(readFileSync('package.json', 'utf8')).version

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === 'plan' && args.length === 2) {
      const [releaseFile, bodyFile] = args
      const plan = planUpgrade({ currentVersion: currentVersion(), release: JSON.parse(readFileSync(releaseFile, 'utf8')) })
      if (plan.upgrade) writeFileSync(bodyFile, plan.body)
      reportPlan(plan)
    } else if (command === 'check' && args.length === 2) {
      const [upstream, bodyFile] = args
      reportPlan(checkUpstream({ upstream, bodyFile, currentVersion: currentVersion() }))
    } else if (command === 'open' && args.length === 6) {
      const [source, tag, branch, base, title, bodyFile] = args
      const result = openPullRequest({ repoDir: process.cwd(), source, tag, branch, base, title, bodyFile })
      console.log(result.opened ? `upgrade-check: opened the pull request for ${tag}.` : `upgrade-check: nothing to do, ${result.reason}.`)
    } else if (command === 'apply' && args.length === 3) {
      const [source, tag, bodyFile] = args
      const { changedWorkflows } = applyRelease({ repoDir: process.cwd(), source, tag })
      if (changedWorkflows.length) appendFileSync(bodyFile, workflowNote(changedWorkflows))
      console.log(`upgrade-check: staged ${tag}.`)
    } else {
      console.error(
        [
          'Usage: node scripts/upgrade-check.mjs plan <release.json> <pr-body.md>',
          '       node scripts/upgrade-check.mjs check <owner/repo> <pr-body.md>',
          '       node scripts/upgrade-check.mjs apply <source> <tag> <pr-body.md>',
          '       node scripts/upgrade-check.mjs open <source> <tag> <branch> <base> <title> <pr-body.md>',
        ].join('\n'),
      )
      process.exit(2)
    }
  } catch (error) {
    // In Actions, ::error:: puts the message on the run's summary page.
    console.error(process.env.GITHUB_ACTIONS ? `::error::${error.message}` : `upgrade-check: ${error.message}`)
    process.exit(1)
  }
}
