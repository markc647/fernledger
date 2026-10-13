// The calendar picker turns a stored date ("2026-10-08") into a Date and back (src/lib/calendar-day.ts). Vitest runs in a runtime that is always in UTC, where a conversion
// that counts in UTC looks right, so this runs the same conversions in the time zones where it would not: NZ itself, either side of both changes of its clocks, the zones
// 14 hours ahead of UTC and 11 behind, and zones whose clocks change at midnight.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayOf, isoDateOf } from '../src/lib/calendar-day.ts'

/** Each zone with the offset from UTC, in minutes behind it as `getTimezoneOffset` says, that it has on 1 July 2026: proof that setting TZ took effect. */
const ZONES = [
  ['Pacific/Auckland', -720],
  ['Pacific/Kiritimati', -840],
  ['Pacific/Pago_Pago', 660],
  ['America/Los_Angeles', 420],
  ['Europe/London', -60],
  ['UTC', 0],
  ['America/Havana', 240], // summer time begins at midnight
  ['Asia/Beirut', -180], // summer time begins at midnight
]

const AROUND_THE_CHANGES = [
  '2026-09-26', '2026-09-27', '2026-09-28', // NZ summer time begins on the 27th: 2 am becomes 3 am
  '2026-04-04', '2026-04-05', '2026-04-06', // NZ summer time ends on the 5th: 3 am becomes 2 am
  '2026-03-08', '2026-11-01', // the United States
  '2026-03-29', '2026-10-25', // Europe
  '2026-12-31', '2027-01-01', '2028-02-29', '2000-01-01', '2100-12-31',
]

function inZone(zone, expectedOffset, check) {
  const was = process.env.TZ
  process.env.TZ = zone
  try {
    assert.equal(new Date(2026, 6, 1).getTimezoneOffset(), expectedOffset, `${zone} did not take effect, so this test would prove nothing`)
    check()
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
}

for (const [zone, offset] of ZONES) {
  test(`${zone}: a stored date goes to a day and back as itself, around the changes of the clocks`, () => {
    inZone(zone, offset, () => {
      for (const date of AROUND_THE_CHANGES) assert.equal(isoDateOf(dayOf(date)), date, date)
    })
  })

  test(`${zone}: every day of 2026 to 2028 goes to a day and back as itself, and is the day of the week it should be`, () => {
    inZone(zone, offset, () => {
      let count = 0
      for (let at = Date.UTC(2026, 0, 1); at < Date.UTC(2029, 0, 1); at += 86_400_000) {
        const utc = new Date(at)
        const date = utc.toISOString().slice(0, 10)
        const day = dayOf(date)
        assert.equal(isoDateOf(day), date, date)
        assert.equal(day.getDay(), utc.getUTCDay(), `${date} is the wrong day of the week`)
        count++
      }
      assert.equal(count, 365 * 2 + 366)
    })
  })

  test(`${zone}: a day the picker hands back at any time of day is the same stored date`, () => {
    inZone(zone, offset, () => {
      for (const hour of [0, 1, 2, 3, 12, 23]) assert.equal(isoDateOf(new Date(2026, 8, 27, hour, 30)), '2026-09-27', `hour ${hour}`)
    })
  })
}

test('the control: counting in UTC does move the day in these zones, so the checks above can fail', () => {
  const moved = ZONES.filter(([zone, offset]) => {
    let shifted = false
    inZone(zone, offset, () => {
      shifted = new Date('2026-10-08').getDate() !== 8 || new Date(2026, 9, 8).toISOString().slice(0, 10) !== '2026-10-08'
    })
    return shifted
  })
  assert.ok(moved.length >= 3, `only ${moved.length} zones showed the shift`)
})
