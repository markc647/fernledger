import type { BrowserContext, Page } from '@playwright/test'
import { expect } from './fixtures'

// Rules made through the API for a spec to look at and change, and taken away again when it is done: the order of the Rules is the same for every spec and both themes, so a spec
// works only with the Rules it made, and leaves none behind (rules.spec.ts and rules-reorder.spec.ts).

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

/** The ids of these Rules in the order the page shows them (each row's "⋯" button is `rule-<id>-actions`). */
export const pageOrder = async (page: Page, ...ids: number[]) => {
  const shown = await page.locator('[id^="rule-"][id$="-actions"]').evaluateAll((buttons) => buttons.map((button) => Number(button.id.split('-')[1])))
  return shown.filter((id) => ids.includes(id))
}
