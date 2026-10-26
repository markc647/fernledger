import { describe, expect, it } from 'vitest'
import { loadSidebarChoice, saveSidebarChoice, sidebarIsOpen, SIDEBAR_STORAGE_KEY } from './sidebar-state'
import { blockedStorage, fakeStorage } from './test-storage'

describe('loadSidebarChoice and saveSidebarChoice', () => {
  it('remember a choice to open or close the sidebar on this device', () => {
    const storage = fakeStorage()
    expect(saveSidebarChoice(false, storage)).toBe(true)
    expect(storage.getItem(SIDEBAR_STORAGE_KEY)).toBe('closed')
    expect(loadSidebarChoice(storage)).toBe('closed')
    expect(saveSidebarChoice(true, storage)).toBe(true)
    expect(loadSidebarChoice(storage)).toBe('open')
  })
  it('have no choice when nothing is saved or the saved value is junk', () => {
    expect(loadSidebarChoice(fakeStorage())).toBeUndefined()
    for (const junk of ['', 'true', 'false', 'OPEN', 'collapsed']) expect(loadSidebarChoice(fakeStorage({ [SIDEBAR_STORAGE_KEY]: junk }))).toBeUndefined()
  })
  it('have no choice, without throwing, when storage is blocked', () => {
    expect(loadSidebarChoice(blockedStorage())).toBeUndefined()
  })
  it('report, without throwing, that a choice could not be saved when storage is blocked', () => {
    expect(saveSidebarChoice(false, blockedStorage())).toBe(false)
  })
  it('have no choice, and save nothing, when there is no storage object at all', () => {
    expect(loadSidebarChoice(undefined)).toBeUndefined()
    expect(saveSidebarChoice(true, undefined)).toBe(false)
  })
})

describe('sidebarIsOpen', () => {
  it('follows the width of the screen until the person has chosen', () => {
    expect(sidebarIsOpen(undefined, true)).toBe(true)
    expect(sidebarIsOpen(undefined, false)).toBe(false)
  })
  it("lets the person's choice win over the width", () => {
    expect(sidebarIsOpen('closed', true)).toBe(false)
    expect(sidebarIsOpen('open', false)).toBe(true)
  })
})
