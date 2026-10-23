import * as z from 'zod/mini'
import { isRealDate } from './dates'

/** An Account's display name, as the Admin types it (trimmed, 1 to 60 characters). */
export const accountName = z.string().check(z.trim(), z.minLength(1), z.maxLength(60))

/** A bank account number as the bank prints it: `BB-bbbb-AAAAAAA-SS`, where the suffix may have a third digit (`-099`). */
const BANK_NUMBER = /^\d{2}-\d{4}-\d{7}-\d{2,3}$/

/**
 * The shape of the key Fernledger generates for an Account whose bank prints no number, such as a credit card (ADR 0017):
 * `card-` and at least four digits. It is a pattern and not a regular expression so that the browser's own copy
 * (`src/lib/account-key.ts`) can be typed as this one, and the build fails if the two ever drift apart.
 */
export const GENERATED_KEY_PATTERN = '^card-[0-9]{4,}$'
const GENERATED_KEY = new RegExp(GENERATED_KEY_PATTERN)

/** True for a key Fernledger generated: one only `ADD_CARD_ACCOUNT` (worker/accounts.ts) hands out, and never typed by the Admin. */
export const isGeneratedKey = (key: string) => GENERATED_KEY.test(key)

/**
 * An Account's stable key as it crosses the API: the number the bank prints, or the one Fernledger generated where the bank
 * prints none. This is what an Import matches a file against and what `transactions.account_id` is resolved through. A CSV
 * adapter still produces the bank's own shape for a bank that prints a number; a file for an Account the bank numbers none of
 * carries no number at all, and the Admin says which Account it is for.
 */
export const accountKey = z.string().check(z.refine((value) => BANK_NUMBER.test(value) || GENERATED_KEY.test(value)))

/**
 * The one form an Account is stored and matched by: a three-digit suffix with a leading zero loses it, so `-099`
 * and `-99` are the same Account. Expects a string that passed `accountKey`; a generated key has no such suffix to lose, so
 * this leaves one as it is.
 */
export const normaliseAccountNumber = (number: string) => number.replace(/-0(\d{2})$/, '-$1')

/** An NZ calendar date as `YYYY-MM-DD`, which must be a real day (not 30 February). */
export const isoDate = z.string().check(z.refine(isRealDate))
