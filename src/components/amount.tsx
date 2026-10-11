import { cn } from '@/lib/utils'
import { formatAmount, formatBalance, moneyLabel } from '@/lib/format'

/**
 * An NZD amount from integer cents. The sign is always written ("+$12.00", "−$12.00"), so colour only reinforces it.
 * Digits are tabular (fixed width) and the text never wraps, so a column of amounts lines up when right-aligned
 * (put it in a cell with `align: 'end'`). Use `balance` for an Account balance, which is signed only when negative.
 * `showLabel` adds "Money in" or "Money out" in words under the amount.
 */
export function Amount({
  cents,
  balance = false,
  showLabel = false,
  className,
}: {
  cents: number
  balance?: boolean
  showLabel?: boolean
  className?: string
}) {
  const label = showLabel ? moneyLabel(cents) : null
  return (
    <span className={cn('inline-flex flex-col items-end', className)}>
      <span className={cn('font-medium whitespace-nowrap tabular-nums [font-kerning:none]', cents < 0 && 'text-danger', cents > 0 && !balance && 'text-success')}>
        {balance ? formatBalance(cents) : formatAmount(cents)}
      </span>
      {label && <span className="whitespace-nowrap text-muted-foreground">{label}</span>}
    </span>
  )
}
