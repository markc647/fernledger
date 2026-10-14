import type { DeviceStorage } from './device-storage'

export type TextSize = 'small' | 'medium' | 'large'

/**
 * The three text sizes, smallest first. `percent` is the share of the browser's own text size and must match the
 * `html[data-text-size]` rules in src/index.css (scripts/text-size-init.test.mjs checks it): 14px, 16px and 20px on a
 * browser set to 16px. Medium, the default, is the 16px body size the README's Accessibility section promises; Small is a
 * choice someone makes, never what they start with. `name` is the accessible name of the button, which starts with its label.
 */
export const TEXT_SIZES: readonly { value: TextSize; label: string; name: string; percent: number }[] = [
  { value: 'small', label: 'Small', name: 'Small text', percent: 87.5 },
  { value: 'medium', label: 'Medium', name: 'Medium text', percent: 100 },
  { value: 'large', label: 'Large', name: 'Large text', percent: 125 },
]

/** The key the first text-size control used, kept so a size chosen on it is not lost. */
export const TEXT_SIZE_STORAGE_KEY = 'fernledger-text-size'

/** What the first control (A / A+ / A++) saved. A is today's Medium; A+ and A++ are both Large. public/text-size-init.js repeats this. */
const SAVED_BY_THE_FIRST_CONTROL = new Map<string, TextSize>([
  ['a', 'medium'],
  ['a-plus', 'large'],
  ['a-plus-plus', 'large'],
])

export function parseTextSize(raw: string | null): TextSize {
  return TEXT_SIZES.find((size) => size.value === raw)?.value ?? SAVED_BY_THE_FIRST_CONTROL.get(raw ?? '') ?? 'medium'
}

/** The size saved on this device; Medium when none is saved or storage is blocked. */
export function loadTextSize(storage: DeviceStorage): TextSize {
  try {
    return parseTextSize(storage?.getItem(TEXT_SIZE_STORAGE_KEY) ?? null)
  } catch {
    return 'medium' // storage blocked: the page still works, at the standard size
  }
}

/** Remembers the size on this device. False when it couldn't be saved; the size still applies until the page closes. */
export function saveTextSize(size: TextSize, storage: DeviceStorage) {
  if (!storage) return false
  try {
    storage.setItem(TEXT_SIZE_STORAGE_KEY, size)
    return true
  } catch {
    return false
  }
}
