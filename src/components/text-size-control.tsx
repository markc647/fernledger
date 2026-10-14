import { useId } from 'react'
import { TEXT_SIZES, type TextSize } from '@/lib/text-size'
import { cn } from '@/lib/utils'

/**
 * The text size: Small (14px), Medium (16px, the default) and Large (20px), as one group of three radio buttons drawn as joined buttons. They are real radio buttons (a `fieldset`
 * of `input type="radio"`), so a screen reader says what they are, Tab stops at the group once, and the arrow keys move between them and choose, as radio buttons do. Which is
 * chosen, and remembering it, is `useTextSize` (src/lib/use-text-size.ts), in the layout, so the group in the header and the one in a phone's menu show the same choice.
 * Each is named in full ("Large text") and starts with the word it shows. The input is the whole of the button, invisible and on top, so a click or a tap lands on it; the
 * word beside it is the picture. The chosen one is solid, and a keyboard's focus is an outline round it (Windows high contrast: src/index.css).
 */
export function TextSizeControl({ size, onChange, className }: { size: TextSize; onChange: (size: TextSize) => void; className?: string }) {
  const group = useId() // the one in the header and the one in the phone's menu are never the same group
  return (
    <fieldset className={cn('m-0 flex w-fit min-w-0 items-center rounded-md border-0 p-0 shadow-xs', className)}>
      <legend className="sr-only">Text size</legend>
      {TEXT_SIZES.map(({ value, label, name }) => (
        <label key={value} className="relative flex flex-1 not-first-of-type:-ms-px">
          <input type="radio" name={group} value={value} checked={size === value} onChange={() => onChange(value)} aria-label={name} className="peer absolute inset-0 size-full cursor-pointer opacity-0" />
          <span
            data-slot="text-size-option"
            data-checked={size === value}
            className="flex h-8 min-w-0 flex-1 items-center justify-center border border-border bg-background px-3 text-sm font-medium whitespace-nowrap transition-colors select-none peer-hover:bg-muted peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:peer-hover:bg-primary/90 peer-focus-visible:z-10 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring pointer-coarse:h-11 pointer-coarse:min-w-11 in-[label:first-of-type]:rounded-s-md in-[label:last-of-type]:rounded-e-md dark:border-input"
          >
            {label}
          </span>
        </label>
      ))}
    </fieldset>
  )
}
