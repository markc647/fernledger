// public/text-size-init.js runs before first paint (an external file, because the CSP forbids inline scripts), so it
// can't import src/lib/text-size.ts. This pins the two together: same storage key, same answer for every input.
// It also pins the percentages in src/lib/text-size.ts to the rules in src/index.css.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { parseTextSize, TEXT_SIZE_STORAGE_KEY, TEXT_SIZES } from '../src/lib/text-size.ts'

const script = readFileSync(new URL('../public/text-size-init.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** Runs the script against a fake page; returns the data-text-size it set (null if it set none) and the key it read. */
function run({ stored, storageThrows = false, noStorage = false }) {
  const keysRead = []
  let attribute = null
  const context = {
    document: { documentElement: { setAttribute: (name, value) => name === 'data-text-size' && (attribute = value) } },
  }
  if (!noStorage) {
    context.localStorage = {
      getItem(key) {
        keysRead.push(key)
        if (storageThrows) throw new Error('blocked')
        return stored
      },
    }
  }
  vm.runInNewContext(script, context)
  return { attribute, keysRead }
}

test('reads the same storage key as the app', () => {
  assert.deepEqual(run({ stored: null }).keysRead, [TEXT_SIZE_STORAGE_KEY])
})

for (const stored of [null, '', 'a', 'a-plus', 'a-plus-plus', 'A+', 'huge']) {
  test(`stored ${JSON.stringify(stored)} sets what text-size.ts picks`, () => {
    assert.equal(run({ stored }).attribute, parseTextSize(stored))
  })
}

test('uses the standard size when storage is blocked', () => {
  assert.equal(run({ stored: null, storageThrows: true }).attribute, 'a')
})

test('uses the standard size when there is no storage object', () => {
  assert.equal(run({ stored: null, noStorage: true }).attribute, 'a')
})

for (const { value, percent } of TEXT_SIZES) {
  test(`index.css makes ${value} ${percent}% of the browser's text size`, () => {
    const rule = new RegExp(`html\\[data-text-size="${value}"\\]\\s*\\{\\s*font-size:\\s*${percent}%`)
    assert.match(css, rule)
  })
}
