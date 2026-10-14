// Stand-ins for `localStorage` in the tests of what is remembered on a device (the text size, the theme, the sidebar). Not imported by the app.

/** A stand-in for localStorage. */
export const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

/** A stand-in for storage that the browser blocks (private modes, blocked site data): every access throws. */
export const blockedStorage = () => ({
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('blocked', 'SecurityError')
  },
})
