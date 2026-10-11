import { useEffect, useState } from 'react'

/**
 * A status line for screen readers that stays on the page and is filled in as things happen ("Loading…", then "Loaded"). A live region announces a change to its
 * text, not its arrival: one mounted with its words already in it is often not read at all. So it is rendered empty, and `message` reaches it in an effect, after it is
 * in the page. Nothing is shown; say it on the screen too where a sighted reader needs it.
 */
export function LiveStatus({ message }: { message: string }) {
  const [spoken, setSpoken] = useState('')
  useEffect(() => setSpoken(message), [message])
  return (
    <p role="status" className="sr-only">
      {spoken}
    </p>
  )
}
