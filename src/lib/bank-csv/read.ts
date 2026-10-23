// Reading a CSV file's text, shared by every adapter: the layouts differ, but splitting lines and fields does not.
//
// Dates and amounts are each adapter's own, because the banks write them differently (ASB's `YYYY/MM/DD` against Kiwibank's
// `YYYY-MM-DD`), so those parsers stay with the adapter whose format they are.

/** The file's lines, without a leading byte-order mark, however the file ends its lines. */
export const splitLines = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\n|\r/)

/** Splits one CSV line. Returns null if a quote is left open or text follows a closing quote. */
export function splitFields(line: string): string[] | null {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = ''
      i++
      for (;;) {
        if (i >= line.length) return null
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i++
          break
        }
        value += line[i++]
      }
      if (i < line.length && line[i] !== ',') return null
      fields.push(value)
    } else {
      const end = line.indexOf(',', i)
      const stop = end === -1 ? line.length : end
      fields.push(line.slice(i, stop))
      i = stop
    }
    i++ // skip the comma
  }
  return fields
}
