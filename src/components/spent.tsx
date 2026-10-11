import { spentParts } from '@/lib/budgets'

const money = 'whitespace-nowrap tabular-nums [font-kerning:none]'

/**
 * What a Category spent, from `Spending` as the Worker works it out (money out less money back): "$55.50", or "$15.00 back" when more came back than went out (a
 * refund). Never a minus sign for spending. The amount is kept in one piece and "back" is left free to wrap, so a large figure never splits. Budget vs actual,
 * the spending chart's table and the Reports of spending all show it this way.
 */
export function Spent({ cents }: { cents: number }) {
  const { amount, back } = spentParts(cents)
  return (
    <>
      <span className={money}>{amount}</span>
      {back && ' back'}
    </>
  )
}
