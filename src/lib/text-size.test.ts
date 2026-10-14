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
  it('are Small, Medium and Large, smallest first', () => {
    expect(TEXT_SIZES.map((size) => size.label)).toEqual(['Small', 'Medium', 'Large'])
  })
  it('each have a name of their own that starts with the word on the button', () => {
    expect(TEXT_SIZES.map((size) => size.name)).toEqual(['Small text', 'Medium text', 'Large text'])
    for (const size of TEXT_SIZES) expect(size.name.startsWith(size.label)).toBe(true) // the visible label is in the accessible name (WCAG 2.5.3)
  })
  it('are 14px, 16px and 20px on a 16px browser, and Medium is the 16px body size the README promises', () => {
    expect(TEXT_SIZES.map((size) => (size.percent / 100) * 16)).toEqual([14, 16, 20])
    expect(TEXT_SIZES.find((size) => size.percent === 100)?.value).toBe('medium')
  })
})

describe('parseTextSize', () => {
  it('accepts each saved value', () => {
    expect(parseTextSize('small')).toBe('small')
    expect(parseTextSize('medium')).toBe('medium')
    expect(parseTextSize('large')).toBe('large')
  })
  it('reads what the A / A+ / A++ control saved: A is Medium, and A+ and A++ are Large', () => {
    expect(parseTextSize('a')).toBe('medium')
    expect(parseTextSize('a-plus')).toBe('large')
    expect(parseTextSize('a-plus-plus')).toBe('large')
  })
  it('falls back to Medium for anything else', () => {
    for (const raw of [null, '', 'A', 'Small', 'huge', '130', 'a-plus-plus-plus']) expect(parseTextSize(raw)).toBe('medium')
  })
})

describe('loadTextSize and saveTextSize', () => {
  it('remember the choice on this device', () => {
    const storage = fakeStorage()
    expect(saveTextSize('small', storage)).toBe(true)
    expect(storage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('small')
    expect(loadTextSize(storage)).toBe('small')
  })
  it('read a size the old control saved', () => {
    expect(loadTextSize(fakeStorage({ [TEXT_SIZE_STORAGE_KEY]: 'a-plus' }))).toBe('large')
  })
  it('start at Medium when nothing is saved', () => {
    expect(loadTextSize(fakeStorage())).toBe('medium')
  })
  it('start at Medium when the saved value is junk', () => {
    expect(loadTextSize(fakeStorage({ [TEXT_SIZE_STORAGE_KEY]: 'enormous' }))).toBe('medium')
  })
  it('fall back to Medium when storage is blocked, without throwing', () => {
    expect(loadTextSize(blockedStorage())).toBe('medium')
  })
  it('report, without throwing, that a choice could not be saved when storage is blocked', () => {
    expect(saveTextSize('large', blockedStorage())).toBe(false)
  })
  it('fall back to Medium when there is no storage object at all', () => {
    expect(loadTextSize(undefined)).toBe('medium')
    expect(saveTextSize('large', undefined)).toBe(false)
  })
})
