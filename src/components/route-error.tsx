import { useEffect } from 'react'
import { api } from '@/lib/api'

/**
 * What a page shows when it could not be drawn, most often because its code could not be fetched (a deploy has replaced it, or the network failed). The code is a file of the app's
 * own, and when the sign-in has run out Access answers the request for it with a redirect to its sign-in page, which the browser refuses to follow: the same thing as any API call
 * meeting it, but it fails in the router, which says nothing of why. So it asks who is signed in, through the API client, which says "your sign-in has expired" (src/lib/session.ts) if that
 * is what has happened, and the page's layout shows it over this.
 */
export function RouteError() {
  useEffect(() => {
    void api.me.$get().catch(() => undefined)
  }, [])
  return (
    <>
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2">Fernledger couldn't show this page. Reload the page to try again.</p>
    </>
  )
}
