// public/text-size-init.js runs before first paint (an external file, because the CSP forbids inline scripts), so it
// can't import src/lib/text-size.ts. This pins the two together: same storage keys, same answer for every input.
// It also pins the percentages in src/lib/text-size.ts to the rules in src/index.css.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { EARLIER_TEXT_SIZE_STORAGE_KEY, parseTextSize, TEXT_SIZE_STORAGE_KEY, TEXT_SIZES } from '../src/lib/text-size.ts'

const script = readFileSync(new URL('../public/text-size-init.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** Runs the script against a fake page; returns the data-text-size it set (null if it set none) and the keys it read. `saved` and `earlier` are what is under each key. */
function run({ saved = null, earlier = null, storageThrows = false, noStorage = false, touch = false }) {
  const keysRead = []
  let attribute = null
  const context = {
    document: { documentElement: { setAttribute: (name, value) => name === 'data-text-size' && (attribute = value) } },
    matchMedia: (query) => ({ matches: touch && query === '(pointer: coarse)' }),
  }
  if (!noStorage) {
    context.localStorage = {
      getItem(key) {
        keysRead.push(key)
        if (storageThrows) throw new Error('blocked')
        return { [TEXT_SIZE_STORAGE_KEY]: saved, [EARLIER_TEXT_SIZE_STORAGE_KEY]: earlier }[key] ?? null
      },
    }
  }
  vm.runInNewContext(script, context)
  return { attribute, keysRead }
}

test('reads the same storage keys as the app: its own, then the one the earlier controls used', () => {
  assert.deepEqual(run({}).keysRead, [TEXT_SIZE_STORAGE_KEY, EARLIER_TEXT_SIZE_STORAGE_KEY])
})

test('the keys are two different keys', () => {
  assert.notEqual(TEXT_SIZE_STORAGE_KEY, EARLIER_TEXT_SIZE_STORAGE_KEY)
})

// 'a', 'a-plus' and 'a-plus-plus' are what the first control (A / A+ / A++) saved, and 'large' what the three-size control saved for 20px: they still read as Medium, Xtra Large, Xtra Large and Xtra Large.
const values = [null, '', 'small', 'medium', 'large', 'xlarge', 'a', 'a-plus', 'a-plus-plus', 'A+', 'huge', 'constructor', '__proto__', 'toString']
for (const saved of values) {
  test(`saved ${JSON.stringify(saved)}, with anything under the earlier key, sets what text-size.ts picks`, () => {
    for (const earlier of values) {
      for (const touch of [false, true]) assert.equal(run({ saved, earlier, touch }).attribute, parseTextSize(saved, earlier, touch), `earlier ${JSON.stringify(earlier)}, touch ${touch}`)
    }
  })
}

test('a size saved by the three-size or the first control reads as Xtra Large, or Medium for A', () => {
  assert.equal(run({ earlier: 'large' }).attribute, 'xlarge')
  assert.equal(run({ earlier: 'a-plus' }).attribute, 'xlarge')
  assert.equal(run({ earlier: 'a-plus-plus' }).attribute, 'xlarge')
  assert.equal(run({ earlier: 'a' }).attribute, 'medium')
})

test('keeps Small and Medium from the earlier control', () => {
  assert.equal(run({ earlier: 'small' }).attribute, 'small')
  assert.equal(run({ earlier: 'medium' }).attribute, 'medium')
})

test('the new Large is Large, not the Large the earlier control saved', () => {
  assert.equal(run({ saved: 'large' }).attribute, 'large')
  assert.equal(run({ saved: 'large', earlier: 'large' }).attribute, 'large')
  assert.equal(run({ saved: 'xlarge' }).attribute, 'xlarge')
})

test('uses the default size, Small, when storage is blocked', () => {
  assert.equal(run({ storageThrows: true }).attribute, 'small')
  assert.equal(run({ storageThrows: true, touch: true }).attribute, 'medium')
})

test('uses the default size, Small, when there is no storage object', () => {
  assert.equal(run({ noStorage: true }).attribute, 'small')
})

for (const { value, percent } of TEXT_SIZES) {
  test(`index.css makes ${value} ${percent}% of the browser's text size`, () => {
    const rule = new RegExp(`html\\[data-text-size="${value}"\\]\\s*\\{\\s*font-size:\\s*${percent}%`)
    assert.match(css, rule)
  })
}
