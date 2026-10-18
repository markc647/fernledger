import { useEffect, useRef } from 'react'
import { buttonVariants, Button } from '@/components/ui/button'
import { signInAgainUrl, type SessionProblem } from '@/lib/session'
import { cn } from '@/lib/utils'

const focusStyle = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * What the API calls have found wrong with the visitor's sign-in (src/lib/session.ts), in two different things:
 *
 * - **expired**: Cloudflare Access's session ran out, so it answered with its sign-in page's address. Signing in again mends it. The length of the session is the Deployer's setting in
 *   Access (docs/setup.md), so the words say "after a while, usually every day" and not a number.
 * - **not-signed-in**: Access let the visitor through and the Worker did not accept the token (a wrong Access application or team domain in its secrets, say). Signing in again
 *   would not change that, so there is no button, only to reload.
 *
 * `SessionProblemPage` is the whole page, for when nothing has loaded yet: there is nothing to lose, and its "Sign in again" loads this page's own address in this tab, which Access
 * sends to its sign-in and back. Once the page has loaded it is `SessionBanner` over it instead (the page and what was typed in it stay), and none of it takes focus: a background read
 * (the allowance's, a refetch when the window is used again) can raise it, and must not move a reader who is somewhere else.
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
      <p className="mt-2">Sign in through your usual Fernledger link to see this page. If you have just done that, reload the page to try again.</p>
    </>
  )
}

/**
 * The same, over a page that has loaded. It stays at the top of the window under the header, so it is seen from anywhere on a long page, and is an alert, so that a screen reader says it
 * when a save that has just been pressed meets it. "Sign in again" opens Access's sign-in in a new tab (this page's address with a new value on its query, `signInAgainUrl`), so what
 * is on this page stays where it is; the next call that works, a save pressed again, takes the banner away.
 */
export function SessionBanner({ problem }: { problem: SessionProblem }) {
  return (
    <div role="alert" className="sticky top-(--header-height) z-40 mb-4 rounded-lg border-2 border-warning bg-background p-4 text-foreground print:hidden">
      {problem === 'expired' ? (
        <>
          <p className="font-medium">Your sign-in has expired. Sign in again, then save again; nothing on this page has been lost.</p>
          <a
            href={signInAgainUrl(window.location, Date.now())}
            target="_blank"
            rel="noopener"
            className={cn(buttonVariants({ size: 'touch' }), 'mt-2', focusStyle)}
          >
            Sign in again<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </>
      ) : (
        <p className="font-medium">Not signed in. Fernledger couldn't confirm who you are. Try again; if it keeps happening, reload the page (anything unsaved here will be lost).</p>
      )}
    </div>
  )
}
