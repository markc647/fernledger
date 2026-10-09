/** One Transaction row from a bank CSV, as the browser sends it (the shape of `BankCsvRow`, src/lib/bank-csv/types.ts). */
export type ImportRow = {
  date: string
  uniqueId: string
  tranType: string
  chequeNumber: string | null
  payee: string
  bankMemo: string
  amountCents: number
}

export const MAX_ROWS_PER_CHUNK = 500

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const isRealDate = (value: unknown) => {
  const parts = typeof value === 'string' ? ISO_DATE.exec(value) : null
  if (!parts) return false
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (month < 1 || month > 12 || day < 1) return false
  const year = Number(parts[1])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= (month === 2 && !leap ? 28 : DAYS_IN_MONTH[month - 1]!)
}

const isText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max

/**
 * Checks a chunk's rows and returns the path of the first bad field (`rows.3.date`), or null if all are fine.
 * Written by hand rather than as a zod schema on purpose: a free-plan invocation has 10 ms of CPU (ADR 0004), and
 * measured in Node, zod's per-row checks took 4-12 ms for 500 rows while this takes about 1 ms.
 * It never returns a value, only a path, so Transaction data can't reach an error message.
 */
export function badRowField(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_CHUNK) return 'rows'
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown> | null
    if (typeof row !== 'object' || row === null) return `rows.${i}`
    if (!isRealDate(row.date)) return `rows.${i}.date`
    if (typeof row.uniqueId !== 'string' || row.uniqueId.length < 1 || row.uniqueId.length > 64) return `rows.${i}.uniqueId`
    if (!isText(row.tranType, 40)) return `rows.${i}.tranType`
    if (row.chequeNumber !== null && !isText(row.chequeNumber, 40)) return `rows.${i}.chequeNumber`
    if (!isText(row.payee, 200)) return `rows.${i}.payee`
    if (!isText(row.bankMemo, 200)) return `rows.${i}.bankMemo`
    if (!Number.isSafeInteger(row.amountCents)) return `rows.${i}.amountCents`
  }
  return null
}
