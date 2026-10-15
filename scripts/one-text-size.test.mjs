// README, Accessibility: all text that is not a heading is exactly the size the text size control chose, in every part of the page. src/index.css makes Tailwind's `text-xs` and
// `text-sm` (which shadcn's components use for menus, buttons, captions and hints) that size, and this fails on anything that would keep text off it: a fixed font size anywhere in
// src/. Printed Reports have sizes of their own, in pt.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(join(root, 'src/index.css'), 'utf8')
const tailwindTheme = readFileSync(join(root, 'node_modules/tailwindcss/theme.css'), 'utf8')

/** The value of a custom property in a stylesheet (the last one written), or undefined. */
const token = (sheet, name) => [...sheet.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].at(-1)?.[1].trim()
const rem = (value) => (value?.endsWith('rem') ? parseFloat(value) : NaN)

/**
 * The fixed font sizes in a source file: an arbitrary Tailwind size (a length, or a `length:` custom property, in brackets or parentheses after `text-`, with any variants before it),
 * a `fontSize` set on an element or a chart, or a `font-size` in a stylesheet that is not one of the text size control's four rules. Not a colour, and not a size in pt behind `print:`
 * (a printed Report's type). Comments are not read: words about a size are not a size.
 */
export function fixedSizes(commented, file) {
  const source = commented.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const found = []
  for (const [whole, variants = '', bracket, paren] of source.matchAll(/(?<![\w-])((?:[\w[\]&>*.=-]+:)*)text-(?:\[([^\]\s]+)\]|\(([^)\s]+)\))/g)) {
    const value = bracket ?? paren
    const size = /^-?[\d.]+(px|rem|em|%|ch|vw|vh|vmin|vmax|cqw|pt|pc|mm|cm|in)$/.exec(value) ?? /^length:/.exec(value)
    if (!size) continue // a colour, or a custom property that is not said to be a length
    const printedInPt = /(^|:)print:/.test(variants) && size[1] === 'pt'
    if (!printedInPt) found.push(whole)
  }
  for (const match of source.matchAll(/\bfontSize\s*[:=]/g)) found.push(`${match[0]} (set on an element)`)
  if (extname(file) === '.css') {
    // The text size control's own rules: html[data-text-size="…"] { font-size: …% }. `font:` in an @page margin box is print.
    const withoutControl = source.replace(/html\[data-text-size="[a-z]+"\]\s*\{\s*font-size:\s*[\d.]+%;?\s*\}/g, '')
    for (const match of withoutControl.matchAll(/(?<![\w-])font-size\s*:[^;}]*/g)) found.push(match[0])
  }
  return found
}

function sources() {
  const dir = join(root, 'src')
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/(^|[\\/])(generated|routeTree\.gen\.ts)/.test(name))
    .map((name) => ({ name: `src/${name.replaceAll('\\', '/')}`, text: readFileSync(join(dir, name), 'utf8') }))
}

test('Tailwind text-xs and text-sm are the same size as text-base, which is the size the control chose', () => {
  assert.equal(token(tailwindTheme, '--text-base'), '1rem') // what Tailwind ships: 1rem is the root, which the control sets
  assert.equal(token(css, '--text-xs'), '1rem')
  assert.equal(token(css, '--text-sm'), '1rem')
  assert.equal(token(css, '--text-xs--line-height'), token(tailwindTheme, '--text-base--line-height'))
  assert.equal(token(css, '--text-sm--line-height'), token(tailwindTheme, '--text-base--line-height'))
})

test('headings stay larger than text: text-lg, text-xl and text-2xl are bigger than 1rem and are not redefined smaller', () => {
  for (const name of ['--text-lg', '--text-xl', '--text-2xl']) {
    const size = rem(token(css, name) ?? token(tailwindTheme, name))
    assert.ok(size > 1, `${name} is ${size}rem`)
  }
  assert.equal(token(css, '--text-base'), undefined) // the base size is Tailwind's 1rem, not a size of the app's own
})

test('the root font size is the size the control chose, from 87.5% to 125%, and nothing sets it otherwise', () => {
  const rules = [...css.matchAll(/html\[data-text-size="([a-z]+)"\]\s*\{\s*font-size:\s*([\d.]+)%/g)].map((m) => [m[1], Number(m[2])])
  assert.deepEqual(rules, [['small', 87.5], ['medium', 100], ['large', 112.5], ['xlarge', 125]])
  assert.deepEqual([...css.matchAll(/(?<![\w-])(?:html|:root|body)\s*\{[^}]*font-size/g)], [])
})

test('no text in src/ has a size of its own', () => {
  const all = sources()
  assert.ok(all.length > 50, 'src/ was not read')
  const found = all.flatMap(({ name, text }) => fixedSizes(text, name).map((what) => `${name}: ${what}`))
  assert.deepEqual(found, [])
})

// The check above proves nothing unless it would fail on a fixed size, so it is held to some. They are assembled here, not written out, so Tailwind (which reads every file in the
// repository for class names) does not find a fixed size in a test and add it to the page's stylesheet.
const arbitrary = (value, variants = '') => `<td className="p-2 ${variants}text-[${value}]">`
const custom = (value) => `<td className="text-(${value})">`

test('the scan finds a fixed size, in every form one is written', () => {
  for (const line of [
    arbitrary('0.9375rem'),
    arbitrary('15px', 'md:'),
    arbitrary('1.1em', 'hover:max-md:'),
    arbitrary('90%'),
    arbitrary('length:var(--size)'),
    custom('length:--size'),
    arbitrary('12px', 'print:'), // print is allowed in pt, not in px
    arbitrary('12pt'), // pt outside print
    'const style = { fontSize: 14 }',
    '<XAxis tick={{ fontSize: 12 }} />',
    '<text fontSize="12">',
  ]) {
    assert.notDeepEqual(fixedSizes(line, 'x.tsx'), [], line)
  }
  for (const line of ['html { font-size: 20px; }', 'p { color: red; font-size: 0.9rem }', '.a { font-size: calc(1rem + 1px); }']) {
    assert.notDeepEqual(fixedSizes(line, 'x.css'), [], line)
  }
})

test('the scan leaves alone what is not a fixed size', () => {
  for (const line of [
    '<td className="text-base text-sm text-xs text-lg text-xl text-2xl">',
    arbitrary('12pt', 'print:'),
    arbitrary('15pt', 'md:print:'),
    arbitrary('#ffffff'),
    arbitrary('var(--x)'),
    arbitrary('color:var(--x)'),
    custom('--x'),
    '<td className="text-foreground text-muted-foreground text-center text-balance text-clip">',
    'parseFloat(getComputedStyle(document.documentElement).fontSize)',
    `// ${arbitrary('15px')} is only a comment`,
    `/* ${arbitrary('15px')} */`,
  ]) {
    assert.deepEqual(fixedSizes(line, 'x.tsx'), [], line)
  }
  assert.deepEqual(fixedSizes('html[data-text-size="small"] {\n    font-size: 87.5%;\n  }', 'x.css'), [])
  assert.deepEqual(fixedSizes('@bottom-right { font: 12pt/1.3 var(--font-sans); }', 'x.css'), [])
})
