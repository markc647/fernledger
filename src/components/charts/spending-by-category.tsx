import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ResponsiveTable } from '@/components/responsive-table'
import { Spent } from '@/components/spent'
import { ChartContainer, ChartFigure, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { UNCATEGORISED_SPENDING } from '@/lib/budgets'
import { barsOf, datesProblem, describeDates, PERIOD_LABELS, PERIODS, shorten, spendingSummary, type SpendingCategory, type SpendingPeriod } from '@/lib/charts'
import { MAX_DATE, MIN_DATE } from '@/lib/date-range'
import { formatAxisDollars, formatBalance } from '@/lib/format'
import { spendingByCategoryQuery } from '@/lib/queries'
import { useElementWidth, useRem } from '@/lib/use-chart-size'

const config = { cents: { label: 'Spent', color: 'var(--chart-2)' } } satisfies ChartConfig

/** The bars: one for each Category drawn, its name beside it as far as there is room (the tooltip and the table have the whole name). */
function Bars({ bars }: { bars: SpendingCategory[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const rem = useRem()
  // The names get up to 40% of the width, and no more than 14rem or less than 5rem; each character is about 0.55rem.
  const labelWidth = Math.round(Math.min(Math.max(width * 0.4, rem * 5), rem * 14))
  const maxChars = Math.max(5, Math.floor(labelWidth / (rem * 0.55)))
  return (
    <div ref={ref}>
      {/* Rows are rem tall, so a larger text size gives each name and bar more room. */}
      <ChartContainer config={config} className="min-w-0" style={{ height: `${bars.length * 2.75 + 3}rem` }}>
        <BarChart data={bars} layout="vertical" accessibilityLayer={false} margin={{ top: 4, right: 28, bottom: 4, left: 0 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, 'auto']} tickFormatter={formatAxisDollars} tickCount={4} tickMargin={4} />
          <YAxis type="category" dataKey="name" width={labelWidth} interval={0} tickLine={false} tickMargin={6} tickFormatter={(name: string) => shorten(name, maxChars)} />
          <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent labelFormatter={(name) => String(name)} valueFormatter={formatBalance} />} />
          <Bar dataKey="cents" name="Spent" fill="var(--color-cents)" stroke="var(--color-cents)" radius={4} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

/** The period or dates the Worker is asked about. */
type Choice = SpendingPeriod | 'custom'

/**
 * Spending by Category for a period the reader chooses: bars for the biggest Categories and a table of them all (worker/spending-by-category.ts, so what is
 * Spending is the same as in Budget vs actual and a Report of it: Transfers, Pending Transactions, Income and Loans are left out, and Uncategorised is counted).
 * The figures come from the Worker as they are shown.
 */
export function SpendingByCategory() {
  const id = useId()
  const [choice, setChoice] = useState<Choice>('this-month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const problem = choice === 'custom' ? datesProblem(from, to) : null
  const request = choice === 'custom' ? { from, to } : { period: choice }
  const { data, error, isPlaceholderData } = useQuery({ ...spendingByCategoryQuery(request), enabled: problem === null, placeholderData: keepPreviousData })

  const pick = (value: string) => {
    // Choosing dates starts from the ones on the screen, so the chart stays as it is until a date is changed.
    if (value === 'custom' && data) {
      setFrom(data.from)
      setTo(data.to)
    }
    setChoice(value as Choice)
  }
  const { rows, bars, leftOut } = barsOf(data?.categories ?? [])
  const dates = data ? describeDates(data.from, data.to) : ''

  return (
    <section aria-labelledby="spending-heading" aria-busy={isPlaceholderData}>
      <h2 id="spending-heading" className="mb-3 text-xl font-semibold">
        Spending by Category
      </h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-period`} className="block font-medium">
            Period
          </label>
          <Select id={`${id}-period`} value={choice} onChange={(event) => pick(event.target.value)}>
            {PERIODS.map((period) => (
              <option key={period} value={period}>
                {PERIOD_LABELS[period]}
              </option>
            ))}
            <option value="custom">Choose dates…</option>
          </Select>
        </div>
        {choice === 'custom' &&
          (['from', 'to'] as const).map((field) => (
            <div key={field}>
              <label htmlFor={`${id}-${field}`} className="block font-medium">
                {field === 'from' ? 'From' : 'To'}
              </label>
              <Input
                id={`${id}-${field}`}
                type="date"
                min={MIN_DATE}
                max={MAX_DATE}
                value={field === 'from' ? from : to}
                aria-invalid={problem?.field === field}
                aria-describedby={problem?.field === field ? `${id}-problem` : undefined}
                onChange={(event) => (field === 'from' ? setFrom : setTo)(event.target.value)}
              />
            </div>
          ))}
      </div>
      {problem && (
        <p id={`${id}-problem`} role="alert" className="mt-3 font-medium text-destructive">
          {problem.message}
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-4">
          Fernledger couldn't load the spending. Choose the period again, or reload the page to try again.
        </p>
      ) : !data ? (
        problem ? null : (
          <p role="status" className="mt-4">
            Loading…
          </p>
        )
      ) : (
        <div className="mt-4">
          {isPlaceholderData && (
            <p role="status" className="mb-2 font-medium">
              Updating…
            </p>
          )}
          <div className={isPlaceholderData ? 'opacity-60' : undefined}>
            <p className="mb-3 text-muted-foreground">
              What the Categories spent in {dates}, money out less money back, such as a refund. Transfers between your own Accounts, Pending Transactions, Income and Loans aren't counted.
              Uncategorised counts as spending, so money in that has no Category yet comes off it.
            </p>
            {bars.length > 0 && (
              <ChartFigure label={spendingSummary(dates, bars.length)}>
                <Bars bars={bars} />
              </ChartFigure>
            )}
            {rows.length > 0 && bars.length === 0 && (
              <p className="mb-2 font-medium">Nothing was spent above zero in {dates}: every Category took back as much as it spent, or more. The table shows what came back.</p>
            )}
            {leftOut > 0 && (
              <p className="mt-2 text-muted-foreground">
                The chart shows the biggest {bars.length} Categories. The table has {leftOut === 1 ? 'the other one' : `the other ${leftOut}`} too.
              </p>
            )}
            <div className="mt-3">
              <ResponsiveTable
                caption={`Spending by Category in ${dates}`}
                rows={rows}
                getRowKey={(row) => row.categoryId ?? 'uncategorised'}
                emptyMessage={`Nothing was spent in ${dates}.`}
                columns={[
                  { key: 'category', header: 'Category', cell: (row) => (row.categoryId === null ? UNCATEGORISED_SPENDING : row.name) },
                  { key: 'spent', header: 'Spent', align: 'end', cell: (row) => <Spent cents={row.cents} /> },
                ]}
              />
            </div>
            {rows.length > 0 && (
              <p className="mt-3 font-medium">
                Total spending in {dates}: <Spent cents={data.totalCents} />
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
