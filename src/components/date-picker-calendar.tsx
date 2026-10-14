import { useEffect, useRef } from 'react'
import type { DropdownProps } from 'react-day-picker'
import { enNZ } from 'react-day-picker/locale/en-NZ'
import { Calendar } from '@/components/ui/calendar'
import { Select } from '@/components/ui/select'
import { dayOf, monthsToShow } from '@/lib/calendar-day'
import { nzDate } from '@/lib/format'

// The calendar of a DatePicker, in a file of its own so that react-day-picker, date-fns and the NZ locale (most of the weight of a date picker) are downloaded when a calendar
// is first opened and not with every page that has a date field. DatePicker loads it with `lazy`.

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

const COMPONENTS = { Dropdown: MonthOrYear }

/** The day the calendar opens on when the field is empty: today in NZ, or the nearest date it allows. */
const startingDate = (min: string, max: string) => {
  const today = nzDate()
  return today < min ? min : today > max ? max : today
}

type Props = {
  /** The field's date, "2026-10-08", or "" for none. */
  value: string
  min: string
  max: string
  onChoose: (day: Date) => void
}

/** The month of the date (today, when there is none) with the days `min` to `max` to choose from. Focus goes to the day the arrow keys move from. */
export default function DatePickerCalendar({ value, min, max, onChoose }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const day = dayOf(value)
  const { start, end } = monthsToShow(min, max, value)

  // On the calendar's arrival, which is after the dialog's if the code for it had to be fetched: focus goes to the day the arrow keys move from, the chosen day or else today.
  // (A month with no day to choose has none, and the dialog keeps the focus DatePicker gave it.)
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('td button[tabindex="0"]')?.focus()
  }, [])

  return (
    <div ref={root}>
      <Calendar
        mode="single"
        required
        selected={day}
        onSelect={onChoose}
        defaultMonth={day ?? dayOf(startingDate(min, max))}
        startMonth={start}
        endMonth={end}
        disabled={[{ before: dayOf(min)! }, { after: dayOf(max)! }]}
        today={dayOf(nzDate())}
        locale={enNZ}
        components={COMPONENTS}
      />
    </div>
  )
}
