import { lazy, Suspense, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { dayOf, isoDateOf } from '@/lib/calendar-day'
import { MAX_DATE, MIN_DATE } from '@/lib/date-range'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// The calendar is fetched when one is first opened (it is most of the weight of a date picker: react-day-picker, date-fns and the locale).
const DatePickerCalendar = lazy(() => import('@/components/date-picker-calendar'))

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
)

type DatePickerProps = Omit<React.ComponentProps<typeof Button>, 'value' | 'onChange' | 'children' | 'type' | 'variant' | 'size' | 'id' | 'aria-labelledby'> & {
  /** The `htmlFor` of the field's label. */
  id: string
  /** The `id` of that label: the button's name is the label and then the date, so the date is spoken and a voice command can use either ("Label in Name", WCAG 2.5.3). */
  labelId: string
  /** The date as Fernledger stores it, "2026-10-08" (an NZ calendar date), or "" for none. */
  value: string
  onChange: (value: string) => void
  /** The earliest and latest date it allows, written the same way: days outside them cannot be chosen, and the year choices stop at them. Default: the years the API accepts. */
  min?: string
  max?: string
  /** Gives the date to a form that reads its fields as a plain form sends them (a Report's, which puts them in the Report's address): a hidden field of this name holds `value`. */
  name?: string
  /** The calendar offers "Clear date" once there is a date, as a date input could always be emptied. Off where the form has its own way to clear it. */
  clearable?: boolean
}

/**
 * A date to choose from a calendar, in place of a date input: a button that shows the date as the app writes dates everywhere ("Thu 8 Oct 2026") and opens a calendar with
 * month and year choices. It takes and gives the same `YYYY-MM-DD` text the inputs did ("" for none). Give it the label's `htmlFor` as `id` and the label's own `id` as `labelId`,
 * and `aria-invalid` and `aria-describedby` as an input takes them. Days outside `min` and `max` are shown and cannot be chosen. The calendar opens with Enter or Space, moves with the
 * arrow keys, Home, End, PageUp and PageDown, and closes with Escape, which puts focus back on the button, as choosing a day does.
 */
export function DatePicker({ id, labelId, value, onChange, min = MIN_DATE, max = MAX_DATE, name, clearable = true, className, ...button }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const dateId = useId()
  // Something that is not a date (an address with a made-up date in it) shows as no date, as a date input showed it.
  const day = dayOf(value)
  const choose = (picked: Date) => {
    onChange(isoDateOf(picked))
    setOpen(false)
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="field"
            size="touch"
            // The box is never narrower than its longest date (--date-field-min, src/index.css) and the date never wraps, whatever the text size. A row of boxes makes room by
            // starting a new line (`date-fields` in src/index.css, or flex-wrap), not by squeezing one.
            className={cn('w-full min-w-(--date-field-min) px-3', !day && 'text-muted-foreground', className)}
            aria-labelledby={`${labelId} ${dateId}`}
            {...button}
          >
            <span id={dateId} className="whitespace-nowrap">
              {day ? formatDate(value) : 'Choose a date'}
            </span>
            <CalendarIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={8}
          aria-labelledby={labelId}
          // Never taller than the room beside the button: on a short screen (a phone turned sideways, or 200% zoom) the calendar scrolls inside itself, since a popover
          // that is partly off the screen cannot be scrolled to.
          className="max-h-(--radix-popover-content-available-height) w-auto gap-0 overflow-y-auto overscroll-contain p-0"
          // Focus goes to the calendar's day when it arrives (DatePickerCalendar), not to the first choice in it; until then, to the dialog, so it is not left on the button.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const dialog = event.currentTarget as HTMLElement
            if (!dialog.contains(document.activeElement)) dialog.focus()
          }}
          // Pressing the field's label presses its button, which closes the calendar; closing it here as well would have that press open it again.
          onInteractOutside={(event) => {
            if (event.target instanceof Element && event.target.closest(`label[for="${CSS.escape(id)}"]`)) event.preventDefault()
          }}
        >
          <Suspense fallback={<p role="status" className="p-4">Loading the calendar…</p>}>
            <DatePickerCalendar value={value} min={min} max={max} onChoose={choose} />
          </Suspense>
          {clearable && value !== '' && (
            <div className="border-t p-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="w-full"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
              >
                Clear date
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {name && <input type="hidden" name={name} value={value} />}
    </>
  )
}
