export type TextSize = 'a' | 'a-plus' | 'a-plus-plus'

/**
 * The three text sizes, smallest first. `percent` is the share of the browser's own text size and must match the
 * `html[data-text-size]` rules in src/index.css (scripts/text-size-init.test.mjs checks it). 100% is the 16px body
 * size the README's Accessibility section promises, so nothing here goes below it.
 */
export const TEXT_SIZES: readonly { value: TextSize; label: string; percent: number }[] = [
  { value: 'a', label: 'A', percent: 100 },
  { value: 'a-plus', label: 'A+', percent: 115 },
  { value: 'a-plus-plus', label: 'A++', percent: 130 },
]

export const TEXT_SIZE_STORAGE_KEY = 'fernledger-text-size'

/** The part of `localStorage` this module uses, so tests can pass a stand-in. */
export type TextSizeStorage = Pick<Storage, 'getItem' | 'setItem'> | undefined

export function parseTextSize(raw: string | null): TextSize {
  return TEXT_SIZES.find((size) => size.value === raw)?.value ?? 'a'
}

/** The size saved on this device; A when none is saved or storage is blocked. */
export function loadTextSize(storage: TextSizeStorage): TextSize {
  try {
    return parseTextSize(storage?.getItem(TEXT_SIZE_STORAGE_KEY) ?? null)
  } catch {
    return 'a' // storage blocked: the page still works, at the standard size
  }
}

/** Remembers the size on this device. False when it couldn't be saved; the size still applies until the page closes. */
export function saveTextSize(size: TextSize, storage: TextSizeStorage) {
  if (!storage) return false
  try {
    storage.setItem(TEXT_SIZE_STORAGE_KEY, size)
    return true
  } catch {
    return false
  }
}

/** This device's `localStorage`, or undefined when the browser blocks even looking at it. */
export function deviceStorage(): TextSizeStorage {
  try {
    return localStorage
  } catch {
    return undefined
  }
}
