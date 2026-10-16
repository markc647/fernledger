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

/** Words about a size are not a size: what is in a comment is not read. (A `//` after a colon is a web address.) */
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Splits a class on the colons that are not inside brackets or parentheses, so a variant such as `[&_td:first-child]` stays whole. The last part is the utility, the rest are its variants. */
function parseClass(token) {
  const parts = []
  let depth = 0
  let from = 0
  for (let i = 0; i < token.length; i++) {
    if ('[('.includes(token[i])) depth++
    else if (')]'.includes(token[i])) depth--
    else if (token[i] === ':' && depth === 0) {
      parts.push(token.slice(from, i))
      from = i + 1
    }
  }
  return { variants: parts, utility: token.slice(from).replace(/^!|!$/g, '') }
}

/** A colour, or a custom property by itself: the two things that `text-[…]` may hold besides a size. A custom property is allowed because it can only be a colour or a size the stylesheet chose. */
const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(.*\)|color:.+|currentcolor|transparent|inherit)$/i
const CUSTOM_PROPERTY = /^(var\(--[\w-]+\)|--[\w-]+)$/

/**
 * The fixed font sizes in a source file: any bracketed or parenthesised value after `text-` (with any variants before it) that is not a colour or a custom property by itself (a length, a
 * `length:` value, a `calc()`, anything that sets a size), except a size in pt behind `print:` (a printed Report's type, nested variants too); any `fontSize` that is not read off an
 * element (`.fontSize`); and, in a stylesheet, any `font-size` that is not one of the text size control's four rules and any `font:` shorthand outside an `@page` margin box. Comments are not read.
 */
export function fixedSizes(source, file) {
  const code = withoutComments(source)
  const found = []
  for (const [candidate] of code.matchAll(/[^\s"'`{}]*text-[[(][^\s"'`]*/g)) {
    const { variants, utility } = parseClass(candidate)
    const value = /^-?text-\[(.+)\]$/.exec(utility)?.[1] ?? /^-?text-\((.+)\)$/.exec(utility)?.[1]
    if (value === undefined || COLOUR.test(value) || CUSTOM_PROPERTY.test(value)) continue
    const printedInPt = variants.includes('print') && /^-?[\d.]+pt$/.test(value)
    if (!printedInPt) found.push(candidate)
  }
  for (const match of code.matchAll(/(?<!\.)\bfontSize\b|\.fontSize\s*=(?!=)/g)) found.push(`${match[0]} (set on an element)`)
  if (extname(file) === '.css') {
    // The text size control's own rules: html[data-text-size="…"] { font-size: …% }. An `@page` margin box is for print.
    const withoutControl = code.replace(/html\[data-text-size="[a-z]+"\]\s*\{\s*font-size:\s*[\d.]+%;?\s*\}/g, '')
    const withoutPages = withoutControl.replace(/@page[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
    for (const match of withoutPages.matchAll(/(?<![\w-])font(?:-size)?\s*:[^;}]*/g)) found.push(match[0])
  } else {
    for (const match of code.matchAll(/(?<![\w./-])font\s*:\s*[^,}\n]*/g)) found.push(match[0])
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

test('the stylesheet defines no text size token but those two: text-base and the headings are Tailwind\'s own', () => {
  const defined = [...new Set([...withoutComments(css).matchAll(/(--text-[\w-]+)\s*:/g)].map((m) => m[1]))].sort()
  assert.deepEqual(defined, ['--text-sm', '--text-sm--line-height', '--text-xs', '--text-xs--line-height'])
})

test('headings stay larger than text: text-lg, text-xl and text-2xl are bigger than 1rem', () => {
  for (const name of ['--text-lg', '--text-xl', '--text-2xl']) {
    const size = rem(token(tailwindTheme, name))
    assert.ok(size > 1, `${name} is ${size}rem`)
  }
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

// The check above proves nothing unless it would fail on a fixed size, so it is held to some, in every form one is written.
test('the scan finds a fixed size', () => {
  for (const line of [
    '<td className="text-[0.9375rem]">',
    '<td className="md:text-[15px] p-2">',
    '<td className="hover:max-md:text-[1.1em]">',
    '<td className="text-[90%]">',
    '<td className="text-[length:var(--size)]">',
    '<td className="text-(length:--size)">',
    '<td className="text-[calc(1rem+2px)]">',
    '<td className="text-[clamp(1rem,2vw,1.5rem)]">',
    '<td className="text-[larger]">',
    '<td className="print:text-[12px]">', // print is allowed in pt, not in px
    '<td className="text-[12pt]">', // pt outside print
    '<td className="print:text-[calc(12pt+1px)]">',
    '<td className="[&_td]:text-[15px]">',
    '<td className="print:[&_td]:text-[15px]">',
    '<td className="!text-[15px]">',
    'const style = { fontSize: 14 }',
    'const style = { fontSize }',
    '<XAxis tick={{ fontSize: 12 }} />',
    '<text fontSize="12">',
    "element.style.fontSize = '15px'",
    "const style = { font: '15px Arial' }",
  ]) {
    assert.notDeepEqual(fixedSizes(line, 'x.tsx'), [], line)
  }
  for (const line of ['html { font-size: 20px; }', 'p { color: red; font-size: 0.9rem }', '.a { font-size: calc(1rem + 1px); }', 'p { font: 15px Arial; }', '@media print { p { font-size: 12pt } }']) {
    assert.notDeepEqual(fixedSizes(line, 'x.css'), [], line)
  }
})

test('the scan leaves alone what is not a fixed size', () => {
  for (const line of [
    '<td className="text-base text-sm text-xs text-lg text-xl text-2xl">',
    '<td className="print:text-[12pt] print:text-[15pt] print:text-[13.5pt]">',
    '<td className="md:print:text-[15pt]">',
    '<td className="print:[&_td]:text-[12pt]">',
    '<td className="print:[&_td:first-child]:text-[12pt]">',
    '<td className="[&_td]:print:text-[12pt]">',
    '<td className="text-[#ffffff] text-[rgb(0,0,0)] text-[oklch(0.5_0_0)] text-[var(--x)] text-[color:var(--x)] text-(--x) text-(color:--x)">',
    '<td className="text-foreground text-muted-foreground text-center text-balance text-clip text-ellipsis text-wrap">',
    'parseFloat(getComputedStyle(document.documentElement).fontSize)',
    'const x = 1 // a comment with a fixed size in it: text-[15px] fontSize: 14',
    '/* text-[15px] fontSize: 14 font: 15px Arial */',
    '// <td className="text-[15px]">',
    '<a href="https://example.test/font:">',
  ]) {
    assert.deepEqual(fixedSizes(line, 'x.tsx'), [], line)
  }
  assert.deepEqual(fixedSizes('html[data-text-size="small"] {\n    font-size: 87.5%;\n  }', 'x.css'), [])
  assert.deepEqual(fixedSizes('@page report { @bottom-right { font: 12pt/1.3 var(--font-sans); } }', 'x.css'), [])
  assert.deepEqual(fixedSizes('/* font-size: 15px */ p { color: red }', 'x.css'), [])
})
