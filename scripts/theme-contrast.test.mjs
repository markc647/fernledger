// Pins the colour tokens in src/index.css to WCAG 2.2 AA in both themes: text 4.5:1 (1.4.3) and focus ring 3:1 (1.4.11).
// Only opaque tokens are checked; translucent ones (borders) are not text or focus indicators.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const block = (selector) => {
  const start = css.indexOf(`\n${selector} {`)
  assert.notEqual(start, -1, `no ${selector} block`)
  return css.slice(start, css.indexOf('\n}', start))
}
const tokens = (selector) =>
  Object.fromEntries([...block(selector).matchAll(/--([\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/g)].map((m) => [m[1], m.slice(2).map(Number)]))

// OKLCH -> linear sRGB (Björn Ottosson's matrices), then WCAG relative luminance.
function luminance([l, c, h]) {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) => Math.min(1, Math.max(0, v)))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const pairs = [
  ['foreground', 'background', 4.5],
  ['card-foreground', 'card', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['ring', 'background', 3],
  // Money in/out and statuses are text on the page or a card (the Amount and Status components).
  ...['success', 'warning', 'danger'].flatMap((fg) => [[fg, 'background', 4.5], [fg, 'card', 4.5], [fg, 'muted', 4.5]]),
]
// Print is always the light theme (src/index.css), so a page printed from the dark theme is not pale text on white paper.
// The print block restates every token `.dark` overrides, and each must equal the light value. Values are compared as
// written, so translucent colours and `var()` references count too. A token added to `.dark` alone fails here.
const declarations = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
test("print: every token the dark theme overrides is restated with the light theme's value", () => {
  const start = css.indexOf('@media print {')
  assert.notEqual(start, -1, 'no print block')
  const print = declarations(css.slice(start, css.indexOf('\n}', start)))
  const light = declarations(block(':root'))
  const dark = declarations(block('.dark'))
  assert.ok(Object.keys(dark).length > 30, 'the .dark block should list the whole theme')
  for (const name of Object.keys(dark)) {
    assert.ok(name in light, `--${name} is in .dark but not :root, so print has no light value to restate`)
    assert.equal(print[name], light[name], `--${name} is missing from the print block or differs from the light theme`)
  }
  for (const [name, value] of Object.entries(print)) assert.equal(value, light[name], `--${name} differs from the light theme`)
})

for (const [selector, theme] of [[':root', 'light'], ['.dark', 'dark']]) {
  const t = tokens(selector)
  for (const [fg, bg, min] of pairs) {
    test(`${theme}: ${fg} on ${bg} is at least ${min}:1`, () => {
      assert.ok(t[fg] && t[bg], `missing ${fg} or ${bg}`)
      const ratio = contrast(t[fg], t[bg])
      assert.ok(ratio >= min, `${ratio.toFixed(2)}:1`)
    })
  }
}
