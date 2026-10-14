import * as React from 'react'
import * as Slot from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeftIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'

// shadcn/ui Sidebar, as `npx shadcn@latest add sidebar` writes it (new-york-v4, the one sidebar-16 is built on), trimmed to what the app uses and changed where the
// app needs more than the stock one. It imports the smallest Radix entry points (CODING_STANDARDS.md). What it is:
// - The inset variant only, on the left, collapsing to an icon rail on a desktop and a Sheet below Tailwind's `md`. (Leaves out the other variants, the right side, the
//   offcanvas mode, groups with labels and actions, menu badges, skeletons and the search input, which the app has no use for.)
// - Controlled: whether it is open lives in the app (src/routes/__root.tsx), which remembers it on this device. Stock writes a `sidebar_state` cookie instead and
//   expects a server to read it back, which this app does not have.
// - Whether it is a sheet is a media query read by the first render (src/lib/use-media-query.ts), not state set in an effect after it, so a phone never draws the desktop
//   sidebar first. The CSS (`hidden md:block`) agrees with it, so the two cannot disagree for a frame.
// - Rows are 32px tall with a mouse and 44px on a touch screen (README, Accessibility); text is `text-sm`; focus is an outline, which Windows high contrast keeps;
//   the current page has a fill, a hairline and a heavier font, and takes the palette's highlight in Windows high contrast (src/index.css).
// - It is app chrome, so it is left out of a printout.

const SIDEBAR_WIDTH = '15rem'
const SIDEBAR_WIDTH_MOBILE = '18rem'
const SIDEBAR_WIDTH_ICON = '3rem'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'

/** Tailwind's `md` breakpoint, in rem like the CSS: from here up the sidebar sits beside the page, below it is a sheet. */
const DESKTOP_QUERY = '(min-width: 48rem)'

type SidebarContextProps = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  /** The toggle button, which the sheet gives focus back to when it closes. */
  triggerRef: React.RefObject<HTMLButtonElement | null>
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.')
  return context
}

function SidebarProvider({
  open,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = !useMediaQuery(DESKTOP_QUERY)
  const [openMobile, setOpenMobile] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((value) => !value)
    else onOpenChange(!open)
  }, [isMobile, open, onOpenChange])

  // Ctrl or Cmd + B toggles the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])

  const state = open ? 'expanded' : 'collapsed'
  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, open, setOpen: onOpenChange, isMobile, openMobile, setOpenMobile, toggleSidebar, triggerRef }),
    [state, open, onOpenChange, isMobile, openMobile, toggleSidebar],
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          style={{ '--sidebar-width': SIDEBAR_WIDTH, '--sidebar-width-icon': SIDEBAR_WIDTH_ICON, ...style } as React.CSSProperties}
          className={cn('group/sidebar-wrapper flex min-h-svh w-full bg-sidebar print:min-h-0 print:bg-transparent', className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

function Sidebar({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { isMobile, state, openMobile, setOpenMobile, triggerRef } = useSidebar()

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          // Radix gives focus back to its own trigger, and this sheet has none (the toggle is in the header), so without this it is lost to the page when the sheet closes.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
          // The sheet is as wide as the stock 18rem, but never so wide that no page is left to tap on to close it, however large the text.
          className="w-(--sidebar-width) max-w-[calc(100vw-3rem)] bg-sidebar p-0 text-sidebar-foreground"
          style={{ '--sidebar-width': SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Menu</SheetTitle>
            <SheetDescription>The pages of this app.</SheetDescription>
          </SheetHeader>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="absolute end-2 top-2 z-10">
              <XIcon aria-hidden />
              <span className="sr-only">Close menu</span>
            </Button>
          </SheetClose>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block print:hidden"
      data-state={state}
      data-collapsible={state === 'collapsed' ? 'icon' : ''}
      data-variant="inset"
      data-side="left"
      data-slot="sidebar"
    >
      {/* This is what makes room for the sidebar beside the page. */}
      <div
        data-slot="sidebar-gap"
        className="relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
      />
      {/* The sidebar itself is fixed, below the sticky site header, and as tall as what is left of the window. */}
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed top-(--header-height) left-0 z-10 hidden h-[calc(100svh-var(--header-height))] w-(--sidebar-width) p-2 transition-[left,right,width] duration-200 ease-linear md:flex group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]',
          className,
        )}
        {...props}
      >
        <div data-sidebar="sidebar" data-slot="sidebar-inner" className="flex h-full w-full flex-col bg-sidebar">
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar, isMobile, open, openMobile, triggerRef } = useSidebar()
  return (
    <Button
      ref={triggerRef}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      aria-expanded={isMobile ? openMobile : open}
      className={cn('-ml-1', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon aria-hidden />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  )
}

/** The thin strip on the sidebar's edge that a mouse can click to open or close it. Not in the tab order or the accessibility tree: the trigger does that for everyone else. */
function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar, isMobile } = useSidebar()
  if (isMobile) return null // a sheet has no edge to click
  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-hidden="true"
      tabIndex={-1}
      onClick={toggleSidebar}
      className={cn(
        'absolute inset-y-0 -right-4 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize transition-all ease-linear group-data-[state=collapsed]:cursor-e-resize after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex',
        className,
      )}
      {...props}
    />
  )
}

