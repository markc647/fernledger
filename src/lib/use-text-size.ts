import { useEffect, useState } from 'react'
import { deviceStorage } from './device-storage'
import { loadTextSize, saveTextSize, type TextSize } from './text-size'

/**
 * The text size, remembered on this device only. If the browser blocks storage the choice still applies until the page closes. public/text-size-init.js applies the
 * saved size before first paint. It is used by the layout, not by the controls, so the one in the header and the one in a phone's menu cannot disagree.
 */
export function useTextSize() {
  const [size, setSize] = useState<TextSize>(() => loadTextSize(deviceStorage()))

  useEffect(() => {
    document.documentElement.setAttribute('data-text-size', size)
  }, [size])

  const choose = (value: TextSize) => {
    setSize(value)
    saveTextSize(value, deviceStorage())
  }

  return { size, choose }
}
