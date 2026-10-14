import type { DeviceStorage } from './device-storage'

export const SIDEBAR_STORAGE_KEY = 'fernledger-sidebar'

export type SidebarChoice = 'open' | 'closed'

/**
 * From this width the sidebar starts open; below it (down to the phone's sheet at 768px) it starts as the icon rail. Between a tablet in portrait and a small laptop
 * an open sidebar takes a third of the window, and the pages, which are laid out for the whole window, are squeezed. In rem, like the Tailwind breakpoints.
 */
export const SIDEBAR_WIDE_QUERY = '(min-width: 68.75rem)'

/** What the person chose on this device, or undefined while they haven't (or storage is blocked). Remembered per device, like the text size and the theme. */
export function loadSidebarChoice(storage: DeviceStorage): SidebarChoice | undefined {
  try {
    const saved = storage?.getItem(SIDEBAR_STORAGE_KEY)
    return saved === 'open' || saved === 'closed' ? saved : undefined
  } catch {
    return undefined // storage blocked: follow the width of the screen
  }
}

/** Remembers the choice. False when it couldn't be saved; the sidebar still follows it until the page closes. */
export function saveSidebarChoice(open: boolean, storage: DeviceStorage) {
  if (!storage) return false
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, open ? 'open' : 'closed')
    return true
  } catch {
    return false
  }
}

/** Open or the icon rail: the person's choice when they have made one, otherwise open on a wide screen only. */
export const sidebarIsOpen = (choice: SidebarChoice | undefined, wide: boolean) => (choice === undefined ? wide : choice === 'open')
