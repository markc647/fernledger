// Run with `npm run test:scripts`. The "Add to Home Screen" promise (README): the app opens like an app with its own
// icon, and that is all. No service worker (so no offline mode), no push. e2e/member-pages.spec.ts checks the same files
// as the browser receives them, under the real headers.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { SECURITY_HEADERS } from '../worker/security-headers.ts'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'))
const html = readFileSync(join(root, 'index.html'), 'utf8')

/** Width and height from a PNG's header, or null if the file isn't a PNG. */
function pngSize(path) {
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('the manifest opens the app as an app, from its own address', () => {
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.name, 'Fernledger') // the app title is a runtime Setting; a static file can only carry the default
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i)
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i)
})

test('every icon is a real square PNG of the size the manifest says', () => {
  assert.ok(manifest.icons.length >= 3)
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/[^/]+\.png$/, icon.src)
    const path = join(root, 'public', icon.src)
    assert.ok(existsSync(path), `${icon.src} is missing`)
    const [width, height] = icon.sizes.split('x').map(Number)
    assert.deepEqual(pngSize(path), { width, height }, icon.src)
    assert.equal(width, height)
  }
})

test('there is a plain icon at 192 and 512, and a maskable one, which phones need to draw the icon well', () => {
  const find = (size, purpose) => manifest.icons.find((i) => i.sizes === `${size}x${size}` && (i.purpose ?? 'any') === purpose)
  assert.ok(find(192, 'any'))
  assert.ok(find(512, 'any'))
  assert.ok(find(512, 'maskable'))
})

test('the page links the manifest with credentials, because Cloudflare Access sits in front of it', () => {
  // Without cookies the browser's manifest request would be sent to the Access login page instead of getting the file.
  assert.match(html, /<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"[^>]*crossorigin="use-credentials"/)
  const touch = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*href="(\/[^"]+\.png)"/)
  assert.ok(touch, 'no apple-touch-icon')
  assert.ok(existsSync(join(root, 'public', touch[1])))
})

test('the CSP lets the page load the manifest and its icons from itself', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy']
  assert.match(csp, /manifest-src 'self'/)
  assert.match(csp, /img-src 'self'/)
})

test('there is no service worker, offline cache or push in the app', () => {
  assert.equal(manifest.serviceworker, undefined)
  assert.equal(manifest.gcm_sender_id, undefined)
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'generated' ? [] : files(join(dir, e.name))) : [join(dir, e.name)]))
  const sources = [...files(join(root, 'src')), ...files(join(root, 'public')), join(root, 'index.html')].filter((f) => /\.(tsx?|jsx?|html|webmanifest)$/.test(f))
  for (const file of sources) {
    if (/\.test\.tsx?$/.test(file)) continue
    assert.doesNotMatch(readFileSync(file, 'utf8'), /serviceWorker|PushManager|requestPermission|workbox/i, file)
  }
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys({ ...dependencies, ...devDependencies }).filter((name) => /workbox|vite-plugin-pwa|serwist/.test(name)), [])
})
