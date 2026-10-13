import { useId, useState } from 'react'
import type { DropdownProps } from 'react-day-picker'
import { enNZ } from 'react-day-picker/locale/en-NZ'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select } from '@/components/ui/select'
import { dayOf, isoDateOf, monthsToShow } from '@/lib/calendar-day'
import { MAX_DATE, MIN_DATE } from '@/lib/date-range'
import { formatDate, nzDate } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The calendar's month and year choices: the app's own Select (the browser's list, which phones and screen readers already know), styled as the other fields are. */
function MonthOrYear({ options, className: _className, style: _style, ...props }: DropdownProps) {
  return (
    <Select {...props} className="w-auto">
      {options?.map(({ value, label, disabled }) => (
        <option key={value} value={value} disabled={disabled}>
          {label}
        </option>
      ))}
    </Select>
  )
}

// Defined once, so the calendar keeps the choice you are on (and its focus) while it redraws.
const COMPONENTS = { Dropdown: MonthOrYear }

// The calendar has no arrows to the next and previous month: its month and year choices, and PageUp and PageDown, take you anywhere. Its caption is the two choices.
const CLASS_NAMES = {
  month_caption: 'flex h-(--cell-size) w-full items-center justify-center',
  dropdowns: 'flex h-(--cell-size) w-full items-center justify-center gap-2 text-base font-medium',
}

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
)

/** The day the calendar opens on when the field is empty: today in NZ, or the nearest date it allows. */
const startingDate = (min: string, max: string) => {
  const today = nzDate()
  return today < min ? min : today > max ? max : today
}

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
  /** Gives the date to a form that is sent without scripting (a Report's, which opens in a new window): a hidden field of this name holds `value`. */
  name?: string
  placeholder?: string
}

/**
 * A date to choose from a calendar, in place of a date input: a button that shows the date as the app writes dates everywhere ("Thu 8 Oct 2026") and opens a calendar with
 * month and year choices, and "Clear date" once there is one (a date input could always be emptied, and a form says what is missing when it is sent). It takes and gives the same
 * `YYYY-MM-DD` text the inputs did ("" for none). Give it the label's `htmlFor` as `id` and the label's own `id` as `labelId`, and
 * `aria-invalid` and `aria-describedby` as an input takes them. Days outside `min` and `max` are shown and cannot be chosen. The calendar opens with Enter or Space, moves with the
 * arrow keys, Home, End, PageUp and PageDown, and closes with Escape, which puts focus back on the button, as choosing a day does.
 */
export function DatePicker({ labelId, value, onChange, min = MIN_DATE, max = MAX_DATE, name, placeholder = 'Choose a date', className, ...button }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const dateId = useId()
  // Something that is not a date (an address with a made-up date in it) shows as no date, as a date input showed it.
  const day = dayOf(value)
  const { start, end } = monthsToShow(min, max, value)
  const choose = (picked: Date) => {
    onChange(isoDateOf(picked))
    setOpen(false)
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="touch"
            // The date may wrap, as an input's text could not: three fields side by side at 200% zoom and the largest text size are narrower than a date.
            className={cn(
              'w-full min-w-0 justify-between border-input bg-background px-3 text-start font-normal whitespace-normal hover:bg-muted dark:border-input dark:bg-background dark:hover:bg-muted',
              !day && 'text-muted-foreground',
              className,
            )}
            aria-labelledby={`${labelId} ${dateId}`}
            {...button}
          >
            <span id={dateId}>{day ? formatDate(value) : placeholder}</span>
            <CalendarIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={8}
          aria-label="Choose a date"
          // Never taller than the room beside the button: on a short screen (a phone turned sideways, or 200% zoom) the calendar scrolls inside itself, since a popover
          // that is partly off the screen cannot be scrolled to.
          className="max-h-(--radix-popover-content-available-height) w-auto gap-0 overflow-y-auto overscroll-contain p-0"
          // Focus goes to the day the arrow keys move from (the chosen day, else today), not to the first choice in the calendar.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const calendar = event.currentTarget as HTMLElement
            calendar.querySelector<HTMLElement>('td button[tabindex="0"]')?.focus()
          }}
        >
          <Calendar
            mode="single"
            required
            selected={day}
            onSelect={choose}
            defaultMonth={dayOf(day ? value : startingDate(min, max))}
            startMonth={start}
            endMonth={end}
            disabled={[{ before: dayOf(min)! }, { after: dayOf(max)! }]}
            today={dayOf(nzDate())}
            locale={enNZ}
            captionLayout="dropdown"
            hideNavigation
            showOutsideDays={false}
            classNames={CLASS_NAMES}
            components={COMPONENTS}
          />
          {value !== '' && (
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
