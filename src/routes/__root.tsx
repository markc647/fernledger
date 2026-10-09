import { useQuery, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { DevIdentitySwitcher } from '@/components/dev-identity-switcher'
import { TextSizeControl } from '@/components/text-size-control'
import { ThemeToggle } from '@/components/theme-toggle'
import { appTitleQuery, FALLBACK_APP_TITLE } from '@/lib/app-title'
import { isNotSignedIn, meQuery } from '@/lib/me'
import { navFor } from '@/lib/nav'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Layout,
})

const focusStyle = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function Layout() {
  const { data: me, error: meError } = useQuery(meQuery)
  // Until the title arrives the header is blank rather than flashing "Fernledger" over the Admin's own title.
  const { data: loadedTitle, isPending: titlePending } = useQuery(appTitleQuery)
  const appTitle = loadedTitle ?? (titlePending ? '' : FALLBACK_APP_TITLE)
  useEffect(() => {
    if (appTitle) document.title = appTitle
  }, [appTitle])
  const router = useRouter()
  // Each route file declares its own navigation entry in `staticData.nav`.
  const entries = Object.values(router.routesByPath).flatMap((route) =>
    route.options.staticData?.nav ? [{ ...route.options.staticData.nav, to: route.fullPath }] : [],
  )

  return (
    <>
      <a
        href="#main"
        className={`sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-10 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 ${focusStyle}`}
      >
        Skip to main content
      </a>
      {import.meta.env.DEV && <DevIdentitySwitcher />}
      <header className="border-b">
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
