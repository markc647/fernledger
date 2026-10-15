import { Link } from '@tanstack/react-router'
import { LogOut, SlidersHorizontal } from 'lucide-react'
import { TextSizeControl } from '@/components/text-size-control'
import { ThemeToggle } from '@/components/theme-toggle'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import type { TextSize } from '@/lib/text-size'
import type { Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

/** Cloudflare Access's sign-out path on this app's own hostname (README, What it does). */
const SIGN_OUT_PATH = '/cdn-cgi/access/logout'

/**
 * Access answers this path itself, before the Worker, so this is a plain link (a full page load), not a route or a fetch. It needs no API data, so it is shown even
 * when who is signed in can't be read. Local development has no Access: there it only reaches the app's fallback page.
 */
function SignOut({ className }: { className?: string }) {
  return (
    <a href={SIGN_OUT_PATH} className={cn(buttonVariants({ variant: 'outline', size: 'compact' }), className)}>
      <LogOut aria-hidden />
      Sign out
    </a>
  )
}

/**
 * The bar across the top of every page, which stays there as the page scrolls (shadcn's sidebar-16): the sidebar toggle, then where the page is, then the text size,
 * the theme and Sign out. From `md` up the controls sit in the bar. On a phone they fold into one menu so the bar is still one row at 320px and the largest text.
 * Navigation and display controls mean nothing on paper, so none of it is printed. A page that wants the title in its printout writes it itself.
 */
export function SiteHeader({
  group,
  groupTo,
  page,
  textSize,
  onTextSize,
  theme,
  onToggleTheme,
}: {
  group?: string
  /** For a page that belongs to another page (a Report, to Reports): the address of that page, which the group is a link to. It is a link at every width, because on a phone it is the way back. */
  groupTo?: string
  page: string
  textSize: TextSize
  onTextSize: (size: TextSize) => void
  theme: Theme
  onToggleTheme: () => void
}) {
  return (
    <header className="sticky top-0 z-50 flex w-full items-center bg-sidebar text-sidebar-foreground print:hidden">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-3 md:px-4">
        <SidebarTrigger />
        <Separator className="me-1 h-4" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap gap-1.5 text-sm sm:gap-2">
            {group && (
              <>
                {groupTo ? (
                  <BreadcrumbItem className="shrink-0">
                    <BreadcrumbLink asChild>
                      {/* Exact, or the router marks it as the current page, which the page after it is. */}
                      <Link to={groupTo} activeOptions={{ exact: true }}>
                        {group}
                      </Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                ) : (
                  <BreadcrumbItem className="hidden sm:inline-flex">{group}</BreadcrumbItem>
                )}
                <BreadcrumbSeparator className={groupTo ? undefined : 'hidden sm:block'} />
              </>
            )}
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate font-medium">{page}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="ms-auto hidden items-center gap-2 md:flex">
          <TextSizeControl size={textSize} onChange={onTextSize} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <SignOut />
        </div>

        <div className="ms-auto md:hidden">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Display settings and sign out">
                <SlidersHorizontal aria-hidden />
              </Button>
            </PopoverTrigger>
            {/* On a short or landscape screen, or with the largest text, the menu is as tall as the room there is, and scrolls. */}
            <PopoverContent align="end" className="max-h-(--radix-popover-content-available-height) w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto">
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">Text size</span>
                <TextSizeControl size={textSize} onChange={onTextSize} className="w-full" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Colour theme</span>
                <ThemeToggle theme={theme} onToggle={onToggleTheme} />
              </div>
              <SignOut className="justify-start" />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>
  )
}
