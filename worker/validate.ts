import { validator } from 'hono/validator'
import * as z from 'zod/mini'

/** The body of a change with nothing to say: the guard (app.ts) wants a JSON body, so the browser sends `{}`, and anything more is refused. */
export const nothing = z.strictObject({})

/** An ID in a path: digits only, no sign, exponent or leading zero, so it is what it looks like. */
const ID = /^[1-9]\d{0,14}$/

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
