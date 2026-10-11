import { validator } from 'hono/validator'
import * as z from 'zod/mini'

/** The body of a change with nothing to say: the guard (app.ts) wants a JSON body, so the browser sends `{}`, and anything more is refused. */
export const nothing = z.strictObject({})

/**
 * The answer (409) to a change whose reads went stale: another request changed the same thing between this one's reads and its write. The write only changes what was
 * read, so it changed nothing and wrote no Change Log entry. Each request reads afresh, so asking again is all the person has to do. `reason` is for the pages, which cannot
 * otherwise tell this 409 from one that means something else (a Category name already in use).
 */
export const CHANGED_MEANWHILE = { error: 'This changed while your request was being handled. Try again.', reason: 'changed' } as const

/** An ID in a path or a query string: digits only, no sign, exponent or leading zero. At most 15 digits, so Number() reads it exactly (16 digits can pass 2^53). */
export const ID = /^[1-9]\d{0,14}$/

/** The row a path names, or null when the path does not write its ID as it is (`1e1` is 10 to Number(), and is not row 10): the route answers 404. */
export const pathId = (raw: string) => (ID.test(raw) ? Number(raw) : null)

/**
 * Validates a request's JSON body or query string against a zod schema before the handler runs.
 * A refusal names the field, never its value (values can be Transaction data).
 */
export const validate = <Target extends 'json' | 'query', T extends z.ZodMiniType>(target: Target, schema: T) =>
  validator(target, (value, c) => {
    const parsed = z.safeParse(schema, value)
    if (!parsed.success) return c.json({ error: 'Invalid request', field: parsed.error.issues[0]?.path.join('.') ?? '' }, 400)
    return parsed.data as z.output<T>
  })
