import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { ChartContainer, ChartFigure, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { netWorthSummary } from '@/lib/charts'
import { formatAxisDollars, formatBalance, formatDate, formatMonthShort } from '@/lib/format'
import { netWorthQuery } from '@/lib/queries'

const config = { netWorth: { label: 'Net worth', color: 'var(--chart-2)' } } satisfies ChartConfig

// Few enough points to mark each one; a long history is a plain line.
const MARK_EACH_POINT_UNDER = 14

/** What is not in the total, in words. */
function notCountedNote(names: string[]) {
  return `Not counted yet: ${names.join(', ')}. ${names.length === 1 ? 'It has' : 'They have'} no bank balance to work from, so ${names.length === 1 ? 'its' : 'their'} balance is not in the total.`
}

/**
 * Net worth over time: the balance of every Account added up at the end of each month (worker/net-worth.ts). The line is a picture of the figures
 * under "Show the figures", which a screen reader and a printout use. The figures come from the Worker as they are shown.
 */
export function NetWorthChart() {
  const { data, error } = useQuery(netWorthQuery)
  return (
    <section aria-labelledby="net-worth-heading">
      <h2 id="net-worth-heading" className="mb-3 text-xl font-semibold">
        Net worth over time
      </h2>
      {error ? (
        <p role="alert">Fernledger couldn't load net worth. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status">Loading…</p>
      ) : data.tooManyAccounts ? (
        <p>
          Net worth can be drawn for up to {data.tooManyAccounts.limit} Accounts, and this Fernledger has {data.tooManyAccounts.count}. Fernledger would rather draw nothing than a total of only some of them.
        </p>
      ) : data.points.length === 0 ? (
        <p>
          {data.notCounted.length === 0
            ? 'There are no Accounts yet, so there is no net worth to draw.'
            : `No Account has a bank balance to work from yet, so there is no net worth to draw. ${notCountedNote(data.notCounted.map((a) => a.accountName))}`}
        </p>
      ) : (
        <>
          <p className="mb-3 text-muted-foreground">
            The balance of every Account added up at the end of each month, from the bank balances in your Imports. Before an Account's first Transaction it counts at the balance it opened with, and after its last it
            keeps its last balance. The last point is the latest date we hold, not the end of the month.
          </p>
          <ChartFigure label={netWorthSummary(data.points)}>
            <ChartContainer config={config} className="h-64 sm:h-80">
              <LineChart data={data.points} accessibilityLayer={false} margin={{ top: 8, right: 28, bottom: 4, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickFormatter={(date: string) => formatMonthShort(date.slice(0, 7))} interval="preserveStartEnd" minTickGap={24} tickMargin={6} />
                <YAxis width="auto" tickFormatter={formatAxisDollars} domain={['auto', 'auto']} tickCount={5} tickMargin={4} />
                <ChartTooltip
                  cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '4 4' }}
                  content={<ChartTooltipContent labelFormatter={(date) => formatDate(String(date))} valueFormatter={formatBalance} />}
                />
                <Line
                  dataKey="cents"
                  name="Net worth"
                  type="linear"
                  stroke="var(--color-netWorth)"
                  strokeWidth={3}
                  dot={data.points.length < MARK_EACH_POINT_UNDER ? { r: 4, fill: 'var(--color-netWorth)', stroke: 'var(--color-netWorth)' } : false}
                  activeDot={{ r: 6 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          </ChartFigure>
          <details className="mt-3">
            <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Show the figures</summary>
            <ResponsiveTable
              caption="Net worth at the end of each month, newest first"
              rows={[...data.points].reverse()}
              getRowKey={(row) => row.date}
              columns={[
                { key: 'date', header: 'Date', cell: (row) => formatDate(row.date) },
                { key: 'netWorth', header: 'Net worth', align: 'end', cell: (row) => <Amount cents={row.cents} balance /> },
              ]}
            />
          </details>
          {data.notCounted.length > 0 && <p className="mt-3 text-muted-foreground">{notCountedNote(data.notCounted.map((a) => a.accountName))}</p>}
        </>
      )}
    </section>
  )
}
