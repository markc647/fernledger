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
