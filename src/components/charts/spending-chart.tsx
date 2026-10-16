import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartFigure, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { shorten, type SpendingCategory } from '@/lib/charts'
import { formatAxisDollars, formatBalance } from '@/lib/format'
import { useElementWidth, useRem } from '@/lib/use-chart-size'

const config = { cents: { label: 'Spent', color: 'var(--chart-2)' } } satisfies ChartConfig

/**
 * The bars of the Spending by Category Report: one for each Category in `bars` (the biggest that spent something, `barsOf` in src/lib/charts.ts), its name beside it as far as there is
 * room (the tooltip and the Report's table have the whole name). It is a picture of the Report's own figures, which are written out in the table below it: it draws them as they are given
 * and reads nothing of its own. `label` is the sentence a screen reader takes it by, which says where the figures are. It is the part of the Report that loads the chart library
 * (`LazySpendingChart`), so the Report's page does not need the library until it has figures to draw.
 */
export function SpendingChart({ bars, label }: { bars: SpendingCategory[]; label: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const rem = useRem()
  // The names get up to 40% of the width, and no more than 14rem or less than 5rem; each character is about 0.55rem.
  const labelWidth = Math.round(Math.min(Math.max(width * 0.4, rem * 5), rem * 14))
  const maxChars = Math.max(5, Math.floor(labelWidth / (rem * 0.55)))
  return (
    <ChartFigure label={label}>
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
    </ChartFigure>
  )
}
