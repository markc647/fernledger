import { useQuery, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { DevIdentitySwitcher } from '@/components/dev-identity-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { navFor } from '@/lib/nav'
import { meQuery } from '@/lib/me'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Layout,
})

function Layout() {
  const { data: me, isError } = useQuery(meQuery)

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-10 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>
      {import.meta.env.DEV && <DevIdentitySwitcher />}
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-lg font-semibold">Fernledger</span>
          <nav aria-label="Main">
            <ul className="flex flex-wrap gap-1">
              {navFor(me?.role).map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="inline-flex min-h-11 items-center rounded-lg px-3 hover:bg-muted data-[status=active]:font-semibold data-[status=active]:underline data-[status=active]:underline-offset-4"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ms-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl p-4">
        {isError ? (
          <>
            <h1 className="text-2xl font-semibold">Not signed in</h1>
            <p className="mt-2">Sign in through your usual Fernledger link to see this page.</p>
          </>
        ) : (
          <Outlet />
        )}
      </main>
    </>
  )
}
