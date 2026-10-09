import { describe, expect, it } from 'vitest'
import { loadTextSize, parseTextSize, saveTextSize, TEXT_SIZE_STORAGE_KEY, TEXT_SIZES } from './text-size'

/** A stand-in for localStorage. */
const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

/** A stand-in for storage that the browser blocks (private modes, blocked site data): every access throws. */
const blockedStorage = () => ({
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
})

describe('the three sizes', () => {
  it('are A, A+ and A++, smallest first', () => {
    expect(TEXT_SIZES.map((size) => size.label)).toEqual(['A', 'A+', 'A++'])
  })
  it('never go below the 16px body size the README promises', () => {
    for (const size of TEXT_SIZES) expect(size.percent).toBeGreaterThanOrEqual(100)
    expect(TEXT_SIZES[0].percent).toBe(100)
  })
  it('grow in steps big enough to notice', () => {
    expect(TEXT_SIZES.map((size) => size.percent)).toEqual([100, 115, 130])
  })
})

describe('parseTextSize', () => {
  it('accepts each saved value', () => {
    expect(parseTextSize('a')).toBe('a')
    expect(parseTextSize('a-plus')).toBe('a-plus')
    expect(parseTextSize('a-plus-plus')).toBe('a-plus-plus')
  })
  it('falls back to A for anything else', () => {
    for (const raw of [null, '', 'A', 'huge', '130', 'a-plus-plus-plus']) expect(parseTextSize(raw)).toBe('a')
  })
})

describe('loadTextSize and saveTextSize', () => {
  it('remember the choice on this device', () => {
    const storage = fakeStorage()
    expect(saveTextSize('a-plus', storage)).toBe(true)
    expect(storage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('a-plus')
    expect(loadTextSize(storage)).toBe('a-plus')
  })
  it('start at A when nothing is saved', () => {
    expect(loadTextSize(fakeStorage())).toBe('a')
  })
  it('start at A when the saved value is junk', () => {
    expect(loadTextSize(fakeStorage({ [TEXT_SIZE_STORAGE_KEY]: 'enormous' }))).toBe('a')
  })
  it('fall back to A when storage is blocked, without throwing', () => {
    expect(loadTextSize(blockedStorage())).toBe('a')
  })
  it('report, without throwing, that a choice could not be saved when storage is blocked', () => {
    expect(saveTextSize('a-plus-plus', blockedStorage())).toBe(false)
  })
  it('fall back to A when there is no storage object at all', () => {
    expect(loadTextSize(undefined)).toBe('a')
    expect(saveTextSize('a-plus', undefined)).toBe(false)
  })
})
