import { useId } from 'react'
import { TEXT_SIZES, type TextSize } from '@/lib/text-size'
import { cn } from '@/lib/utils'

/**
 * The text size: Small (14px, the default with a mouse), Medium (16px, the default on a touch screen), Large (18px) and Xtra Large (20px), as one group of four radio buttons. They are real radio buttons (a `fieldset`
 * of `input type="radio"`), so a screen reader says what they are, Tab stops at the group once, and the arrow keys move between them and choose, as radio buttons do. Which is
 * chosen, and remembering it, is `useTextSize` (src/lib/use-text-size.ts), in the layout, so the group in the header and the one in a phone's menu show the same choice.
 * Each is named in full ("Xtra Large text") and starts with the word it shows. The input is the whole of the button, invisible and on top, so a click or a tap lands on it; the
 * word beside it is the picture. The chosen one is solid, and a keyboard's focus is an outline round it (Windows high contrast: src/index.css).
 *
 * `joined` (the header's) is one row of joined buttons, as wide as the four words need. `grid` (a phone's menu, which is a narrow column) is two rows of two, each button a button of its
 * own that may wrap its words, so that Xtra Large at the largest text still fits a 320px screen.
 */
export function TextSizeControl({
  size,
  onChange,
  layout = 'joined',
}: {
  size: TextSize
  onChange: (size: TextSize) => void
  layout?: 'joined' | 'grid'
}) {
  const group = useId() // the one in the header and the one in the phone's menu are never the same group
  const joined = layout === 'joined'
  return (
    <fieldset className={cn('m-0 min-w-0 rounded-md border-0 p-0', joined ? 'flex w-fit items-center shadow-xs' : 'grid w-full grid-cols-2 gap-1')}>
      <legend className="sr-only">Text size</legend>
      {TEXT_SIZES.map(({ value, label, name }) => (
        <label key={value} className={cn('relative flex', joined && 'flex-1 not-first-of-type:-ms-px')}>
          <input type="radio" name={group} value={value} checked={size === value} onChange={() => onChange(value)} aria-label={name} className="peer absolute inset-0 size-full cursor-pointer opacity-0" />
          <span
            data-slot="text-size-option"
            data-checked={size === value}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center border border-border bg-background text-base font-medium transition-colors select-none peer-hover:bg-muted peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:peer-hover:bg-primary/90 peer-focus-visible:z-10 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring dark:border-input',
              joined
                ? 'h-8 px-3 whitespace-nowrap pointer-coarse:h-11 pointer-coarse:min-w-11 in-[label:first-of-type]:rounded-s-md in-[label:last-of-type]:rounded-e-md'
                : 'min-h-8 rounded-md px-2 py-1 text-center shadow-xs pointer-coarse:min-h-11',
            )}
          >
            {label}
          </span>
        </label>
      ))}
    </fieldset>
  )
}
