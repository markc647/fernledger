import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { deviceStorage, loadTextSize, saveTextSize, TEXT_SIZES, type TextSize } from '@/lib/text-size'

/**
 * A / A+ / A++ text size. The choice is remembered on this device only. If the browser blocks storage the choice still
 * applies until the page closes. public/text-size-init.js applies the saved size before first paint.
 */
export function TextSizeControl() {
  const [size, setSize] = useState<TextSize>(() => loadTextSize(deviceStorage()))

  useEffect(() => {
    document.documentElement.setAttribute('data-text-size', size)
  }, [size])

  const choose = (value: TextSize) => {
    setSize(value)
    saveTextSize(value, deviceStorage())
  }

  return (
    <div role="group" aria-label="Text size" className="flex gap-1">
      {TEXT_SIZES.map(({ value, label }) => (
        <Button
          key={value}
          size="touch"
          variant={size === value ? 'default' : 'outline'}
          aria-pressed={size === value}
          onClick={() => choose(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}
