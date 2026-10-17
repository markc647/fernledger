import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { signInAgainUrl, type SessionProblem } from '@/lib/session'

const focusStyle = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * What the page says in place of itself when the API shows the visitor is not signed in (src/lib/session.ts): two different things.
 *
 * - **expired**: Cloudflare Access's session ran out, so it answered with its sign-in page's address. Signing in again mends it, and "Sign in again" is a full page load of
 *   this page's own address, which Access sends to its sign-in and back. The length of the session is the Admin's setting in Access (docs/setup.md), so the words say "after a
 *   while, usually every day" and not a number.
 * - **not-signed-in**: Access let the visitor through and the Worker did not accept the token (a wrong Access application or team domain in its secrets, say). Signing in again
 *   would not change that, so there is no button, only where to turn.
 *
 * Focus goes to the heading when it appears, so a person who was saving something, and whose page has just been replaced, is told.
 */
export function SessionProblemPage({ problem }: { problem: SessionProblem }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [problem])
  return problem === 'expired' ? (
    <>
      <h1 ref={heading} tabIndex={-1} className={`text-2xl font-semibold ${focusStyle}`}>
        Your sign-in has expired
      </h1>
      <p className="mt-2">For your security, Fernledger asks you to sign in again after a while, usually every day. You will come back to this page.</p>
      <Button size="touch" className="mt-4" onClick={() => window.location.assign(signInAgainUrl(window.location, Date.now()))}>
        Sign in again
      </Button>
    </>
  ) : (
    <>
      <h1 ref={heading} tabIndex={-1} className={`text-2xl font-semibold ${focusStyle}`}>
        Not signed in
      </h1>
      <p className="mt-2">Sign in through your usual Fernledger link to see this page.</p>
    </>
  )
}