/** The page's raised panel beside the sidebar. A `div`, not stock's `<main>`: the page's own `<main id="main">` is inside it (one main landmark, and the skip link goes to it). */
function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn(
        'relative flex min-w-0 w-full flex-1 flex-col bg-background md:m-2 md:ms-0 md:rounded-xl md:border md:border-border md:shadow-sm md:peer-data-[state=collapsed]:ms-2',
        className,
      )}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-header" data-sidebar="header" className={cn('flex flex-col gap-2 p-2', className)} {...props} />
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-footer" data-sidebar="footer" className={cn('flex flex-col gap-2 p-2', className)} {...props} />
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden', className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-group" data-sidebar="group" className={cn('relative flex w-full min-w-0 flex-col p-2', className)} {...props} />
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn('flex w-full min-w-0 flex-col gap-1', className)} {...props} />
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn('group/menu-item relative', className)} {...props} />
}

const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-sidebar-ring transition-[width,height,padding] group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:outline-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground data-[active=true]:shadow-xs data-[active=true]:ring-1 data-[active=true]:ring-sidebar-border data-[state=open]:hover:bg-sidebar-accent/70 data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      size: {
        // 32px for a mouse; 44px on a touch screen (any row, and an icon of the collapsed rail).
        default: 'h-8 pointer-coarse:min-h-11 pointer-coarse:group-data-[collapsible=icon]:min-w-11',
        lg: 'h-10 group-data-[collapsible=icon]:p-0! pointer-coarse:min-h-11 pointer-coarse:group-data-[collapsible=icon]:min-w-11',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  isActive?: boolean
  /** What names the row while the sidebar is the icon rail, when its words are hidden. */
  tooltip?: string
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : 'button'
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp data-slot="sidebar-menu-button" data-sidebar="menu-button" data-size={size} data-active={isActive} className={cn(sidebarMenuButtonVariants({ size }), className)} {...props} />
  )
  if (!tooltip) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed' || isMobile}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn('mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-s border-sidebar-border px-2.5 py-0.5 group-data-[collapsible=icon]:hidden', className)}
      {...props}
    />
  )
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="sidebar-menu-sub-item" data-sidebar="menu-sub-item" className={cn('group/menu-sub-item relative', className)} {...props} />
}

function SidebarMenuSubButton({ asChild = false, isActive = false, className, ...props }: React.ComponentProps<'a'> & { asChild?: boolean; isActive?: boolean }) {
  const Comp = asChild ? Slot.Root : 'a'
  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-active={isActive}
      className={cn(
        'flex h-8 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sm text-sidebar-foreground outline-sidebar-ring hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:outline-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 pointer-coarse:min-h-11 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground data-[active=true]:shadow-xs data-[active=true]:ring-1 data-[active=true]:ring-sidebar-border',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
}
