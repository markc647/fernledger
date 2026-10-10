// Run with `npm run test:scripts`. The browser tests (e2e/) run in a light and a dark project against ONE local database, so a spec that creates
// Accounts gives each project numbers of its own, and no two specs may use the same number: Import does not ask for a name when the Account already
// exists, so a spec that finds another's Account fails far from the cause. e2e/account-numbers.json says which two-digit suffixes (the NN of
// 99-9999-9999999-NN) each spec has; pick unused ones from there when a spec needs an Account. This test fails if two specs claim the same suffix, if a spec
// uses a number it has not claimed, or if a claim is no longer in its spec.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const dir = new URL('../e2e/', import.meta.url)

const quotedPairs = (text) => [...text.matchAll(/['"](\d\d)['"]/g)].map((m) => Number(m[1]))

/**
 * The suffixes a spec's text puts in an Account number. The forms the specs use:
 *  - in full, `99-9999-9999999-NN`, or in an ASB header, `Account 9999999-NN`;
 *  - built in a template, `9999999-${dark ? '52' : '50'}`, or by concatenation, `'99-9999-9999999-' + (dark ? '52' : '50')`: the quoted two-digit strings of the expression;
 *  - built by a helper with "suffix" in its name (`const suffix = (…) => … ? '92' : '93'`, `const suffixes = … { small: '96', big: '94' } …`), whose
 *    value a template then names: the quoted two-digit strings of the helper's definition line.
 */
export function written(text) {
  const found = new Set([...text.matchAll(/9999999-(\d\d)\b/g)].map((m) => Number(m[1])))
  for (const m of text.matchAll(/9999999-(?:\$\{([^}]*)\}|['"`]\s*\+\s*([^\n]*))/g)) for (const n of quotedPairs(m[1] ?? m[2] ?? '')) found.add(n)
  for (const m of text.matchAll(/^[^\S\n]*(?:export\s+)?(?:const|let|function)\s+\w*[sS]uffix\w*[^\n]*$/gm)) for (const n of quotedPairs(m[0])) found.add(n)
  return found
}

/** The problems with `claims` (spec file name to its suffixes) against `texts` (spec file name to its text); `mentioned` are numbers any spec may write as text, not as an Account. */
export function problems(claims, texts, mentioned) {
  const found = []
  const owner = new Map()
  for (const [spec, suffixes] of Object.entries(claims)) {
    for (const suffix of suffixes) {
      if (owner.has(suffix)) found.push(`${spec} and ${owner.get(suffix)} both have the Account number suffix ${suffix}`)
      owner.set(suffix, spec)
      if (!(spec in texts)) found.push(`${spec} is in the registry but there is no such spec`)
      else if (!written(texts[spec]).has(suffix)) found.push(`${spec} no longer uses the Account number suffix ${suffix} it has`)
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

test('every form the specs build an Account number in is found', () => {
  const forms = {
    full: "number: '99-9999-9999999-40'",
    header: "'Bank 99; Branch 9999; Account 9999999-41 (Example)'",
    templateTernary: 'number: `99-9999-9999999-${dark ? \'52\' : \'50\'}`',
    headerTernary: "const savingsNumber = `9999999-${dark ? '53' : '51'}`",
    concatenation: "number: '99-9999-9999999-' + (dark ? '62' : '60')",
    helper: "const suffix = (testInfo: { project: { name: string } }) => (testInfo.project.name === 'dark' ? '92' : '93')",
    helperObject: "const suffixes = (testInfo) => (isDark(testInfo) ? { small: '96', big: '94' } : { small: '97', big: '95' })",
    exported: "export const accountSuffix = () => '44'",
  }
  assert.deepEqual([...written(forms.full)], [40])
  assert.deepEqual([...written(forms.header)], [41])
  assert.deepEqual([...written(forms.templateTernary)].sort(), [50, 52])
  assert.deepEqual([...written(forms.headerTernary)].sort(), [51, 53])
  assert.deepEqual([...written(forms.concatenation)].sort(), [60, 62])
  assert.deepEqual([...written(forms.helper)].sort(), [92, 93])
  assert.deepEqual([...written(forms.helperObject)].sort(), [94, 95, 96, 97])
  assert.deepEqual([...written(forms.exported)], [44])
  // Two-digit strings that are not in an Account number are left alone.
  assert.deepEqual([...written("await field.fill('50'); expect(bar).toHaveAttribute('value', '50')")], [])
})

test('the check notices two specs with the same suffix, a number a spec has not claimed, and a claim that is gone', () => {
  const claims = { 'a.spec.ts': [40, 41], 'b.spec.ts': [41, 42] }
  const text = { 'a.spec.ts': "number: '99-9999-9999999-40', other: '99-9999-9999999-41'", 'b.spec.ts': "number: '99-9999-9999999-41', other: '99-9999-9999999-43'" }
  const found = problems(claims, text, [])
  assert.ok(found.some((line) => line.includes('both have the Account number suffix 41')), found.join('\n'))
  assert.ok(found.some((line) => line.includes('b.spec.ts uses the Account number suffix 43')), found.join('\n'))
  assert.ok(found.some((line) => line.includes('b.spec.ts no longer uses the Account number suffix 42')), found.join('\n'))
  assert.deepEqual(problems({ 'a.spec.ts': [40, 41] }, { 'a.spec.ts': "number: `99-9999-9999999-${dark ? '40' : '41'}`" }, []), [])
})

test('a template that builds a number from the range another spec has is caught', () => {
  // The carry-over test once used these, and report-balances.spec.ts has 51 to 56.
  const claims = { 'transfers.spec.ts': [44, 45, 46, 47], 'report-balances.spec.ts': [51, 52, 53] }
  const text = {
    'transfers.spec.ts': "const everyday = { number: `99-9999-9999999-${dark ? '52' : '50'}` }; const savingsNumber = `9999999-${dark ? '53' : '51'}`",
    'report-balances.spec.ts': "savings: { number: light ? '99-9999-9999999-51' : '99-9999-9999999-52' }, other: '99-9999-9999999-53'",
  }
  const found = problems(claims, text, [])
  assert.ok(found.some((line) => line.includes('transfers.spec.ts uses the Account number suffix 51')), found.join('\n'))
  assert.ok(found.some((line) => line.includes('transfers.spec.ts no longer uses the Account number suffix 44')), found.join('\n'))
})
