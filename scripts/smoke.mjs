// The smoke check `npm run deploy` runs after a deploy, through an Access service token (docs/setup.md, "Smoke check").
// It proves three things: Access lets the token in and the site serves this build; the Worker refuses the token's
// identity, which has no email (ADR 0002); and without the token nothing of the app is served.
// It prints status codes only, never the token or a response body.
import { readFileSync } from 'node:fs'

export const SMOKE_ENV = ['FERNLEDGER_URL', 'FERNLEDGER_SMOKE_ID', 'FERNLEDGER_SMOKE_SECRET']

/** The settings from the environment, or the names that are missing. */
export function smokeSettings(env = process.env) {
  const missing = SMOKE_ENV.filter((name) => !env[name])
  if (missing.length) return { missing }
  const url = URL.parse(env.FERNLEDGER_URL)
  if (url?.protocol !== 'https:') return { problem: 'FERNLEDGER_URL must be the site\'s address, starting https://.' }
  return { origin: url.origin, clientId: env.FERNLEDGER_SMOKE_ID, clientSecret: env.FERNLEDGER_SMOKE_SECRET }
}

/** The address of the build's entry script, from the built index.html: the live page must name the same one. */
export function builtEntryScript(html) {
  return html.match(/<script type="module"[^>]*\ssrc="([^"]+)"/)?.[1] ?? null
}

export const readBuiltEntryScript = (path) => builtEntryScript(readFileSync(path, 'utf8'))

async function get(fetchFn, url, headers = {}) {
  try {
    const response = await fetchFn(url, { headers, redirect: 'manual' })
    return { status: response.status, body: response.status === 200 ? await response.text() : '' }
  } catch (e) {
    return { status: 0, error: e?.cause?.code ?? e?.name ?? 'Error' }
  }
}

const seen = (r) => (r.status ? `got ${r.status}` : `could not connect (${r.error})`)

/** Runs the three checks once. Returns what failed, as sentences; none means it passed. */
export async function smokeCheck({ origin, clientId, clientSecret, entryScript }, fetchFn = fetch) {
  const token = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }
  const failed = []
  const page = await get(fetchFn, `${origin}/`, token)
  if (page.status !== 200) failed.push(`The page with the service token: expected 200, ${seen(page)}. Check the token and the Access application's Service Auth policy.`)
  else if (!page.body.includes(`src="${entryScript}"`)) failed.push('The page with the service token is not this build: it does not name this build\'s entry script.')
  const me = await get(fetchFn, `${origin}/api/me`, token)
  if (me.status !== 401) failed.push(`/api/me with the service token: expected 401 from the Worker (the token has no email), ${seen(me)}.`)
  const open = await get(fetchFn, `${origin}/`)
  if (open.status === 0) failed.push(`The page without the token: ${seen(open)}.`)
  else if (open.status === 200 && open.body.includes(`src="${entryScript}"`)) failed.push('The page without the token served the app: Access is not in front of it.')
  return failed
}

/** Runs the check until it passes, as a new version can take a few seconds to be served everywhere. */
export async function smokeCheckWithRetries(settings, { fetchFn = fetch, tries = 4, waitMs = 5000 } = {}) {
  let failed = []
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((done) => setTimeout(done, waitMs))
    failed = await smokeCheck(settings, fetchFn)
    if (!failed.length) break
  }
  return failed
}
