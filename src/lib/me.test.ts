import { describe, expect, it } from 'vitest'
import { HttpError, isNotSignedIn } from './me'

describe('isNotSignedIn', () => {
  it('is true only for a 401 from the API', () => {
    expect(isNotSignedIn(new HttpError(401))).toBe(true)
  })

  it('is false for a server failure', () => {
    expect(isNotSignedIn(new HttpError(500))).toBe(false)
  })

  it('is false for a network failure', () => {
    expect(isNotSignedIn(new TypeError('Failed to fetch'))).toBe(false)
  })
})
