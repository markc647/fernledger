import { readDevice, writeDevice, type DeviceStorage } from './device-storage.ts'

export type TextSize = 'small' | 'medium' | 'large' | 'xlarge'

/**
 * The four text sizes, smallest first. `percent` is the share of the browser's own text size and must match the `html[data-text-size]` rules in src/index.css
 * (scripts/text-size-init.test.mjs checks it): 14px, 16px, 18px and 20px on a browser set to 16px. All text that is not a heading is exactly this size, in every part of the
 * page (src/index.css says how). Medium, the default, is the 16px body size the README's Accessibility section promises; Small is a choice someone makes, never what they
 * start with. `name` is the accessible name of the button, which starts with its label.
 */
export const TEXT_SIZES: readonly { value: TextSize; label: string; name: string; percent: number }[] = [
  { value: 'small', label: 'Small', name: 'Small text', percent: 87.5 },
  { value: 'medium', label: 'Medium', name: 'Medium text', percent: 100 },
  { value: 'large', label: 'Large', name: 'Large text', percent: 112.5 },
  { value: 'xlarge', label: 'Xtra Large', name: 'Xtra Large text', percent: 125 },
]

/** Where the four-size control saves its choice. Its own key, because `large` under the earlier key means 20px, which is `xlarge` now. */
export const TEXT_SIZE_STORAGE_KEY = 'fernledger-text-size-v2'

/** The key the earlier controls (A / A+ / A++, then Small / Medium / Large) used. It is read when nothing is saved under the key above, and never written. */
export const EARLIER_TEXT_SIZE_STORAGE_KEY = 'fernledger-text-size'

/**
 * What the earlier controls saved under `EARLIER_TEXT_SIZE_STORAGE_KEY`, as the size nearest it that is not smaller, so a choice is not lost and nobody's text shrinks.
 * Small and Medium are the same sizes. Large was 20px, which is Xtra Large now. The first control's A is Medium, and its A+ and A++ were both 20px by the time of the second.
 * public/text-size-init.js repeats this.
 */
const SAVED_BY_EARLIER_CONTROLS = new Map<string, TextSize>([
  ['small', 'small'],
  ['medium', 'medium'],
  ['large', 'xlarge'],
  ['a', 'medium'],
  ['a-plus', 'xlarge'],
  ['a-plus-plus', 'xlarge'],
])

/**
 * The size `saved` (what is under `TEXT_SIZE_STORAGE_KEY`) names; when that is nothing, the one `savedEarlier` (what is under `EARLIER_TEXT_SIZE_STORAGE_KEY`) names; Medium
 * when neither does. A choice made on this control always wins over an earlier one.
 */
export function parseTextSize(saved: string | null, savedEarlier: string | null = null): TextSize {
  return TEXT_SIZES.find((size) => size.value === saved)?.value ?? SAVED_BY_EARLIER_CONTROLS.get(savedEarlier ?? '') ?? 'medium'
}

/** The size saved on this device; Medium when none is saved or storage is blocked. */
export const loadTextSize = (storage: DeviceStorage): TextSize =>
  parseTextSize(readDevice(storage, TEXT_SIZE_STORAGE_KEY), readDevice(storage, EARLIER_TEXT_SIZE_STORAGE_KEY))

/** Remembers the size on this device. False when it couldn't be saved; the size still applies until the page closes. */
export const saveTextSize = (size: TextSize, storage: DeviceStorage) => writeDevice(storage, TEXT_SIZE_STORAGE_KEY, size)
