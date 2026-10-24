// Run with `npm run test:scripts`. The D1 usage bar tells the Admin where to find its steps ("docs/setup.md, under "D1 usage bar (optional)"") in
// two places that cannot import each other: the Worker's Setup needed words (worker/features.ts) and the page's note for a failed read
// (src/lib/d1-usage.ts). This holds both to the heading docs/setup.md really has, the README's links to its anchor, the secrets it names, and
// the log events the Worker writes, which setup.md lists for the Deployer reading the Worker log.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const HEADING = 'D1 usage bar (optional)'
// GitHub's anchor for that heading: lower case, punctuation dropped, spaces to hyphens.
const ANCHOR = 'd1-usage-bar-optional'

test('docs/setup.md has the heading the app points to, and the README links to it', () => {
  assert.match(read('docs/setup.md'), new RegExp(`^## ${HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  assert.ok(read('README.md').includes(`docs/setup.md#${ANCHOR}`), 'the README should link to the section')
})

test('the Setup needed words and the page both send the Admin to that heading', () => {
  for (const file of ['worker/features.ts', 'src/lib/d1-usage.ts']) {
    assert.ok(read(file).includes(`docs/setup.md, under "${HEADING}"`), `${file} should point to docs/setup.md, under "${HEADING}"`)
  }
})

test('docs/setup.md names both secrets and every event the Worker logs for a failed read', () => {
  const setup = read('docs/setup.md')
  const section = setup.slice(setup.indexOf(`## ${HEADING}`))
  for (const name of ['CF_ANALYTICS_TOKEN', 'CF_ACCOUNT_ID']) assert.ok(section.includes(name), `${name} should be in the section`)
  const events = [...read('worker/d1-usage.ts').matchAll(/'(d1-usage\.[a-z-]+)'/g)].map((match) => match[1])
  assert.ok(events.length >= 4, 'the Worker should have an event for each reason')
  for (const event of events) assert.ok(section.includes(`\`${event}\``), `${event} should be listed in the section`)
})
