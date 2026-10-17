import { cn, MONEY_TEXT } from '@/lib/utils'
import { formatAmount, formatBalance } from '@/lib/format'

/**
 * An NZD amount from integer cents. The sign is always written ("+$12.00", "−$12.00"), so colour only reinforces it, and no words say which way the money went.
 * Digits are tabular (fixed width) and the text never wraps, so a column of amounts lines up when right-aligned
 * (put it in a cell with `align: 'end'`). Use `balance` for an Account balance, which is signed only when negative.
 */
export function Amount({ cents, balance = false }: { cents: number; balance?: boolean }) {
  return <span className={cn('font-medium', MONEY_TEXT, cents < 0 && 'text-danger', cents > 0 && !balance && 'text-success')}>{balance ? formatBalance(cents) : formatAmount(cents)}</span>
}
