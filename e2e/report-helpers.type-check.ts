import type { BrowserContext } from '@playwright/test'
import { importRows } from './report-helpers'

// Compile-time checks, never run (`npm run typecheck` compiles this file; Playwright only runs *.spec.ts): what `importRows` accepts. A call that gives neither a year nor
// both ends of a range would date its file "undefined-01-01", and must not compile. If one of the `@ts-expect-error` lines below stops being an error, the type has been loosened.
declare const context: BrowserContext
declare const account: { number: string; name: string }

export async function importRowsTakesAYearOrBothEnds() {
  await importRows(context, '', { account, rows: [], year: 2026 })
  await importRows(context, '', { account, rows: [], year: 2026, from: '2026-02-01' })
  await importRows(context, '', { account, rows: [], year: 2026, to: '2026-02-28', idPrefix: 'X' })
  await importRows(context, '', { account, rows: [], from: '2026-01-01', to: '2026-01-31', ledger: { date: '2026-02-28', cents: 0 } })

  // @ts-expect-error neither a year nor a range
  await importRows(context, '', { account, rows: [] })
  // @ts-expect-error one end of a range, and no year to supply the other
  await importRows(context, '', { account, rows: [], from: '2026-01-01' })
  // @ts-expect-error the other end alone
  await importRows(context, '', { account, rows: [], to: '2026-01-31' })
  // @ts-expect-error the ledger is not a date for the file
  await importRows(context, '', { account, rows: [], ledger: { date: '2026-02-28', cents: 0 } })
}
