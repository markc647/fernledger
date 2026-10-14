import { Link } from '@tanstack/react-router'
import { ArrowLeftRight, ChartColumn, ChevronRight, CircleHelp, CircleUser, FileText, LayoutDashboard, Settings2, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import type { NavGroupId, NavSection } from '@/lib/nav'
import { roleLabel, type Role } from '@/lib/role'

/** A group's icon. Typed by the group's id, so a group added to `NAV_GROUPS` (src/lib/nav.ts) does not compile until it has one. */
const GROUP_ICONS: Record<NavGroupId, LucideIcon> = {
  transactions: ArrowLeftRight,
  reports: ChartColumn,
  setup: Settings2,
  help: CircleHelp,
}

/** The icons of the links that are in no group, by address. */
const LINK_ICONS: Record<string, LucideIcon> = { '/': LayoutDashboard }

/** A link in no group: the Summary, which the Admin knows as the Dashboard. */
function NavLink({ section, activeTo }: { section: Extract<NavSection, { kind: 'link' }>; activeTo: string | undefined }) {
  const Icon = LINK_ICONS[section.to] ?? FileText
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={activeTo === section.to} tooltip={section.title}>
        {/* Exact, so that "/" is the current page on "/" alone and not on every page. */}
        <Link to={section.to} activeOptions={{ exact: true }}>
          <Icon aria-hidden />
          <span>{section.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * A group of pages that opens and closes. The group holding the current page is open, and opens again when you arrive in it from elsewhere (a Dashboard shortcut, say). While
 * the sidebar is the icon rail the pages have nowhere to show, so a click on the group's icon opens the sidebar and the group.
 */
function NavGroup({ section, activeTo }: { section: Extract<NavSection, { kind: 'group' }>; activeTo: string | undefined }) {
  const { state, isMobile, setOpen: setSidebarOpen } = useSidebar()
  const Icon = GROUP_ICONS[section.id]
  const holdsActive = activeTo !== undefined && section.items.some((item) => item.to === activeTo)
  const [open, setOpen] = useState(holdsActive)
  useEffect(() => {
    if (holdsActive) setOpen(true)
  }, [holdsActive])
  const isRail = state === 'collapsed' && !isMobile

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            tooltip={section.title}
            // "You are here" is on the group only while it is shut, or in the rail where its pages are not shown, so there is one clear highlight.
            isActive={holdsActive && (!open || isRail)}
            onClick={(event) => {
              if (!isRail) return
              event.preventDefault() // stop the group toggling: it opens, and so does the sidebar
              setSidebarOpen(true)
              setOpen(true)
            }}
          >
            <Icon aria-hidden />
            <span>{section.title}</span>
            <ChevronRight aria-hidden className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {section.items.map((item) => (
              <SidebarMenuSubItem key={item.to}>
                <SidebarMenuSubButton asChild isActive={activeTo === item.to}>
                  <Link to={item.to}>
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

export function AppSidebar({
  appTitle,
  sections,
  pathname,
  activeTo,
  email,
  role,
}: {
  appTitle: string
  sections: NavSection[]
  pathname: string
  /** The address of the page that is current, as `trailFor` (src/lib/nav.ts) finds it. */
  activeTo: string | undefined
  email: string | undefined
  role: Role | undefined
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  // On a phone the sidebar is a sheet over the page: going to a page closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile])
  const who = email ?? 'Account'

  return (
    <Sidebar>
      <SidebarHeader className={isMobile ? 'pe-12' : undefined}>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* The title wraps, over as many lines as it needs, rather than being cut short: it is the Admin's own words, and a long one must still be readable. */}
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip={appTitle || 'Fernledger'}
              className="h-auto min-h-10 py-1.5 group-data-[collapsible=icon]:p-1! [&>span:last-child]:whitespace-normal [&>span:last-child]:text-clip"
            >
              {/* Until the Admin's title arrives it is blank rather than "Fernledger" flashing before it, so the link is named for what it does. */}
              <Link to="/" activeOptions={{ exact: true }} aria-label={appTitle ? undefined : 'Home'}>
                <img src="/favicon.svg" alt="" className="size-6 shrink-0 rounded-md" />
                <span className="min-h-6 text-base font-semibold">{appTitle}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="[scrollbar-width:thin]">
        <nav aria-label="Main">
          <SidebarGroup>
            <SidebarMenu className="gap-0.5">
              {sections.map((section) =>
                section.kind === 'link' ? (
                  <NavLink key={section.id} section={section} activeTo={activeTo} />
                ) : (
                  <NavGroup key={section.id} section={section} activeTo={activeTo} />
                ),
              )}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        {/* Who is signed in and what they can do. The controls (text size, theme, Sign out) are in the site header. Not a button: it does nothing. */}
        <div title={who} className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <CircleUser aria-hidden className="size-6 shrink-0 text-sidebar-foreground/70" strokeWidth={1.5} />
          <span className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:sr-only">
            <span className="truncate font-medium">{who}</span>
            {role && <span className="truncate text-muted-foreground">{roleLabel(role)}</span>}
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
