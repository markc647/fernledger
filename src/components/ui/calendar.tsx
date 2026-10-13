import * as React from 'react'
import { DayPicker, getDefaultClassNames, type DayButton } from 'react-day-picker'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// shadcn/ui Calendar (react-day-picker), as `npx shadcn@latest add calendar` writes it for the radix-nova style, with these changes for this app:
// the chevrons are drawn inline (the app has no icon library); sizes are in rem and a day is a 44px target (README Accessibility); the focus ring is solid, as
// in Button, because the stock 50% ring fails 3:1; a selected day also has an outline, which Windows high contrast keeps and a fill it does not; and the
// calendar gives up its own `rtl:` rules and `data-day` on the button (the cell has the ISO date as its `data-day`).

function Chevron({ className, orientation = 'down' }: { className?: string; orientation?: 'left' | 'right' | 'up' | 'down' }) {
  const points = { left: '15 18 9 12 15 6', right: '9 18 15 12 9 6', up: '18 15 12 9 6 15', down: '6 9 12 15 18 9' }[orientation]
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-4', className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points={points} />
    </svg>
  )
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  buttonVariant = 'ghost',
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>['variant']
}) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        // A day is 44px wide, but never so wide that seven of them do not fit a phone (with the text at its largest, 2.75rem is wider than the screen).
        'group/calendar bg-background p-2 [--cell-radius:var(--radius-md)] [--cell-size:min(2.75rem,calc((100vw_-_3rem)/7))] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent',
        className,
      )}
      captionLayout={captionLayout}
      formatters={formatters}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4 md:flex-row', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn('absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1', defaultClassNames.nav),
        button_previous: cn(buttonVariants({ variant: buttonVariant }), 'size-(--cell-size) p-0 select-none aria-disabled:opacity-50', defaultClassNames.button_previous),
        button_next: cn(buttonVariants({ variant: buttonVariant }), 'size-(--cell-size) p-0 select-none aria-disabled:opacity-50', defaultClassNames.button_next),
        month_caption: cn('flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)', defaultClassNames.month_caption),
        dropdowns: cn('flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-base font-medium', defaultClassNames.dropdowns),
        dropdown_root: cn('relative rounded-(--cell-radius)', defaultClassNames.dropdown_root),
        dropdown: cn('absolute inset-0 bg-popover opacity-0', defaultClassNames.dropdown),
        caption_label: cn(
          'font-medium select-none',
          captionLayout === 'label' ? 'text-base' : 'flex items-center gap-1 rounded-(--cell-radius) text-base [&>svg]:size-3.5 [&>svg]:text-muted-foreground',
          defaultClassNames.caption_label,
        ),
        month_grid: cn('w-full border-collapse', defaultClassNames.month_grid),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn('flex-1 rounded-(--cell-radius) text-[0.9375rem] font-normal text-muted-foreground select-none', defaultClassNames.weekday),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        week_number_header: cn('w-(--cell-size) select-none', defaultClassNames.week_number_header),
        week_number: cn('text-[0.9375rem] text-muted-foreground select-none', defaultClassNames.week_number),
        day: cn(
          'group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)',
          props.showWeekNumber ? '[&:nth-child(2)[data-selected=true]_button]:rounded-l-(--cell-radius)' : '[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)',
          defaultClassNames.day,
        ),
        range_start: cn('relative isolate z-0 rounded-l-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-muted', defaultClassNames.range_start),
        range_middle: cn('rounded-none', defaultClassNames.range_middle),
        range_end: cn('relative isolate z-0 rounded-r-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-muted', defaultClassNames.range_end),
        today: cn('rounded-(--cell-radius) bg-muted text-foreground data-[selected=true]:rounded-none', defaultClassNames.today),
        outside: cn('text-muted-foreground aria-selected:text-muted-foreground', defaultClassNames.outside),
        disabled: cn('text-muted-foreground opacity-50', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...props }) => <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />,
        Chevron: ({ className, orientation }) => <Chevron className={className} orientation={orientation} />,
        DayButton: CalendarDayButton,
        WeekNumber: ({ children, ...props }) => (
          <td {...props}>
            <div className="flex size-(--cell-size) items-center justify-center text-center">{children}</div>
          </td>
        ),
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({ className, day: _day, modifiers, ...props }: React.ComponentProps<typeof DayButton>) {
  const defaultClassNames = getDefaultClassNames()

  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-selected-single={modifiers.selected && !modifiers.range_start && !modifiers.range_end && !modifiers.range_middle}
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        'relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 text-base leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-muted data-[range-middle=true]:text-foreground data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[selected-single=true]:outline-2 data-[selected-single=true]:-outline-offset-2 data-[selected-single=true]:outline-foreground dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70',
        defaultClassNames.day,
        className,
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
