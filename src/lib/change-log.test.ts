import { describe, expect, it } from 'vitest'
import { changeFields } from './change-log'

describe('changeFields', () => {
  it('lays a change out field by field, before beside after', () => {
    const fields = changeFields('{"app_title":"Fernledger","about_contact":""}', '{"app_title":"Mum\'s finances","about_contact":"Sam"}')
    expect(fields).toEqual({
      showBefore: true,
      showAfter: true,
      rows: [
        { key: 'app_title', field: 'App title', before: 'Fernledger', after: "Mum's finances" },
        { key: 'about_contact', field: 'About contact', before: '(blank)', after: 'Sam' },
      ],
    })
  })

  it('shows only the side that was recorded', () => {
    const fields = changeFields(null, '{"added":3,"duplicates":0,"newAccount":true,"fileRows":3,"from":"2026-10-01","to":"2026-10-08"}')
    expect(fields.showBefore).toBe(false)
    expect(fields.showAfter).toBe(true)
    expect(fields.rows).toEqual([
      { key: 'added', field: 'Added', before: '(none)', after: '3' },
      { key: 'duplicates', field: 'Duplicates', before: '(none)', after: '0' },
      { key: 'newAccount', field: 'New account', before: '(none)', after: 'Yes' },
      { key: 'fileRows', field: 'File rows', before: '(none)', after: '3' },
      { key: 'from', field: 'From', before: '(none)', after: 'Thu 1 Oct 2026' },
      { key: 'to', field: 'To', before: '(none)', after: 'Thu 8 Oct 2026' },
    ])
  })

  it('lists a field that is on one side only, and keeps the order they were recorded in', () => {
    const fields = changeFields('{"name":"A","old":"x"}', '{"name":"B","extra":"y"}')
    expect(fields.rows).toEqual([
      { key: 'name', field: 'Name', before: 'A', after: 'B' },
      { key: 'old', field: 'Old', before: 'x', after: '(none)' },
      { key: 'extra', field: 'Extra', before: '(none)', after: 'y' },
    ])
  })

  it('has nothing to show when neither side was recorded', () => {
    expect(changeFields(null, null)).toEqual({ showBefore: false, showAfter: false, rows: [] })
  })

  it('shows a plain value, a list and a nested record in words rather than JSON braces', () => {
    expect(changeFields(null, '"Kept for seven years"').rows).toEqual([{ key: 'value', field: 'Value', before: '(none)', after: 'Kept for seven years' }])
    expect(changeFields(null, '{"skipped":["Row 4","Row 9"],"nothing":null}').rows).toEqual([
      { key: 'skipped', field: 'Skipped', before: '(none)', after: 'Row 4, Row 9' },
      { key: 'nothing', field: 'Nothing', before: '(none)', after: '(none)' },
    ])
    expect(changeFields(null, '{"range":{"from":"2026-10-01"}}').rows[0]!.after).toBe('From: Thu 1 Oct 2026')
  })

  it('still shows text that is not valid JSON', () => {
    expect(changeFields(null, 'not json').rows).toEqual([{ key: 'value', field: 'Value', before: '(none)', after: 'not json' }])
  })

  it('shows a date only under a date field, and never fails on one that is not real', () => {
    const rows = changeFields(null, '{"from":"2026-02-30","to":"2026-10-08","note":"2026-02-30","app_title":"2026-10-08","range":{"from":"2026-13-45","other":"2026-10-08"}}').rows
    expect(rows.map((r) => [r.key, r.after])).toEqual([
      ['from', '2026-02-30'], // a date field holding an impossible date: shown as stored
      ['to', 'Thu 8 Oct 2026'],
      ['note', '2026-02-30'], // text that only looks like a date
      ['app_title', '2026-10-08'], // an app title of 2026-10-08 stays text
      ['range', 'From: 2026-13-45; Other: 2026-10-08'],
    ])
  })
})
