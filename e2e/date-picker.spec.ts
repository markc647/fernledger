import type { Page } from '@playwright/test'
import { calendarOf, clearDate, dateField, expectDate, pickDate } from './date-helpers'
import { expect, noAxeViolations, signInAs, test } from './fixtures'
import { dateText } from './report-helpers'

// The DatePicker (src/components/date-picker.tsx) on the Styleguide's three samples: "Date", "Optional date" and a date from 10 to 20 October 2026. The forms that use it
// have their own specs, which choose their dates through `pickDate`; this is the picker itself: what it gives, how it is named, the keyboard, the limits, time zones,
// accessibility and the phone. (The Content Security Policy is checked by every test: the fixture fails on a violation.)

const stored = (page: Page, sample: 'date' | 'optional' | 'bounded') => page.getByTestId(`sample-${sample}-stored`)
const dayButton = (page: Page, date: string) => calendarOf(page).locator(`td[data-day="${date}"] button`)

test.beforeEach(async ({ page, context }) => {
  await signInAs(context, 'member')
  await page.goto('/styleguide')
  await expect(page.getByRole('heading', { level: 2, name: 'Dates' })).toBeVisible()
})

test('a date is chosen from the calendar and given as it is stored, YYYY-MM-DD, whichever day it is', async ({ page }) => {
  await expectDate(page, 'Date', '2026-10-08')
  await expect(stored(page, 'date')).toHaveText('2026-10-08')
  // The first and last days the API accepts, a leap day, the days NZ's clocks change (summer time begins 27 September 2026 and ends 5 April 2026), and the turn of a year.
  for (const date of ['2027-03-31', '2000-01-01', '2100-12-31', '2028-02-29', '2026-09-27', '2026-04-05', '2026-12-31', '2027-01-01']) {
    await pickDate(page, 'Date', date)
    await expect(stored(page, 'date')).toHaveText(date)
    await expectDate(page, 'Date', date)
  }
})

