// Run with `npm run test:scripts`. The browser tests (e2e/) run in a light and a dark project against ONE local database, so a spec that creates
// Accounts gives each project numbers of its own, and no two specs may use the same number: Import does not ask for a name when the Account already
// exists, so a spec that finds another's Account fails far from the cause. e2e/account-numbers.json says which two-digit suffixes (the NN of
// 99-9999-9999999-NN) each spec has; pick unused ones from there when a spec needs an Account. This test fails if two specs claim the same suffix, if a spec
// uses a number it has not claimed, or if a claim is no longer in its spec.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const dir = new URL('../e2e/', import.meta.url)

/** The suffixes a spec's text puts in an Account number: in full (`99-9999-9999999-NN`), in an ASB header (`Account 9999999-NN`), or as the quoted suffix a spec builds one from. */
const written = (text) => new Set([...text.matchAll(/9999999-(\d\d)\b/g)].map((m) => Number(m[1])))
const quoted = (text, suffix) => new RegExp(`['"]${suffix}['"]`).test(text)

/** The problems with `claims` (spec file name to its suffixes) against `texts` (spec file name to its text); `mentioned` are numbers any spec may write as text, not as an Account. */
export function problems(claims, texts, mentioned) {
  const found = []
  const owner = new Map()
  for (const [spec, suffixes] of Object.entries(claims)) {
    for (const suffix of suffixes) {
      if (owner.has(suffix)) found.push(`${spec} and ${owner.get(suffix)} both have the Account number suffix ${suffix}`)
      owner.set(suffix, spec)
      if (!(spec in texts)) found.push(`${spec} is in the registry but there is no such spec`)
      else if (!written(texts[spec]).has(suffix) && !quoted(texts[spec], suffix)) found.push(`${spec} no longer uses the Account number suffix ${suffix} it has`)
    }
  }
  for (const [spec, text] of Object.entries(texts)) {
    for (const suffix of written(text)) {
      if (!(claims[spec] ?? []).includes(suffix) && !mentioned.includes(suffix)) found.push(`${spec} uses the Account number suffix ${suffix}, which is not its own in e2e/account-numbers.json`)
    }
  }
  return found
}

const registry = JSON.parse(readFileSync(new URL('account-numbers.json', dir), 'utf8'))
const texts = Object.fromEntries(
  readdirSync(dir)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]),
)

test('every e2e spec has its own Account number suffixes, and says so in e2e/account-numbers.json', () => {
  assert.deepEqual(problems(registry.specs, texts, registry.mentionedOnly), [])
})

test('the check notices two specs with the same suffix, a number a spec has not claimed, and a claim that is gone', () => {
  const claims = { 'a.spec.ts': [40, 41], 'b.spec.ts': [41, 42] }
  const text = { 'a.spec.ts': "number: '99-9999-9999999-40', other: '99-9999-9999999-41'", 'b.spec.ts': "number: '99-9999-9999999-41', other: '99-9999-9999999-43'" }
  const found = problems(claims, text, [])
  assert.ok(found.some((line) => line.includes('both have the Account number suffix 41')), found.join('\n'))
  assert.ok(found.some((line) => line.includes('b.spec.ts uses the Account number suffix 43')), found.join('\n'))
  assert.ok(found.some((line) => line.includes('b.spec.ts no longer uses the Account number suffix 42')), found.join('\n'))
  assert.deepEqual(problems({ 'a.spec.ts': [40] }, { 'a.spec.ts': "dark ? '40' : '41'" }, [41]), [])
})
