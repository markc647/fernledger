// public/theme-init.js runs before first paint (an external file, because the CSP forbids inline scripts), so it
// can't import src/lib/theme.ts. This pins the two together: same storage key, same answer for every input.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { parsePreference, resolveTheme, THEME_STORAGE_KEY } from '../src/lib/theme.ts'

const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8')

/** Runs the script against a fake page; returns whether it put the `dark` class on <html>, and the key it read. */
function run({ stored, systemDark, storageThrows = false }) {
  const keysRead = []
  let dark = null
  vm.runInNewContext(script, {
    localStorage: {
      getItem(key) {
        keysRead.push(key)
        if (storageThrows) throw new Error('blocked')
        return stored
      },
    },
    matchMedia: (query) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark }),
    document: { documentElement: { classList: { toggle: (_name, on) => (dark = on) } } },
  })
  return { dark, keysRead }
}

test('reads the same storage key as the app', () => {
  assert.deepEqual(run({ stored: null, systemDark: false }).keysRead, [THEME_STORAGE_KEY])
})

for (const stored of [null, '', 'system', 'light', 'dark', 'solarized']) {
  for (const systemDark of [true, false]) {
    test(`stored ${JSON.stringify(stored)} on a ${systemDark ? 'dark' : 'light'} device picks what theme.ts picks`, () => {
      const expected = resolveTheme(parsePreference(stored), systemDark) === 'dark'
      assert.equal(run({ stored, systemDark }).dark, expected)
    })
  }
}

test('follows the device when storage is blocked', () => {
  assert.equal(run({ stored: null, systemDark: true, storageThrows: true }).dark, true)
  assert.equal(run({ stored: null, systemDark: false, storageThrows: true }).dark, false)
})
