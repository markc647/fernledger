import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'

// shadcn/ui DropdownMenu, as `npx shadcn@latest add dropdown-menu` writes it for the radix-nova style, trimmed to what the app uses (a menu of actions on a table row: items and a
// separator). It imports `@radix-ui/react-dropdown-menu` rather than the whole `radix-ui` package (CODING_STANDARDS.md: the smallest entry point), and leaves out the `animate-in`
// classes, which need a plugin the app does not have. Built to the README's sizes, so a call site needs no override: 16px text, and an item is 44px tall. The panel has a border as
// well as a shadow, and the highlighted item and the separator are drawn in the palette's own colours in src/index.css, because Windows high contrast removes fills and shadows.
// The destructive item's words are the app's --danger and not the stock --destructive: on the pale red that highlights it, --destructive is 3.97:1 in the light theme, under the 4.5:1 that
// text needs. --danger on the panel is pinned in scripts/theme-contrast.test.mjs; the pale red is translucent, so the contrast of every item, resting and highlighted, as it is painted is
// held in e2e/row-actions.spec.ts.

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({ className, align = 'start', sideOffset = 4, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover p-1 text-base text-popover-foreground shadow-md ring-1 ring-foreground/10',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex min-h-11 cursor-default items-center gap-2 rounded-md px-3 py-2 text-base outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-[variant=destructive]:text-danger data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-danger dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-danger",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger }
