import { describe, expect, it } from 'vitest'
import { changeFields } from './change-log'

describe('changeFields', () => {
  it('lays a change out field by field, before beside after', () => {
    const fields = changeFields('{"app_title":"Fernledger","about_contact":""}', '{"app_title":"Mum\'s finances","about_contact":"Sam"}')
    expect(fields).toEqual({
      showBefore: true,
      showAfter: true,
      rows: [
        { field: 'App title', before: 'Fernledger', after: "Mum's finances" },
        { field: 'About contact', before: '(blank)', after: 'Sam' },
      ],
    })
  })

  it('shows only the side that was recorded', () => {
    const fields = changeFields(null, '{"added":3,"duplicates":0,"newAccount":true,"fileRows":3,"from":"2026-10-01","to":"2026-10-08"}')
    expect(fields.showBefore).toBe(false)
    expect(fields.showAfter).toBe(true)
    expect(fields.rows).toEqual([
      { field: 'Added', before: '(none)', after: '3' },
      { field: 'Duplicates', before: '(none)', after: '0' },
      { field: 'New account', before: '(none)', after: 'Yes' },
      { field: 'File rows', before: '(none)', after: '3' },
      { field: 'From', before: '(none)', after: 'Thu 1 Oct 2026' },
      { field: 'To', before: '(none)', after: 'Thu 8 Oct 2026' },
    ])
  })

  it('lists a field that is on one side only, and keeps the order they were recorded in', () => {
    const fields = changeFields('{"name":"A","old":"x"}', '{"name":"B","extra":"y"}')
    expect(fields.rows).toEqual([
      { field: 'Name', before: 'A', after: 'B' },
      { field: 'Old', before: 'x', after: '(none)' },
      { field: 'Extra', before: '(none)', after: 'y' },
    ])
  })

  it('has nothing to show when neither side was recorded', () => {
    expect(changeFields(null, null)).toEqual({ showBefore: false, showAfter: false, rows: [] })
  })

  it('shows a plain value, a list and a nested record in words rather than JSON braces', () => {
    expect(changeFields(null, '"Kept for seven years"').rows).toEqual([{ field: 'Value', before: '(none)', after: 'Kept for seven years' }])
    expect(changeFields(null, '{"skipped":["Row 4","Row 9"],"nothing":null}').rows).toEqual([
      { field: 'Skipped', before: '(none)', after: 'Row 4, Row 9' },
      { field: 'Nothing', before: '(none)', after: '(none)' },
    ])
    expect(changeFields(null, '{"range":{"from":"2026-10-01"}}').rows[0]!.after).toBe('From: Thu 1 Oct 2026')
  })

  it('still shows text that is not valid JSON', () => {
    expect(changeFields(null, 'not json').rows).toEqual([{ field: 'Value', before: '(none)', after: 'not json' }])
  })
})
