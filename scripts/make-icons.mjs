// Draws the app icon once and writes every file that carries it: public/favicon.svg and the PNGs the Home Screen needs.
// Run `node scripts/make-icons.mjs` after changing the drawing; the output is committed, and nothing runs this at build time.
// It needs a browser to turn the drawing into PNGs: the one Playwright already uses (`npx playwright install chromium`,
// or set PLAYWRIGHT_CHANNEL=msedge). The icon is deliberately generic: an open ledger page, no fern and no bank branding.
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const publicDir = resolve(import.meta.dirname, '..', 'public')

/**
 * The drawing on a 512 square. `rounded` is for icons shown as they are; a maskable icon is full-bleed (the phone
 * cuts its own shape) and its drawing is kept inside the middle 80% (`inset`), where no shape cuts.
 */
const drawing = ({ rounded, inset }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="#1f2d3d"/>
  <g transform="translate(256 256) scale(${inset}) translate(-256 -256)">
    <rect x="116" y="96" width="280" height="320" rx="24" fill="#f5f7fa"/>
    <path d="M164 96v320" stroke="#7c93ad" stroke-width="10"/>
    <path d="M204 176h152M204 232h152M204 288h152M204 344h96" stroke="#7c93ad" stroke-width="16" stroke-linecap="round"/>
  </g>
</svg>
`

const plain = drawing({ rounded: true, inset: 1 })
const maskable = drawing({ rounded: false, inset: 0.9 })

writeFileSync(resolve(publicDir, 'favicon.svg'), plain)

const pngs = [
  ['icon-192.png', 192, plain],
  ['icon-512.png', 512, plain],
  ['icon-maskable-512.png', 512, maskable],
  // iOS fills transparent corners with black, so its icon is the full-bleed drawing, which iOS rounds itself.
  ['apple-touch-icon.png', 180, maskable],
]

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
try {
  for (const [file, size, svg] of pngs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)
    writeFileSync(resolve(publicDir, file), await page.locator('svg').screenshot({ omitBackground: true }))
    await page.close()
  }
} finally {
  await browser.close()
}
