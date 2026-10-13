import { expect, type Locator, type Page } from '@playwright/test'
import { dateText } from './report-helpers'

// How a spec chooses and checks a date in a DatePicker (src/components/date-picker.tsx). `pickDate` drives the real calendar the way a person does: open it, choose the year and
// the month from their lists, press the day. It takes a date written as it is stored, "2026-10-08", and the field's label, so a spec reads as it did when the field was typed into.

type Scope = Page | Locator
const pageOf = (scope: Scope): Page => ('goto' in scope ? scope : scope.page())

/** The calendar's accessible name, which every open one has. */
export const CALENDAR = 'Choose a date'

/** The button that shows a date field's date, found by its label's exact text (a Report's "From" is not its "From (optional)"). `scope` is the page or a form on it. */
export const dateField = (scope: Scope, label: string) => scope.getByLabel(label, { exact: true })

/** The open calendar. */
export const calendarOf = (scope: Scope) => pageOf(scope).getByRole('dialog', { name: CALENDAR })

/** Choose `date` ("2026-10-08") in the field called `label`: opens the calendar, chooses the year and month, presses the day, and waits for the calendar to close. */
export async function pickDate(scope: Scope, label: string, date: string) {
  const [year, month] = date.split('-').map(Number)
  await dateField(scope, label).click()
  const calendar = calendarOf(scope)
  await calendar.getByLabel('Choose the Year').selectOption(String(year))
  await calendar.getByLabel('Choose the Month').selectOption(String(month! - 1)) // the months are counted from 0
  await calendar.locator(`td[data-day="${date}"] button`).click()
  await expect(calendar).toBeHidden()
}

/** Put an optional field back to no date, as a person does: open the calendar and press "Clear date". */
export async function clearDate(scope: Scope, label: string) {
  await dateField(scope, label).click()
  const calendar = calendarOf(scope)
  await calendar.getByRole('button', { name: 'Clear date' }).click()
  await expect(calendar).toBeHidden()
}

/** The field shows `date` ("2026-10-08", as "Thu 8 Oct 2026"), or, for "", that it has none. */
export async function expectDate(scope: Scope, label: string, date: string) {
  await expect(dateField(scope, label)).toHaveText(date === '' ? 'Choose a date' : dateText(date))
}
