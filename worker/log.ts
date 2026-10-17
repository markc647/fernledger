// The only way the Worker writes logs. It takes IDs, counts and an error's class, so an email, token or
// Transaction can't reach a log by accident (README: logs contain only IDs, counts and error types).
const EVENT_NAME = /^[a-z][a-z0-9._-]{0,63}$/

export type LogFields = {
  /** A database row ID. */
  id?: number
  count?: number
  /** Only the error's class is logged, never its message or stack, which often echo the input. */
  error?: unknown
}

const errorClass = (error: unknown): string => {
  const name = error instanceof Error ? error.constructor.name : ''
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'UnknownError'
}

export function logEvent(event: string, fields: LogFields = {}): void {
  const entry: Record<string, string | number> = { event: EVENT_NAME.test(event) ? event : 'invalid-event' }
  if (Number.isSafeInteger(fields.id)) entry.id = fields.id!
  if (Number.isSafeInteger(fields.count)) entry.count = fields.count!
  if ('error' in fields) entry.errorClass = errorClass(fields.error)
  console.log(JSON.stringify(entry))
}
