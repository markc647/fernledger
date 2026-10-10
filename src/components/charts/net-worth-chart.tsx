import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { Amount } from '@/components/amount'
import { ResponsiveTable } from '@/components/responsive-table'
import { ChartContainer, ChartFigure, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Select } from '@/components/ui/select'
import {
  DASHBOARD_NET_WORTH_RANGE,
  NET_WORTH_ABOUT,
  NET_WORTH_RANGE_LABELS,
  NET_WORTH_RANGES,
  netWorthSummary,
  notCountedLine,
  stoppedEarly,
  stoppedEarlyLine,
  tooManyAccountsMessage,
  type NetWorthRange,
} from '@/lib/charts'
import { formatAxisDollars, formatBalance, formatDate, formatMonthShort } from '@/lib/format'
import { netWorthQuery } from '@/lib/queries'
import { useOpenForPrint } from '@/lib/use-open-for-print'

const config = { netWorth: { label: 'Net worth', color: 'var(--chart-2)' } } satisfies ChartConfig

// Few enough points to mark each one; a long history is a plain line.
const MARK_EACH_POINT_UNDER = 14

const linkStyle = 'underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Net worth over time: the money in the Accounts added up at the end of each month (worker/net-worth.ts). The line is a picture of the figures under "Show the
 * figures", which a screen reader and a printout use. The figures come from the Worker as they are shown. The Dashboard draws the last 24 months; the Charts page
 * (`choosable`) lets the reader choose a longer range.
 */
export function NetWorthChart({ choosable = false }: { choosable?: boolean }) {
  const id = useId()
  const [chosen, setChosen] = useState<NetWorthRange>(DASHBOARD_NET_WORTH_RANGE)
  const range = choosable ? chosen : DASHBOARD_NET_WORTH_RANGE
  const { data, error, isPlaceholderData } = useQuery({ ...netWorthQuery(range), placeholderData: keepPreviousData })
  const figures = useOpenForPrint()
  const early = data ? stoppedEarly(data.counted, data.points) : []
  return (
    <section aria-labelledby="net-worth-heading" aria-busy={isPlaceholderData}>
      <h2 id="net-worth-heading" className="mb-3 text-xl font-semibold">
        Net worth over time
      </h2>
      {choosable && (
        <div className="mb-3 max-w-xs">
          <label htmlFor={`${id}-range`} className="block font-medium">
            Range
          </label>
          <Select id={`${id}-range`} value={chosen} onChange={(event) => setChosen(event.target.value as NetWorthRange)}>
            {NET_WORTH_RANGES.map((value) => (
              <option key={value} value={value}>
                {NET_WORTH_RANGE_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
      )}
      {error ? (
        <p role="alert">Fernledger couldn't load net worth. Reload the page to try again.</p>
      ) : !data ? (
        <p role="status">Loading…</p>
      ) : data.tooManyAccounts ? (
        <p>{tooManyAccountsMessage(data.tooManyAccounts.count, data.tooManyAccounts.limit)}</p>
      ) : data.points.length === 0 ? (
        <>
          <p>{data.notCounted.length === 0 ? 'There are no Accounts yet, so there is no net worth to draw.' : 'No Account has a bank balance to count yet, so there is no net worth to draw.'}</p>
          <NotCounted accounts={data.notCounted} />
        </>
      ) : (
        <>
          {isPlaceholderData && (
            <p role="status" className="mb-2 font-medium">
              Updating…
            </p>
          )}
          {NET_WORTH_ABOUT.map((paragraph) => (
            <p key={paragraph} className="mb-3 text-muted-foreground">
              {paragraph}
            </p>
          ))}
          <div className={isPlaceholderData ? 'opacity-60' : undefined}>
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
          </div>
          {choosable ? (
            range === 'all' && <p className="mt-2 text-muted-foreground">Every month Fernledger holds, which can make a long line.</p>
          ) : (
            <p className="mt-2 text-muted-foreground">
              The last 24 months.{' '}
              <Link to="/charts" className={linkStyle}>
                Longer ranges are on the Charts page.
              </Link>
            </p>
          )}
          <details ref={figures} className="mt-3">
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
          {early.length > 0 && (
            <div className="mt-3 text-muted-foreground">
              <p>Some Accounts' Transactions stop before the end of the line, so their balances are carried forward and the line is flatter than the money was:</p>
              <ul className="mt-1 list-disc ps-6">
                {early.map((account) => (
                  <li key={account.accountId}>{stoppedEarlyLine(account)}</li>
                ))}
              </ul>
            </div>
          )}
          <NotCounted accounts={data.notCounted} />
        </>
      )}
    </section>
  )
}

/** The Accounts left out of the total, each with why and what the Admin can do. */
function NotCounted({ accounts }: { accounts: Parameters<typeof notCountedLine>[0][] }) {
  if (accounts.length === 0) return null
  return (
    <div className="mt-3 text-muted-foreground">
      <p>{accounts.length === 1 ? 'This Account is not in the total:' : 'These Accounts are not in the total:'}</p>
      <ul className="mt-1 list-disc ps-6">
        {accounts.map((account) => (
          <li key={account.accountId}>{notCountedLine(account)}</li>
        ))}
      </ul>
    </div>
  )
}
