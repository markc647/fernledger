import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '@/lib/utils'

// shadcn/ui Toggle Group, trimmed to the one look the app uses (the outline variant, joined) and written without shadcn's separate Toggle, so the only package is
// `@radix-ui/react-toggle-group` (CODING_STANDARDS.md: the smallest entry point). Differences from the stock look, all for the README's Accessibility section:
// - The chosen item is solid (`bg-primary`), not the faint `bg-accent`, and in Windows high contrast it takes the palette's highlight (src/index.css).
// - Focus is an outline (the box-shadow ring the stock look draws is removed by Windows high contrast), and it is drawn over the neighbouring item.
// - 32px tall with a mouse and 44px on a touch screen (README, Accessibility).
// A `type="single"` group is a group of radio buttons to a screen reader (`role="radio"`, `aria-checked`); the arrow keys move between them and Space or Enter chooses.

function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return <ToggleGroupPrimitive.Root data-slot="toggle-group" className={cn('flex w-fit items-center rounded-md shadow-xs', className)} {...props} />
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex h-8 min-w-0 shrink-0 items-center justify-center gap-2 border border-border bg-background px-3 text-sm font-medium whitespace-nowrap transition-colors select-none first:rounded-s-md last:rounded-e-md not-first:-ms-px hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground pointer-coarse:h-11 pointer-coarse:min-w-11 dark:border-input',
        className,
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
