import { useQuery, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { DevIdentitySwitcher } from '@/components/dev-identity-switcher'
import { TextSizeControl } from '@/components/text-size-control'
import { ThemeToggle } from '@/components/theme-toggle'
import { isNotSignedIn, meQuery } from '@/lib/me'
import { navFor } from '@/lib/nav'
import { FALLBACK_APP_TITLE, settingsQuery } from '@/lib/settings'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Layout,
})

const focusStyle = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function Layout() {
  const { data: me, error: meError } = useQuery(meQuery)
  // Until the title arrives the header is blank rather than flashing "Fernledger" over the Admin's own title.
  // The Settings screen writes its saved Settings into this same query, so the header changes without a reload.
  const { data: settings, isPending: titlePending } = useQuery(settingsQuery)
  const appTitle = settings?.app_title ?? (titlePending ? '' : FALLBACK_APP_TITLE)
  useEffect(() => {
    if (appTitle) document.title = appTitle
  }, [appTitle])
  const router = useRouter()
  // Each route file declares its own navigation entry in `staticData.nav`.
  // A link the Admin knows by another name waits until who is signed in is known, so it is never the Member's name for a moment and then the Admin's.
  const roleKnown = me !== undefined || meError !== null
  const entries = Object.values(router.routesByPath).flatMap((route) =>
    route.options.staticData?.nav && (roleKnown || !route.options.staticData.nav.adminLabel) ? [{ ...route.options.staticData.nav, to: route.fullPath }] : [],
  )

  return (
    <>
      <a
        href="#main"
        className={`sr-only print:hidden focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-10 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 ${focusStyle}`}
      >
        Skip to main content
      </a>
      {import.meta.env.DEV && <DevIdentitySwitcher />}
      {/* Navigation and the text-size and theme controls mean nothing on paper. A page that wants the title in its printout writes it itself. */}
      <header className="border-b print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="min-h-7 min-w-0 text-lg font-semibold">{appTitle}</span>
          <nav aria-label="Main">
            <ul className="flex flex-wrap gap-1">
              {navFor(entries, me?.role).map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={`inline-flex min-h-11 items-center rounded-lg px-3 hover:bg-muted data-[status=active]:font-semibold data-[status=active]:underline data-[status=active]:underline-offset-4 ${focusStyle}`}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ms-auto flex flex-wrap gap-x-4 gap-y-2">
            <TextSizeControl />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl p-4">
        {meError ? (
          isNotSignedIn(meError) ? (
            <>
              <h1 className="text-2xl font-semibold">Not signed in</h1>
              <p className="mt-2">Sign in through your usual Fernledger link to see this page.</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">Something went wrong</h1>
              <p className="mt-2">Fernledger couldn't load your details. Reload the page to try again.</p>
            </>
          )
        ) : (
          <Outlet />
        )}
      </main>
    </>
  )
}
