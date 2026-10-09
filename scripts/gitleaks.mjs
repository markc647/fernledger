// Fetches one pinned gitleaks release, checks it against the SHA-256 pinned below, and caches it
// outside the repo. Nothing else in the repo downloads or runs unverified binaries.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// 8.24.3 is the version gitleaks-action@v2 runs, so local and CI findings agree.
// To upgrade: change VERSION and copy the new values from
// https://github.com/gitleaks/gitleaks/releases/download/v<VERSION>/gitleaks_<VERSION>_checksums.txt
export const VERSION = '8.24.3'
const SHA256 = {
  'darwin_arm64.tar.gz': 'b90f13bb8c90ab72083d9b0c842e39dafb82c0e5c3f872f407366b7a58909013',
  'darwin_x64.tar.gz': '41c44ae8ad1d6eef57d4526ad0fd67d8129eee9a856f55c2b3b9395fd3d9ec0f',
  'linux_arm64.tar.gz': '5f2edbe1f49f7b920f9e06e90759947d3c5dfc16f752fb93aaafc17e9d14cf07',
  'linux_x64.tar.gz': '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c',
  'windows_x64.zip': '3f1a35578631dbfe633cc5b49e6c906e55ff14a4bfd7336a10fb27fe33b6dcd2',
}
const OS = { win32: 'windows', darwin: 'darwin', linux: 'linux' }
const ARCH = { x64: 'x64', arm64: 'arm64' }

export function assetFor(platform, arch) {
  const suffix = `${OS[platform]}_${ARCH[arch]}${platform === 'win32' ? '.zip' : '.tar.gz'}`
  if (!OS[platform] || !ARCH[arch] || !SHA256[suffix]) {
    throw new Error(`Unsupported platform for gitleaks ${VERSION}: ${platform}/${arch}`)
  }
  const name = `gitleaks_${VERSION}_${suffix}`
  return { name, sha256: SHA256[suffix], url: `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${name}` }
}

export function verifySha256(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`)
}


export const binaryName = (platform = process.platform) => (platform === 'win32' ? 'gitleaks.exe' : 'gitleaks')

/** The `--config <path>` argument, defaulting to the repo's .gitleaks.toml. */
export function configFromArgs(args) {
  const i = args.indexOf('--config')
  return resolve(i >= 0 ? args[i + 1] : '.gitleaks.toml')
}

export function cacheRoot(platform = process.platform, env = process.env, home = homedir()) {
  if (env.FERNLEDGER_CACHE_DIR) return env.FERNLEDGER_CACHE_DIR
  const base =
    platform === 'win32' ? (env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? join(home, 'Library', 'Caches')
    : (env.XDG_CACHE_HOME ?? join(home, '.cache'))
  return join(base, 'fernledger')
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Returns the path to the verified gitleaks binary, downloading it on first use or if the cached copy changed. */
export async function ensureGitleaks() {
  const asset = assetFor(process.platform, process.arch)
  const dir = join(cacheRoot(), 'gitleaks', VERSION)
  const bin = join(dir, binaryName())
  const sidecar = `${bin}.sha256` // hash of the extracted binary, recorded when we verified and extracted it
  if (existsSync(bin)) {
    if (existsSync(sidecar) && sha256Of(bin) === readFileSync(sidecar, 'utf8').trim()) return bin
    console.error('Cached gitleaks failed verification; replacing it.')
  }

  console.error(`Downloading ${asset.name} (cached in ${dir})`)
  const res = await fetch(asset.url)
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${asset.url}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  verifySha256(bytes, asset.sha256)

  mkdirSync(join(cacheRoot(), 'gitleaks'), { recursive: true })
  const work = mkdtempSync(join(cacheRoot(), 'gitleaks', 'dl-'))
  try {
    writeFileSync(join(work, asset.name), bytes)
    // Windows ships bsdtar, which also reads zip. Call it by full path so Git Bash's GNU tar isn't picked up.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar'
    const out = spawnSync(tar, ['-xf', asset.name], { cwd: work, encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`Could not extract ${asset.name}: ${out.stderr || out.error}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    renameSync(join(work, binaryName()), bin)
    writeFileSync(sidecar, sha256Of(bin))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return bin
}
