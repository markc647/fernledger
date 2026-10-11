import * as z from 'zod/mini'
import { isRealDate } from './dates'

/** An Account's display name, as the Admin types it (trimmed, 1 to 60 characters). */
export const accountName = z.string().check(z.trim(), z.minLength(1), z.maxLength(60))

/** A bank account number as the bank prints it: `BB-bbbb-AAAAAAA-SS`, where the suffix may have a third digit (`-099`). */
export const bankAccountNumber = z.string().check(z.regex(/^\d{2}-\d{4}-\d{7}-\d{2,3}$/))

/**
 * The one form an Account is stored and matched by: a three-digit suffix with a leading zero loses it, so `-099`
 * and `-99` are the same Account. Expects a string that passed `bankAccountNumber`.
 */
export const normaliseAccountNumber = (number: string) => number.replace(/-0(\d{2})$/, '-$1')

/** An NZ calendar date as `YYYY-MM-DD`, which must be a real day (not 30 February). */
export const isoDate = z.string().check(z.refine(isRealDate))
