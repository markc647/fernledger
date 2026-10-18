import { useEffect, useState } from 'react'

/**
 * `value` once it has stayed the same for `ms` (a primitive: it is compared by `Object.is`). The first value is returned at once, so a box that starts with a value has its answer without waiting.
 * When `restartOn` changes (a form that opens, for a box that starts with a value only then) the value is taken at once as well, and the wait is for the changes after it.
 */
export function useDebounced<T>(value: T, ms: number, restartOn?: unknown): T {
  const [settled, setSettled] = useState(value)
  const [restarted, setRestarted] = useState(restartOn)
  if (!Object.is(restarted, restartOn)) {
    // Set while rendering, which React draws again at once with the new state (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
    setRestarted(restartOn)
    setSettled(value)
  }
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
