// Layout reference: docs/bank-formats/kiwibank.md
//
// Kiwibank writes the time of an EFTPOS purchase at the end of its description (`POS W/D Example Store-12:07`), because it gives Akahu
// a date and nothing else. This file reads it. It is apart from kiwibank.ts so the Worker can use it without the CSV parser's imports,
// and it is Kiwibank's alone: another bank's description is never read this way (worker/sync.ts asks isKiwibank first).

/** `-HH:MM` at the very end, a 24-hour time: hours 00-23 and minutes 00-59. */
const EFTPOS_TIME = /-([01]\d|2[0-3]):([0-5]\d)$/

/**
 * The `HH:MM` the bank wrote at the end of a description, or null when there is none. Null is also the answer for something that
 * only looks like a time (`-25:99`, `-1207`, `12:07` with no dash, a time in the middle): Fernledger shows a Bank Time only when it
 * is real (spec 52) and never makes one up.
 */
export function eftposTime(description: string): string | null {
  const found = EFTPOS_TIME.exec(description.trimEnd())
  return found ? `${found[1]}:${found[2]}` : null
}

/** Whether Akahu's name for a bank connection is Kiwibank's. */
export const isKiwibank = (connectionName: string | null | undefined): boolean => connectionName?.trim().toLowerCase() === 'kiwibank'
