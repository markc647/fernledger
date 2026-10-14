import { Link } from '@tanstack/react-router'
import { ArrowLeftRight, ChartColumn, ChevronRight, CircleHelp, CircleUser, LayoutDashboard, Settings2, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NavGroupId, NavSection } from '@/lib/nav'
import { roleLabel, type Role } from '@/lib/role'

/** A group's icon. Typed by the group's id, so a group added to `NAV_GROUPS` (src/lib/nav.ts) does not compile until it has one. */
const GROUP_ICONS: Record<NavGroupId, LucideIcon> = {
  transactions: ArrowLeftRight,
  reports: ChartColumn,
  setup: Settings2,
  help: CircleHelp,
}

/** The sidebar while it is the icon rail, which has no room for words: a group's pages are not shown, and a row is named by a tooltip. */
const useIsRail = () => {
  const { state, isMobile } = useSidebar()
  return state === 'collapsed' && !isMobile
}

/** The link in no group: the Summary, which the Admin knows as the Dashboard. It is the only one there is, so its icon is here and not in a table of them. */
function HomeLink({ section, activeTo }: { section: Extract<NavSection, { kind: 'link' }>; activeTo: string | undefined }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={activeTo === section.to} tooltip={section.label}>
        {/* Exact, so that "/" is the current page on "/" alone and not on every page. */}
        <Link to={section.to} activeOptions={{ exact: true }} onClick={() => setOpenMobile(false)}>
          <LayoutDashboard aria-hidden />
          <span>{section.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * A group of pages that opens and closes: a button that says whether its list is open (`aria-expanded`, and `aria-controls` while there is a list), and the list, which is only in
 * the page while it is open. The group holding the current page is open, and opens again when you arrive in it from elsewhere (a Dashboard shortcut, say). While the sidebar is the
 * icon rail the pages have nowhere to show, so the group does not say it is open then, and a click on its icon opens the sidebar and the group. Whether it is open is remembered
 * through a visit to the rail.
 */
function NavGroup({ section, activeTo, roleKnown }: { section: Extract<NavSection, { kind: 'group' }>; activeTo: string | undefined; roleKnown: boolean }) {
  const { setOpen: setSidebarOpen, setOpenMobile } = useSidebar()
  const isRail = useIsRail()
  const Icon = GROUP_ICONS[section.id]
  const listId = useId()
  const holdsActive = activeTo !== undefined && section.items.some((item) => item.to === activeTo)
  // Until who is signed in is known the sidebar is a Member's, which puts some pages in other groups (Accounts is among the Reports): so the group that holds the page is only opened
  // once that is settled, and an Admin on Accounts is not shown Reports open for a moment and then left with it so.
  const [open, setOpen] = useState(roleKnown && holdsActive)
  useEffect(() => {
    if (roleKnown && holdsActive) setOpen(true)
  }, [roleKnown, holdsActive])
  const expanded = open && !isRail

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        tooltip={section.label}
        className="group/nav"
        // "You are here" is on the group only while its list is shut, so there is one clear mark. (In the rail the list is never shown, so it is on the group there.)
        isActive={holdsActive && !expanded}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => {
          if (isRail) setSidebarOpen(true) // the sidebar opens, and the group with it
          setOpen(isRail ? true : !open)
        }}
      >
        <Icon aria-hidden />
        <span>{section.label}</span>
        <ChevronRight aria-hidden className="ms-auto transition-transform duration-200 group-aria-expanded/nav:rotate-90" />
      </SidebarMenuButton>
      {expanded && (
        <SidebarMenuSub id={listId}>
          {section.items.map((item) => (
            <SidebarMenuSubItem key={item.to}>
              <SidebarMenuSubButton asChild isActive={activeTo === item.to}>
                <Link to={item.to} onClick={() => setOpenMobile(false)}>
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

/** Who is signed in, and what they can do. In the rail only the icon shows, so it is focusable there and says who it is in a tooltip, as the rail's other icons do. */
function SignedIn({ email, role }: { email: string; role: Role | undefined }) {
  const isRail = useIsRail()
  const [pointedAt, setPointedAt] = useState(false)
  const words = role ? `${email}, ${roleLabel(role)}` : email
  return (
    <Tooltip open={isRail && pointedAt} onOpenChange={setPointedAt}>
      <TooltipTrigger asChild>
        <div
          // Only in the rail, where the words are not on the screen: it is a named group that can take focus. Open, it is the words themselves, which a label would only repeat.
          role={isRail ? 'group' : undefined}
          aria-label={isRail ? words : undefined}
          tabIndex={isRail ? 0 : undefined}
          className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm outline-sidebar-ring focus-visible:outline-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <CircleUser aria-hidden className="size-6 shrink-0 text-sidebar-foreground/70" strokeWidth={1.5} />
          <span className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:sr-only">
            <span className="truncate font-medium">{email}</span>
            {role && <span className="truncate text-muted-foreground">{roleLabel(role)}</span>}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="center">
        {words}
      </TooltipContent>
    </Tooltip>
  )
}

export function AppSidebar({
  appTitle,
  sections,
  activeTo,
  roleKnown,
  email,
  role,
}: {
  appTitle: string
  sections: NavSection[]
  /** The address of the page that is current, as `trailFor` (src/lib/nav.ts) finds it. */
  activeTo: string | undefined
  /** Whether who is signed in is known, which is what the first link is called by: until then its place is kept, so the rest does not jump when it arrives. */
  roleKnown: boolean
  email: string | undefined
  role: Role | undefined
}) {
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <Sidebar>
      <SidebarHeader className={isMobile ? 'pe-12' : undefined}>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* The title wraps, over as many lines as it needs, rather than being cut short: it is the Admin's own words, and a long one must still be readable. In the rail only the logo
                shows, so the title is the row's tooltip, and still its name for a screen reader. */}
            <SidebarMenuButton
              asChild
              tooltip={appTitle || 'Fernledger'}
              className="h-auto min-h-10 py-1.5 group-data-[collapsible=icon]:p-1! [&>span:last-child]:whitespace-normal [&>span:last-child]:text-clip"
            >
              {/* Until the Admin's title arrives it is blank rather than "Fernledger" flashing before it, so the link is named for what it does. */}
              <Link to="/" activeOptions={{ exact: true }} aria-label={appTitle ? undefined : 'Home'} onClick={() => setOpenMobile(false)}>
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
              {!roleKnown && <li aria-hidden="true" data-slot="sidebar-menu-pending" className="h-8 rounded-md bg-sidebar-accent/60 pointer-coarse:h-11" />}
              {sections.map((section) =>
                section.kind === 'link' ? (
                  <HomeLink key={section.id} section={section} activeTo={activeTo} />
                ) : (
                  <NavGroup key={section.id} section={section} activeTo={activeTo} roleKnown={roleKnown} />
                ),
              )}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>{email && <SignedIn email={email} role={role} />}</SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
