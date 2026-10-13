import type { D1Usage } from '@/generated/api/d1-usage'
import { formatCount, formatDateTime } from './format'

// How the Rules page tells the Admin how much of D1 Free's daily allowance the Cloudflare account has used (worker/d1-usage.ts):
// rows read against 5,000,000 and rows written against 100,000, a day at a time, UTC. The Worker sends the figures and the limits;
// the percentage, the level and the words are worked out here, once, so the bar, the badge and the sentence always agree.

export type { D1Usage }

export type Level = 'low' | 'medium' | 'high'

/** The words on the badge. They carry the level; the colour of the bar is for those who can see it. */
export const LEVEL_WORDS: Record<Level, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Whole per cent, rounded down: it is never shown as further gone than it is, and 100 means the allowance really is used up. Can pass 100. */
export const percentOf = (used: number, limit: number) => Math.floor((used * 100) / limit)

/** Low below 50%, Medium from 50% to 79%, High from 80%. */
export const levelOf = (percent: number): Level => (percent >= 80 ? 'high' : percent >= 50 ? 'medium' : 'low')

/** How full to draw the bar: the percentage, but not past the end. */
export const barValue = (percent: number) => Math.min(100, Math.max(0, percent))

export type Meter = {
  label: string
  level: Level
  percent: number
  /** How full the bar is drawn, 0 to 100. */
  value: number
  /** The line under the bar: "1,234,567 of 5,000,000 rows read · 24%". */
  text: string
  /** What a screen reader says for the bar's value. */
  valueText: string
}

const meter = (noun: 'read' | 'written', used: number, limit: number): Meter => {
  const percent = percentOf(used, limit)
  const figures = `${formatCount(used)} of ${formatCount(limit)} rows ${noun}`
  return {
    label: `D1 rows ${noun} today`,
    level: levelOf(percent),
    percent,
    value: barValue(percent),
    text: `${figures} · ${percent}%`,
    valueText: `${figures}, ${percent}%`,
  }
}

/** The two bars: rows read (the allowance that ran out), then rows written. */
export const meters = (usage: D1Usage): [Meter, Meter] => [meter('read', usage.rowsRead, usage.readLimit), meter('written', usage.rowsWritten, usage.writeLimit)]

/** When D1's day changes (00:00 UTC), in New Zealand time. */
export const resetSentence = (usage: D1Usage) => `The allowance starts again on ${formatDateTime(usage.resetsAt)}, New Zealand time.`

export const staleNote = () => 'These figures are for the whole Cloudflare account, not only Fernledger, and run a few minutes behind.'

/** Where the steps are. The heading is docs/setup.md's. */
export const setupPointer = () => 'The steps are in docs/setup.md, under "D1 usage bar (optional)".'

export const unavailableNote = () =>
  'Usage unavailable. Cloudflare did not give the figures just now. If this keeps happening, check the token and account ID you set. ' + setupPointer()
