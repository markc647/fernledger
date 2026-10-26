import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'

// shadcn/ui Popover, as `npx shadcn@latest add popover` writes it for the radix-nova style, trimmed to what the app uses. It imports `@radix-ui/react-popover`
// rather than the whole `radix-ui` package (CODING_STANDARDS.md: the smallest entry point), and leaves out the `animate-in` classes, which need a plugin the app does not
// have. The panel has a border as well as a shadow (Windows high contrast removes the shadow).

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({ className, align = 'center', sideOffset = 4, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg border border-border bg-popover p-2.5 text-base text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
