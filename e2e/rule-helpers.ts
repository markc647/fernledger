import type { BrowserContext, Page } from '@playwright/test'
import { expect, signInAs } from './fixtures'

// Rules made through the API for a spec to look at and change, and taken away again when it is done: the order of the Rules is the same for every spec and both themes, so a spec
// works only with the Rules it made, and leaves none behind (rules.spec.ts, rules-reorder.spec.ts and row-actions.spec.ts).

export async function categoryId(context: BrowserContext, name: string) {
  const categories = (await (await context.request.get('/api/categories')).json()) as { id: number; name: string }[]
  return categories.find((c) => c.name === name)!.id
}

export async function addRule(context: BrowserContext, baseURL: string, body: Record<string, unknown>) {
  const res = await context.request.post('/api/rules', { headers: { Origin: baseURL }, data: body })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { id: number }).id
}

export const removeRule = async (context: BrowserContext, baseURL: string, id: number) =>
  expect((await context.request.delete(`/api/rules/${id}`, { headers: { Origin: baseURL }, data: {} })).ok()).toBe(true)

/** Every Rule's id, in the order the Worker has them. */
export const ruleIds = async (context: BrowserContext) => ((await (await context.request.get('/api/rules')).json()) as { id: number }[]).map((r) => r.id)

/**
 * Signs in as the Admin and makes a Rule for each of `words` (it looks for "EXAMPLE <word> <this run's stamp>" and puts what it finds in Fuel), in this order, after whatever others
 * there are. `body` is given their ids, in the same order; they are taken away when it is done, however it ends.
 */
export async function withRules<Words extends string[]>(
  context: BrowserContext,
  baseURL: string,
  testInfo: { project: { name: string } },
  words: [...Words],
  body: (ids: { [Index in keyof Words]: number }) => Promise<void>,
) {
  await signInAs(context, 'admin')
  const fuel = await categoryId(context, 'Fuel')
  const stamp = `${testInfo.project.name}${Date.now()}`
  const ids: number[] = []
  try {
    for (const word of words) ids.push(await addRule(context, baseURL, { textContains: `EXAMPLE ${word} ${stamp}`, categoryId: fuel }))
    await body(ids as { [Index in keyof Words]: number })
  } finally {
    for (const id of ids) await removeRule(context, baseURL, id)
  }
}

/** What the Worker says of the features when the D1 usage bar is switched on (local development has no Cloudflare token, so the specs that look at the bar stub it). */
export const usageOn = { features: [{ id: 'd1-usage', name: 'D1 usage bar', enabled: true }] }

/** What the Worker says of the day's database use, changed by what a spec passes: Low on both bars unless it says otherwise. */
export const usageFigures = (over: Record<string, unknown> = {}) => ({
  rowsRead: 1_234_567,
  rowsWritten: 4_321,
  readLimit: 5_000_000,
  writeLimit: 100_000,
  resetsAt: '2026-10-15T00:00:00.000Z',
  ...over,
})

/** The "⋯" button of a Rule's row or card, by the Rule's id (the page puts the id in the button's own, so it is found wherever the Rule is in the list). */
export const ruleActions = (page: Page, id: number) => page.locator(`#rule-${id}-actions`)

/** The handle that drags a Rule's row or card. */
export const ruleGrip = (page: Page, id: number) => page.locator(`#rule-${id}-grip`)

/** The ids of these Rules in the order the page shows them. */
export const pageOrder = async (page: Page, ...ids: number[]) => {
  const shown = await page.locator('[id^="rule-"][id$="-actions"]').evaluateAll((buttons) => buttons.map((button) => Number(button.id.split('-')[1])))
  return shown.filter((id) => ids.includes(id))
}

/** What the Worker says of a run of "Apply the Rules to all Transactions" that is going, as the page asks for it: a job, changed by what a spec passes. */
export const runningJob = (over: Record<string, unknown> = {}) => ({
  id: 7,
  status: 'running',
  startedAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:30.000Z',
  finishedAt: null,
  totalRows: 20_000,
  doneRows: 4_000,
  changedRows: 12,
  percent: 20,
  restarts: 0,
  stepRows: 1_000,
  cronRowsPerDay: 6_000,
  paused: false,
  ...over,
})
