import * as React from 'react'
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'

// shadcn/ui Sheet, trimmed to what the app uses: the sidebar on a phone, a panel that slides in from the left, and a page's help (HelpSheet), a panel from the right. It imports
// `@radix-ui/react-dialog` rather than the whole `radix-ui` package (CODING_STANDARDS.md: the smallest entry point). It slides with the `animate-sheet-*` utilities in
// src/index.css, not the `tw-animate-css` plugin the stock Sheet needs: a dozen lines of CSS rather than a package. It is left out of a printout, and has a border as well as
// a shadow (Windows high contrast removes the shadow). The close button is the caller's to place: a part of the sidebar's own header, and the foot of a help sheet.

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

/** What opens the sheet. Radix gives focus back to it when the sheet closes, which a sheet with no trigger (the sidebar's) has to do for itself. */
function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn('fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in print:hidden', className)}
      {...props}
    />
  )
}

/** `side` is the edge it slides in from: the left (the default), or the right. Each draws its border on the edge that faces the page. */
function SheetContent({ className, children, side = 'left', ...props }: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: 'left' | 'right' }) {
  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 z-50 flex h-full w-3/4 max-w-sm flex-col gap-4 border-border bg-background shadow-lg outline-hidden print:hidden',
          side === 'left'
            ? 'start-0 border-e data-[state=closed]:animate-sheet-out data-[state=open]:animate-sheet-in'
            : 'end-0 border-s data-[state=closed]:animate-sheet-out-end data-[state=open]:animate-sheet-in-end',
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-footer" className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn('font-semibold text-foreground', className)} {...props} />
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}

export { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger, SheetDescription }
