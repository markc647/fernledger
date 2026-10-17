import { useQuery, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, useRouter, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { DevIdentitySwitcher } from '@/components/dev-identity-switcher'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { deviceStorage } from '@/lib/device-storage'
import { isNotSignedIn, meQuery } from '@/lib/me'
import { navSections, trailFor } from '@/lib/nav'
import { FALLBACK_APP_TITLE, settingsQuery } from '@/lib/settings'
import { loadSidebarChoice, saveSidebarChoice, sidebarIsOpen, SIDEBAR_WIDE_QUERY } from '@/lib/sidebar-state'
import { useMediaQuery } from '@/lib/use-media-query'
import { useTextSize } from '@/lib/use-text-size'
import { useTheme } from '@/lib/use-theme'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Layout,
})

const focusStyle = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function Layout() {
  const { data: me, error: meError } = useQuery(meQuery)
  // Until the title arrives the sidebar's title is blank rather than flashing "Fernledger" over the Admin's own title.
  // The Settings screen writes its saved Settings into this same query, so the sidebar changes without a reload.
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
  const sections = navSections(entries, me?.role)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const trail = trailFor(entries, me?.role, pathname) // through every page, so a page that is not in this reader's sidebar still says where it is

  // These three are the layout's, so they stay mounted: following the device's theme, and a text size or sidebar remembered on this device, keep working
  // while the controls themselves are out of sight (in a phone's menu, or in the sheet).
  const { theme, toggle: toggleTheme } = useTheme()
  const { size: textSize, choose: chooseTextSize } = useTextSize()
  // The sidebar starts open on a wide screen and as the icon rail on a narrower one (src/lib/sidebar-state.ts) until the person opens or closes it.
  const [sidebarChoice, setSidebarChoice] = useState(() => loadSidebarChoice(deviceStorage()))
  const wide = useMediaQuery(SIDEBAR_WIDE_QUERY)
  const sidebarOpen = sidebarIsOpen(sidebarChoice, wide)
  const chooseSidebar = useCallback((open: boolean) => {
    setSidebarChoice(open ? 'open' : 'closed')
    saveSidebarChoice(open, deviceStorage())
  }, [])

  return (
    <>
      <a
        href="#main"
        className={`sr-only print:hidden focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-60 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 ${focusStyle}`}
      >
        Skip to main content
      </a>
      {/* shadcn's sidebar-16: a sticky header across the top, and below it the sidebar beside the page's raised panel. The header and the sidebar are app chrome, so
          neither is printed. A page that wants the title in its printout writes it itself, as How to sign in does. */}
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={chooseSidebar}
        className="flex-col"
      >
        <SiteHeader group={trail.group} groupTo={trail.parent} page={trail.page ?? appTitle} textSize={textSize} onTextSize={chooseTextSize} theme={theme} onToggleTheme={toggleTheme} />
        <div className="flex flex-1">
          <AppSidebar appTitle={appTitle} sections={sections} activeTo={trail.to} roleKnown={roleKnown} email={me?.email} role={me?.role} />
          {/* On paper the page is the paper's: no margin for the sidebar (important, because the collapsed sidebar's margin is more specific), no rounded edge or shadow. */}
          <SidebarInset className="print:m-0! print:rounded-none! print:border-0! print:shadow-none!">
            {/* Local development only: inside the panel, because the sidebar is fixed to the left edge. */}
            {import.meta.env.DEV && <DevIdentitySwitcher />}
            <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl p-4 md:p-6">
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
          </SidebarInset>
        </div>
      </SidebarProvider>
    </>
  )
}
