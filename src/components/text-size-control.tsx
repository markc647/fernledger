import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TEXT_SIZES, type TextSize } from '@/lib/text-size'

/**
 * The text size: Small (14px), Medium (16px, the default) and Large (20px). Which is chosen, and remembering it, is `useTextSize` (src/lib/use-text-size.ts), in the
 * layout, so the group in the header and the one in a phone's menu show the same choice. Each button is named in full ("Large text") and starts with the word it shows.
 */
export function TextSizeControl({ size, onChange, className }: { size: TextSize; onChange: (size: TextSize) => void; className?: string }) {
  return (
    <ToggleGroup
      type="single"
      value={size}
      // A toggle group lets you un-choose the chosen item (an empty value); one size is always chosen.
      onValueChange={(value) => value && onChange(value as TextSize)}
      aria-label="Text size"
      className={className}
    >
      {TEXT_SIZES.map(({ value, label, name }) => (
        <ToggleGroupItem key={value} value={value} aria-label={name} className="flex-1">
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
