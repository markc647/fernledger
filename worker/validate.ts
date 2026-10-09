import { validator } from 'hono/validator'
import * as z from 'zod/mini'

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
