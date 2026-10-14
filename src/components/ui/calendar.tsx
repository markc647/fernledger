import * as React from 'react'
import { DayPicker, getDefaultClassNames, type DayButton, type RootProps } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// shadcn/ui Calendar (react-day-picker), as `npx shadcn@latest add calendar` writes it for the radix-nova style, cut down to the one thing the app uses it for, a single month
// with its month and year chosen from dropdowns (the caller supplies them as `components.Dropdown`): no arrows to other months, no ranges, no week numbers, no outside days.
// Other changes for the app: sizes are in rem and a day is a 44px target (README Accessibility), the focus ring is solid, as in Button, because the stock 50% ring fails 3:1, and a
// chosen day also has an outline, which Windows high contrast keeps and a fill it does not. The cell has the ISO date as its `data-day`, which is what a browser test looks for.

// Defined once, here, because a component made inside Calendar would be a new one on every render and remount the whole calendar.
function CalendarRoot({ className, rootRef, ...props }: RootProps) {
  return <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />
}

function CalendarDayButton({ className, day: _day, modifiers, ...props }: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      data-selected-single={modifiers.selected}
      className={cn(
        'relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 p-0 text-base leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[selected-single=true]:outline-2 data-[selected-single=true]:-outline-offset-2 data-[selected-single=true]:outline-foreground dark:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

const COMPONENTS = { Root: CalendarRoot, DayButton: CalendarDayButton }

function Calendar({ className, classNames, components, ...props }: React.ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      // A day is 44px wide, but never so wide that seven of them do not fit a phone (with the text at its largest, 2.75rem is wider than the screen).
      className={cn('group/calendar bg-background p-2 [--cell-radius:var(--radius-md)] [--cell-size:min(2.75rem,calc((100vw_-_3rem)/7))] in-data-[slot=popover-content]:bg-transparent', className)}
      captionLayout="dropdown"
      hideNavigation
      showOutsideDays={false}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        month_caption: cn('flex h-(--cell-size) w-full items-center justify-center', defaultClassNames.month_caption),
        dropdowns: cn('flex h-(--cell-size) w-full items-center justify-center gap-2 text-base font-medium', defaultClassNames.dropdowns),
        month_grid: cn('w-full border-collapse', defaultClassNames.month_grid),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn('flex-1 rounded-(--cell-radius) text-[0.9375rem] font-normal text-muted-foreground select-none', defaultClassNames.weekday),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        day: cn('group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none', defaultClassNames.day),
        today: cn('rounded-(--cell-radius) bg-muted text-foreground', defaultClassNames.today),
        disabled: cn('text-muted-foreground opacity-50', defaultClassNames.disabled),
        ...classNames,
      }}
      components={{ ...COMPONENTS, ...components }}
      {...props}
    />
  )
}

export { Calendar }
