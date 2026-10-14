/** The part of `localStorage` the app uses, so tests can pass a stand-in. */
export type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'> | undefined

/** This device's `localStorage`, or undefined when the browser blocks even looking at it. */
export function deviceStorage(): DeviceStorage {
  try {
    return localStorage
  } catch {
    return undefined
  }
}

/** What is saved under `key` on this device; null when nothing is, or when the browser blocks storage (private modes, blocked site data). */
export function readDevice(storage: DeviceStorage, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Remembers `value` under `key` on this device. False when it couldn't be saved; the choice still applies until the page closes. */
export function writeDevice(storage: DeviceStorage, key: string, value: string) {
  if (!storage) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