test('its name is its label and then its date, and pressing the label presses it', async ({ page }) => {
  const field = dateField(page, 'Date')
  await expect(page.getByRole('button', { name: 'Date Thu 8 Oct 2026' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Optional date Choose a date' })).toBeVisible()
  await expect(field).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(field).toHaveAttribute('aria-expanded', 'false')

  await page.locator('label[for="sample-date"]').click() // a label presses the button it is for, as it does a checkbox
  await expect(field).toHaveAttribute('aria-expanded', 'true')
  await expect(calendarOf(page)).toBeVisible() // the calendar is a dialog with a name
  await expect(calendarOf(page).getByLabel('Choose the Month')).toHaveValue('9')
  await expect(calendarOf(page).getByLabel('Choose the Year')).toHaveValue('2026')
  await page.keyboard.press('Escape')

  await pickDate(page, 'Date', '2027-03-31')
  await expect(page.getByRole('button', { name: 'Date Wed 31 Mar 2027' })).toBeVisible()
})

test('the keyboard opens it, moves round the days, chooses one, and Escape closes it with focus back on the field', async ({ page }) => {
  const field = dateField(page, 'Date')
  const calendar = calendarOf(page)
  await field.focus()
  await page.keyboard.press('Enter')
  await expect(calendar).toBeVisible()
  await expect(dayButton(page, '2026-10-08')).toBeFocused() // the chosen day, so the arrow keys begin where the date is

  const keys: [string, string][] = [
    ['ArrowRight', '2026-10-09'],
    ['ArrowDown', '2026-10-16'],
    ['ArrowLeft', '2026-10-15'],
    ['ArrowUp', '2026-10-08'],
    ['Home', '2026-10-05'], // weeks start on Monday
    ['End', '2026-10-11'],
    ['PageDown', '2026-11-11'],
  ]
  for (const [key, date] of keys) {
    await page.keyboard.press(key)
    await expect(dayButton(page, date), `${key} goes to ${date}`).toBeFocused()
  }
  await expect(calendar.getByLabel('Choose the Month')).toHaveValue('10') // November
  await page.keyboard.press('Enter')
  await expect(calendar).toBeHidden()
  await expect(field).toBeFocused()
  await expect(stored(page, 'date')).toHaveText('2026-11-11')

  await page.keyboard.press(' ') // Space opens it too
  await expect(calendar).toBeVisible()
  await expect(dayButton(page, '2026-11-11')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await expect(calendar).toBeHidden()
  await expect(field).toBeFocused()
  await expect(stored(page, 'date')).toHaveText('2026-11-11') // Escape chooses nothing

  await field.click()
  await page.getByRole('heading', { level: 2, name: 'Dates' }).click() // pressing outside it closes it too
  await expect(calendar).toBeHidden()
})

test('the month and year are chosen from lists, and a date can be put back to none', async ({ page }) => {
  await dateField(page, 'Optional date').click()
  const calendar = calendarOf(page)
  await expect(calendar.getByRole('button', { name: 'Clear date' })).toHaveCount(0) // nothing to clear
  await expect(calendar.getByLabel('Choose the Year').locator('option')).toHaveCount(101) // 2000 to 2100
  await expect(calendar.getByLabel('Choose the Year').locator('option').first()).toHaveText('2000')
  await expect(calendar.getByLabel('Choose the Year').locator('option').last()).toHaveText('2100')
  await expect(calendar.getByLabel('Choose the Month').locator('option')).toHaveCount(12)
  await expect(calendar.getByLabel('Choose the Month').locator('option').nth(8)).toHaveText('September')
  await page.keyboard.press('Escape')

  await pickDate(page, 'Optional date', '2026-02-28')
  await expect(stored(page, 'optional')).toHaveText('2026-02-28')
  await clearDate(page, 'Optional date')
  await expect(stored(page, 'optional')).toHaveText('nothing')
  await expectDate(page, 'Optional date', '')

  // It can be put back to none wherever a date can be chosen.
  await dateField(page, 'Date').click()
  await expect(calendarOf(page).getByRole('button', { name: 'Clear date' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('days outside the earliest and latest cannot be chosen, and the lists stop at them', async ({ page }) => {
  await dateField(page, 'Date from 10 to 20 October 2026').click()
  const calendar = calendarOf(page)
  await expect(dayButton(page, '2026-10-09')).toBeDisabled()
  await expect(dayButton(page, '2026-10-10')).toBeEnabled()
  await expect(dayButton(page, '2026-10-20')).toBeEnabled()
  await expect(dayButton(page, '2026-10-21')).toBeDisabled()
  await expect(calendar.getByLabel('Choose the Year').locator('option')).toHaveText(['2026'])
  await expect(calendar.getByLabel('Choose the Month').locator('option:not([disabled])')).toHaveText(['October']) // the others are listed, and cannot be chosen
  await expect(dayButton(page, '2026-10-15')).toBeFocused() // the chosen day
  await page.keyboard.press('Escape')

  await pickDate(page, 'Date from 10 to 20 October 2026', '2026-10-10')
  await expect(stored(page, 'bounded')).toHaveText('2026-10-10')
  await pickDate(page, 'Date from 10 to 20 October 2026', '2026-10-20')
  await expect(stored(page, 'bounded')).toHaveText('2026-10-20')
})

// The date is a calendar date, not a moment: the same whichever time zone the device is in. These zones are NZ itself, the one furthest ahead of UTC (14 hours), the one
// furthest behind it (11), and two others, and the days are the ones where NZ's clocks change.
for (const timezoneId of ['Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Europe/London']) {
  test.describe(`on a device in ${timezoneId}`, () => {
    test.use({ timezoneId })

    test('the date chosen is the date stored, and the calendar starts at today in NZ, not today on the device', async ({ page }) => {
      for (const date of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-04-04', '2026-04-05', '2026-04-06', '2026-12-31', '2027-01-01', '2028-02-29']) {
        await pickDate(page, 'Date', date)
        await expect(stored(page, 'date')).toHaveText(date)
        await expect(dateField(page, 'Date')).toHaveText(dateText(date))
      }

      // 00:30 on Thursday 8 October in NZ is still the 7th in Los Angeles and Pago Pago. The calendar of a field with no date opens on the NZ day.
      await page.clock.setFixedTime(new Date('2026-10-07T11:30:00.000Z'))
      await page.reload()
      await dateField(page, 'Optional date').click()
      await expect(calendarOf(page).locator('td[data-today="true"]')).toHaveAttribute('data-day', '2026-10-08')
      await expect(dayButton(page, '2026-10-08')).toBeFocused()
      await expect(calendarOf(page).getByLabel('Choose the Month')).toHaveValue('9')
    })
  })
}

test('it has no WCAG 2.2 AA violations closed, open, and open on a phone at the largest text size, and the calendar fits the screen', async ({ page }) => {
  await noAxeViolations(page)
  await dateField(page, 'Date').click()
  await expect(calendarOf(page)).toBeVisible()
  await noAxeViolations(page)
  await page.keyboard.press('Escape')

  // A phone, 200% zoom on a laptop (640 by 360, shorter than the calendar) and 400% zoom (316 by 256).
  for (const viewport of [{ width: 390, height: 844 }, { width: 640, height: 360 }, { width: 316, height: 256 }]) {
    await page.setViewportSize(viewport)
    await page.getByRole('group', { name: 'Text size' }).getByRole('button', { name: 'A++', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Text size' }).getByRole('button', { name: 'A++', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await dateField(page, 'Date').scrollIntoViewIfNeeded()
    await pickDate(page, 'Date', '2027-03-31') // a day in the last row, which on a short screen is reached by scrolling the calendar
    await expect(stored(page, 'date')).toHaveText('2027-03-31')
    await dateField(page, 'Date').click()
    const calendar = calendarOf(page)
    await expect(calendar).toBeVisible()
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
    const box = (await calendar.boundingBox())!
    expect(box.x, 'its left edge is on the screen').toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, 'its right edge is on the screen').toBeLessThanOrEqual(viewport.width)
    expect(box.y, 'its top is on the screen').toBeGreaterThanOrEqual(0)
    expect(box.y + box.height, 'its bottom is on the screen').toBeLessThanOrEqual(viewport.height)
    // Every day is a target of 44px where the screen is wide enough for seven of them, and none is under 24px (WCAG 2.5.8) on the narrowest.
    const day = (await dayButton(page, '2027-03-31').boundingBox())!
    expect(day.width).toBeGreaterThanOrEqual(viewport.width >= 390 ? 44 : 24)
    expect(day.height).toBeGreaterThanOrEqual(viewport.width >= 390 ? 44 : 24)
    await noAxeViolations(page)
    await page.keyboard.press('Escape')
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  }
})

test('in Windows high contrast the chosen day is filled with the reader\'s highlight colour, which the others are not', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' }) // the reader's palette replaces the app's colours, which drops a fill
  await dateField(page, 'Date').click()
  const fill = (date: string) => dayButton(page, date).evaluate((day) => getComputedStyle(day).backgroundColor)
  const highlight = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'Highlight'
    document.body.append(probe)
    const colour = getComputedStyle(probe).backgroundColor
    probe.remove()
    return colour
  })
  expect(await fill('2026-10-08')).toBe(highlight)
  expect(await fill('2026-10-09')).not.toBe(highlight)
})
