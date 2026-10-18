import type { D1Usage, UnavailableReason } from '@/generated/api/d1-usage'
import { formatCount, formatDateTime } from './format'

// How the Rules page tells the Admin how much of D1 Free's daily allowance the Cloudflare account has used (worker/d1-usage.ts):
// rows read against 5,000,000 and rows written against 100,000, a day at a time, UTC. The Worker sends the figures, the limits and when the
// day ends (`resetsAt`); the percentage, the level and the words are worked out here, once, so the bar, the badge and the sentence always agree.

export type { D1Usage, UnavailableReason }

export type Level = 'low' | 'medium' | 'high'

/** The words on the badge. They carry the level; the colour of the bar is for those who can see it. */
export const LEVEL_WORDS: Record<Level, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Whole per cent, rounded down: it is never shown as further gone than it is, and 100 means the allowance really is used up. Can pass 100. */
export const percentOf = (used: number, limit: number) => Math.floor((used * 100) / limit)

/** Low below 50%, Medium from 50% to 79%, High from 80%. */
export const levelOf = (percent: number): Level => (percent >= 80 ? 'high' : percent >= 50 ? 'medium' : 'low')

export type Meter = {
  label: string
  level: Level
  percent: number
  /** The line under the bar: "1,234,567 of 5,000,000 rows read · 24%". */
  text: string
  /** What a screen reader says for the bar's value. */
  valueText: string
}

const meter = (noun: 'read' | 'written', used: number, limit: number): Meter => {
  const percent = percentOf(used, limit)
  const figures = `${formatCount(used)} of ${formatCount(limit)} rows ${noun}`
  return { label: `Database rows ${noun} today`, level: levelOf(percent), percent, text: `${figures} · ${percent}%`, valueText: `${figures}, ${percent}%` }
}

/** The two bars: rows read (the allowance that ran out), then rows written. */
export const meters = (usage: D1Usage): [Meter, Meter] => [meter('read', usage.rowsRead, usage.readLimit), meter('written', usage.rowsWritten, usage.writeLimit)]

export type LeftLevel = 'plenty' | 'low' | 'almost-used'

export type Allowance = {
  /** Whole per cent of today's allowance left, of whichever of the two has less. */
  percent: number
  /** Which of the two that is: the reads (when the two leave the same). */
  which: 'read' | 'written'
  level: LeftLevel
  /** The word that says it is running out, so the colour is not the only cue: none while there is plenty. */
  word: 'Low' | 'Almost used' | null
  /** Both figures, for a tooltip or a line under the bar. */
  figures: [string, string]
  /** What a screen reader says for the bar's value: the percentage, the word, both figures and that it is an estimate. */
  valueText: string
}

/** Whole per cent left, rounded down so it is never shown as more than there is; 0 once the allowance is used up or passed. */
const leftOf = (used: number, limit: number) => Math.max(0, Math.floor(((limit - used) * 100) / limit))

/** Plenty from 20% left, Low below it, Almost used below 5%. */
const leftLevelOf = (percent: number): LeftLevel => (percent < 5 ? 'almost-used' : percent < 20 ? 'low' : 'plenty')

const LEFT_WORDS = { plenty: null, low: 'Low', 'almost-used': 'Almost used' } as const

export const ESTIMATE_NOTE = 'An estimate: Cloudflare runs a few minutes behind.'

/** The header's one bar: how much of today's free allowance is left, of the rows read (5,000,000 a day) or the rows written (100,000), whichever has less. */
export function allowanceLeft(usage: D1Usage): Allowance {
  const reads = leftOf(usage.rowsRead, usage.readLimit)
  const writes = leftOf(usage.rowsWritten, usage.writeLimit)
  const which = writes < reads ? 'written' : 'read'
  const percent = Math.min(reads, writes)
  const level = leftLevelOf(percent)
  const word = LEFT_WORDS[level]
  const figures: [string, string] = [
    `Rows read today: ${formatCount(usage.rowsRead)} of ${formatCount(usage.readLimit)}`,
    `Rows written today: ${formatCount(usage.rowsWritten)} of ${formatCount(usage.writeLimit)}`,
  ]
  return { percent, which, level, word, figures, valueText: `About ${percent}% left${word ? `, ${word}` : ''}. ${figures[0]}. ${figures[1]}. ${ESTIMATE_NOTE}` }
}

/** When D1's day changes (00:00 UTC, as the Worker says in `resetsAt`), in New Zealand time. */
export const resetSentence = (usage: D1Usage) => `The allowance starts again on ${formatDateTime(usage.resetsAt)}, New Zealand time.`

export const STALE_NOTE = 'These figures are for the whole Cloudflare account, not only Fernledger, and run a few minutes behind.'

// Where the steps are. The heading is docs/setup.md's, and the Worker's Setup needed words (worker/features.ts: D1_USAGE) say it too:
// scripts/setup-docs.test.mjs fails if any of the three drifts.
const STEPS = 'The steps are in docs/setup.md, under "D1 usage bar (optional)".'
const CHECK = 'CF_ACCOUNT_ID must be the account the token belongs to, and the token needs Account Analytics: Read.'

/** What the Admin is told when Cloudflare gave no figures, by the Worker's reason (the 502's `reason`): the likely fix, where there is one. */
const UNAVAILABLE: Record<UnavailableReason, string> = {
  refused: `Usage unavailable. Cloudflare refused the token or the account ID. ${CHECK} ${STEPS}`,
  'no-account': `Usage unavailable. Cloudflare found no such account for this token. ${CHECK} ${STEPS}`,
  unreachable: 'Usage unavailable. Cloudflare could not be reached just now, or was too slow. Try again in a moment.',
  unreadable: 'Usage unavailable. Cloudflare answered with something Fernledger did not expect. Try again in a moment.',
}

/** The note for a reason the Worker gave. A reason this page does not know (a newer Worker's) is read as the plainest one. */
export const unavailableNote = (reason: string | undefined) => UNAVAILABLE[reason !== undefined && Object.hasOwn(UNAVAILABLE, reason) ? (reason as UnavailableReason) : 'unreachable']
