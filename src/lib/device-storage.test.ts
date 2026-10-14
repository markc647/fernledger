import { describe, expect, it } from 'vitest'
import { readDevice, writeDevice } from './device-storage'
import { blockedStorage, fakeStorage } from './test-storage'

// What the text size, the theme and the sidebar share: a value kept on this device, which never throws if the browser will not keep it.
describe('readDevice and writeDevice', () => {
  it('keep a value on this device and give it back', () => {
    const storage = fakeStorage()
    expect(writeDevice(storage, 'key', 'value')).toBe(true)
    expect(readDevice(storage, 'key')).toBe('value')
  })
  it('read null when nothing is kept', () => {
    expect(readDevice(fakeStorage(), 'key')).toBeNull()
  })
  it('read null, without throwing, when storage is blocked', () => {
    expect(readDevice(blockedStorage(), 'key')).toBeNull()
  })
  it('report, without throwing, that a value could not be kept when storage is blocked', () => {
    expect(writeDevice(blockedStorage(), 'key', 'value')).toBe(false)
  })
  it('read null, and keep nothing, when there is no storage object at all', () => {
    expect(readDevice(undefined, 'key')).toBeNull()
    expect(writeDevice(undefined, 'key', 'value')).toBe(false)
  })
})
