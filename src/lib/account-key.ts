// A relative path, not `@/`, as in the other library files the Playwright project reaches through src/lib/report-frame.ts: that
// project compiles them without the `@` alias (tsconfig.e2e.json).
import type { GENERATED_KEY_PATTERN } from '../generated/api/account-fields'

// What an Account key is: the number the bank prints, or one Fernledger generated where the bank prints none, such as for a
// credit card (ADR 0017). The browser is a separate program and cannot import the Worker's code, as with dates
// (src/lib/iso-date.ts), so it keeps its own copy of the pattern, typed as the Worker's literal: the two cannot drift apart
// without the build failing.
const PATTERN: typeof GENERATED_KEY_PATTERN = '^card-[0-9]{4,}$'
const GENERATED = new RegExp(PATTERN)

/** True for a key Fernledger generated. Such a key is never shown where a bank's account number is expected. */
export const isGeneratedKey = (key: string) => GENERATED.test(key)
