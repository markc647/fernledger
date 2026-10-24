import { describe, expect, it } from 'vitest'
import { EARLIER_TEXT_SIZE_STORAGE_KEY, loadTextSize, parseTextSize, saveTextSize, TEXT_SIZE_STORAGE_KEY, TEXT_SIZES } from './text-size'
import { blockedStorage, fakeStorage } from './test-storage'

describe('the four sizes', () => {
  it('are Small, Medium, Large and Xtra Large, smallest first', () => {
    expect(TEXT_SIZES.map((size) => size.label)).toEqual(['Small', 'Medium', 'Large', 'Xtra Large'])
  })
  it('each have a name of their own that starts with the word on the button', () => {
    expect(TEXT_SIZES.map((size) => size.name)).toEqual(['Small text', 'Medium text', 'Large text', 'Xtra Large text'])
    for (const size of TEXT_SIZES) expect(size.name.startsWith(size.label)).toBe(true) // the visible label is in the accessible name (WCAG 2.5.3)
  })
  it('are 14px, 16px, 18px and 20px on a 16px browser, and Medium is the 16px body size the README promises', () => {
    expect(TEXT_SIZES.map((size) => (size.percent / 100) * 16)).toEqual([14, 16, 18, 20])
    expect(TEXT_SIZES.find((size) => size.percent === 100)?.value).toBe('medium')
  })
  it('are saved under values of their own, none of them the one the three-size control saved for 20px', () => {
    expect(TEXT_SIZES.map((size) => size.value)).toEqual(['small', 'medium', 'large', 'xlarge'])
  })
})

describe('parseTextSize', () => {
  it('accepts each value the control saves', () => {
    expect(parseTextSize('small')).toBe('small')
    expect(parseTextSize('medium')).toBe('medium')
    expect(parseTextSize('large')).toBe('large')
    expect(parseTextSize('xlarge')).toBe('xlarge')
  })
  it('falls back to Medium for anything else', () => {
    for (const raw of [null, '', 'A', 'Small', 'huge', '130', 'a', 'a-plus', 'xxlarge', 'constructor', '__proto__', 'toString']) expect(parseTextSize(raw)).toBe('medium')
  })

  describe('what an earlier control saved, which is used only when nothing is saved by this one', () => {
    it('keeps Small and Medium, and the A of the first control is Medium', () => {
      expect(parseTextSize(null, 'small')).toBe('small')
      expect(parseTextSize(null, 'medium')).toBe('medium')
      expect(parseTextSize(null, 'a')).toBe('medium')
    })
    it('turns the Large of the three-size control (20px) into Xtra Large, so nobody who chose it gets smaller text', () => {
      expect(parseTextSize(null, 'large')).toBe('xlarge')
    })
    it('turns the A+ and A++ of the first control (both 20px by the time of the three-size control) into Xtra Large too', () => {
      expect(parseTextSize(null, 'a-plus')).toBe('xlarge')
      expect(parseTextSize(null, 'a-plus-plus')).toBe('xlarge')
    })
    it('gives way to what this control saved, so the new Large (18px) is not read as the old one', () => {
      expect(parseTextSize('large', 'large')).toBe('large')
      expect(parseTextSize('small', 'large')).toBe('small')
      expect(parseTextSize('medium', 'a-plus')).toBe('medium')
    })
    it('is used when what this control saved is junk', () => {
      expect(parseTextSize('enormous', 'large')).toBe('xlarge')
      expect(parseTextSize('', 'small')).toBe('small')
    })
    it('falls back to Medium for anything else', () => {
      for (const earlier of [null, '', 'A', 'Small', 'xlarge', 'huge', 'a-plus-plus-plus', 'constructor', '__proto__']) expect(parseTextSize(null, earlier)).toBe('medium')
    })
  })
})

describe('loadTextSize and saveTextSize', () => {
  it('remember the choice on this device, under the key of this control and not the earlier one', () => {
    const storage = fakeStorage()
    expect(saveTextSize('large', storage)).toBe(true)
    expect(storage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('large')
    expect(storage.getItem(EARLIER_TEXT_SIZE_STORAGE_KEY)).toBeNull()
    expect(loadTextSize(storage)).toBe('large')
  })
  it('keep each of the four apart', () => {
    for (const { value } of TEXT_SIZES) {
      const storage = fakeStorage()
      saveTextSize(value, storage)
      expect(loadTextSize(storage)).toBe(value)
    }
  })
  it('read the Large the three-size control saved as Xtra Large', () => {
    expect(loadTextSize(fakeStorage({ [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'large' }))).toBe('xlarge')
  })
  it('read a size the first control saved', () => {
    expect(loadTextSize(fakeStorage({ [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'a-plus' }))).toBe('xlarge')
    expect(loadTextSize(fakeStorage({ [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'a' }))).toBe('medium')
  })
  it('keep what the earlier control saved for Small and Medium', () => {
    expect(loadTextSize(fakeStorage({ [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'small' }))).toBe('small')
    expect(loadTextSize(fakeStorage({ [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'medium' }))).toBe('medium')
  })
  it('prefer a choice made since over what the earlier control saved', () => {
    const storage = fakeStorage({ [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'large' })
    saveTextSize('large', storage) // the new Large, 18px
    expect(loadTextSize(storage)).toBe('large')
    saveTextSize('small', storage)
    expect(loadTextSize(storage)).toBe('small')
  })
  it('start at Medium when nothing is saved', () => {
    expect(loadTextSize(fakeStorage())).toBe('medium')
  })
  it('start at Medium when the saved value is junk', () => {
    expect(loadTextSize(fakeStorage({ [TEXT_SIZE_STORAGE_KEY]: 'enormous', [EARLIER_TEXT_SIZE_STORAGE_KEY]: 'enormous' }))).toBe('medium')
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
