import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { VariantProps } from 'class-variance-authority'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// shadcn/ui AlertDialog (a modal question that is answered, not dismissed), in the registry's shape: Root, Trigger, Content (with its overlay), Header, Footer, Title, Description,
// Action and Cancel. The registry builds it on `@radix-ui/react-alert-dialog`, which is a few lines over `@radix-ui/react-dialog`, already here for the Sheet; those few lines are
// below, so the app has no package more (CODING_STANDARDS.md, Dependencies): the dialog's role is "alertdialog", and a press or a tap outside it does not close it. Escape still does,
// as the answer "no". Unlike Radix's, focus does not go to Cancel when it opens: the caller says where, with `onOpenAutoFocus` (the Rules page puts it on the answer that carries on).
// It slides nowhere: it fades in with the overlay, which `src/index.css` takes away under reduced motion. The panel has a border as well as a shadow (Windows high contrast removes the shadow).

function AlertDialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

/** What opens the question. Radix gives focus back to it when the question is answered no, which it cannot while it is off (a run that is going). */
function AlertDialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn('fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in print:hidden', className)}
      {...props}
    />
  )
}

/** The panel, centred. It is never taller than the screen: when the words are longer than the room (large text on a phone) it scrolls, and its buttons, being in it, bring the part they are in into view. */
function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <AlertDialogOverlay />
      <DialogPrimitive.Content
        data-slot="alert-dialog-content"
        role="alertdialog"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg outline-hidden data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in print:hidden',
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-header" className={cn('flex flex-col gap-1.5 text-start', className)} {...props} />
}

/** Cancel, then the answer that carries on, in that order on a screen and for the keyboard. They wrap, rather than shrink, when the room is short. */
function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-footer" className={cn('flex flex-wrap justify-end gap-2', className)} {...props} />
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="alert-dialog-title" className={cn('text-lg font-semibold', className)} {...props} />
}

function AlertDialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="alert-dialog-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}

type ButtonLook = VariantProps<typeof buttonVariants>

/** The answer that carries on. It closes the question and runs the caller's `onClick`. A touch target, as every button is. */
function AlertDialogAction({ className, variant = 'default', size = 'touch', ...props }: React.ComponentProps<typeof DialogPrimitive.Close> & ButtonLook) {
  return <DialogPrimitive.Close data-slot="alert-dialog-action" className={cn(buttonVariants({ variant, size }), 'max-w-full py-2 whitespace-normal', className)} {...props} />
}

/** The answer that does not. It closes the question, and focus goes back to the trigger. */
function AlertDialogCancel({ className, variant = 'outline', size = 'touch', ...props }: React.ComponentProps<typeof DialogPrimitive.Close> & ButtonLook) {
  return <DialogPrimitive.Close data-slot="alert-dialog-cancel" className={cn(buttonVariants({ variant, size }), 'max-w-full py-2 whitespace-normal', className)} {...props} />
}

export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogOverlay, AlertDialogTitle, AlertDialogTrigger }
