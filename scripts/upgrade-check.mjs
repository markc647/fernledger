// The logic behind .github/workflows/upgrade-check.yml, which Deploy-button copies run weekly (README: Updating).
// The workflow talks to GitHub; this decides and prepares, so it can be tested without GitHub.
//
//   node scripts/upgrade-check.mjs plan <release.json> <pr-body.md>
//       Compares package.json's version with the upstream's latest release (the JSON from GitHub's
//       "latest release" API). Writes upgrade=true|false and, when true, tag, branch and title to $GITHUB_OUTPUT,
//       and the pull request body to <pr-body.md>.
//   node scripts/upgrade-check.mjs apply <source> <tag> <pr-body.md>
//       Fetches the tag from <source> and stages the release over the working tree. The workflow commits it.
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

/** [major, minor, patch] for a plain `vMAJOR.MINOR.PATCH` release tag; null for anything else, pre-releases included. */
export const parseTag = (tag) => (TAG.exec(tag) ? TAG.exec(tag).slice(1).map(Number) : null)

export const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const expectation = (latest, current) => {
  if (latest[0] > current[0]) return '**This is a major release. Read the upgrade notes below before you merge: it may need manual steps.**'
  if (latest[1] > current[1]) return 'This is a minor release: new features, no manual steps.'
  return 'This is a patch release: fixes only.'
}

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
    'Review the changes and the release notes, then merge. Cloudflare deploys your copy when the default branch changes.',
    `## Release notes\n\n${notes}`,
    `Release page: ${release.html_url}`,
    `Opened by \`${WORKFLOWS}upgrade-check.yml\`. If you close this pull request without merging, this release is skipped, and the next release opens a new one.`,
  ].join('\n\n')
  return { upgrade: true, tag, branch: `fernledger-update/${tag}`, title: `Update Fernledger to ${version}`, body: `${body}\n` }
}

function git(repoDir, args, input) {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], { cwd: repoDir, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
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
  const gone = have.filter((path) => !wanted.includes(path))
  if (gone.length) git(repoDir, ['rm', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], nulInput(gone))
  if (wanted.length) git(repoDir, ['checkout', 'FETCH_HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], nulInput(wanted))

  const changedWorkflows = nulList(git(repoDir, ['diff', '--name-only', '--diff-filter=AM', '-z', 'HEAD', 'FETCH_HEAD', '--', WORKFLOWS]))
  return { changedWorkflows }
}

const workflowNote = (files) =>
  `\n## Workflow files changed\n\nGitHub does not let this action change workflow files, so these were left as they are in your copy. Compare them with the release and copy the changes in by hand if you want them:\n\n${files.map((f) => `- \`${f}\``).join('\n')}\n`

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === 'plan' && args.length === 2) {
      const [releaseFile, bodyFile] = args
      const plan = planUpgrade({
        currentVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
        release: JSON.parse(readFileSync(releaseFile, 'utf8')),
      })
      if (plan.upgrade) writeFileSync(bodyFile, plan.body)
      const lines = plan.upgrade ? [`upgrade=true`, `tag=${plan.tag}`, `branch=${plan.branch}`, `title=${plan.title}`] : ['upgrade=false']
      appendFileSync(process.env.GITHUB_OUTPUT ?? '/dev/stdout', `${lines.join('\n')}\n`)
      if (!plan.upgrade) console.log(`upgrade-check: nothing to do, ${plan.reason}.`)
    } else if (command === 'apply' && args.length === 3) {
      const [source, tag, bodyFile] = args
      const { changedWorkflows } = applyRelease({ repoDir: process.cwd(), source, tag })
      if (changedWorkflows.length) appendFileSync(bodyFile, workflowNote(changedWorkflows))
      console.log(`upgrade-check: staged ${tag}.`)
    } else {
      console.error('Usage: node scripts/upgrade-check.mjs plan <release.json> <pr-body.md>\n       node scripts/upgrade-check.mjs apply <source> <tag> <pr-body.md>')
      process.exit(2)
    }
  } catch (error) {
    console.error(`upgrade-check: ${error.message}`)
    process.exit(1)
  }
}
