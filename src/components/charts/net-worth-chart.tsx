import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useRef, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { Amount } from '@/components/amount'
import { LiveStatus } from '@/components/live-status'
import { ResponsiveTable } from '@/components/responsive-table'
import { ChartContainer, ChartFigure, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Button } from '@/components/ui/button'
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

const LOADING = 'Loading net worth. It reads every Transaction, so it can take a moment.'
const UPDATING = 'Updating net worth…'
const LOADED = 'Net worth has loaded.'

const linkStyle = 'underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Net worth over time: the money in the Accounts added up at the end of each month (worker/net-worth.ts). The line is a picture of the figures under "Show the
 * figures", which a screen reader and a printout use. The figures come from the Worker as they are shown. The Charts page (`choosable`) draws it at once and lets the
 * reader choose a range. The Dashboard (`onRequest`) does not ask the Worker until the reader presses "Show net worth", because working it out reads every Transaction,
 * and then draws the last 24 months.
 */
export function NetWorthChart({ choosable = false, onRequest = false }: { choosable?: boolean; onRequest?: boolean }) {
  const id = useId()
  const [chosen, setChosen] = useState<NetWorthRange>(DASHBOARD_NET_WORTH_RANGE)
  const [requested, setRequested] = useState(!onRequest)
  const range = choosable ? chosen : DASHBOARD_NET_WORTH_RANGE
  const { data, error, isPlaceholderData } = useQuery({ ...netWorthQuery(range), enabled: requested, placeholderData: keepPreviousData })
  const figures = useOpenForPrint()
  const heading = useRef<HTMLHeadingElement>(null)
  const early = data ? stoppedEarly(data.counted, data.points) : []
  // Pressing the button removes it, so focus goes to the heading it sits under, which is where the reader is told what is happening and then where the chart is.
  const request = () => {
    setRequested(true)
    heading.current?.focus()
  }
  // What a screen reader is told as it happens, in a region that is on the page from the start (a change is announced, an arrival often is not).
  const message = !requested || error ? '' : !data ? LOADING : isPlaceholderData ? UPDATING : LOADED
  return (
    <section aria-labelledby="net-worth-heading" aria-busy={requested && (isPlaceholderData || (!data && !error))}>
      <h2 id="net-worth-heading" ref={heading} tabIndex={-1} className="mb-3 text-xl font-semibold outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Net worth over time
      </h2>
      <LiveStatus message={message} />
      {!requested && (
        <>
          <p className="mb-3">Net worth is not drawn until you ask for it, because working it out reads every Transaction of every Account.</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Button type="button" size="touch" onClick={request}>
              Show net worth
            </Button>
            <Link to="/charts" className={`inline-flex min-h-11 items-center ${linkStyle}`}>
              Open the Charts page for longer ranges
            </Link>
          </div>
        </>
      )}
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
      {!requested ? null : error ? (
        <p role="alert">Fernledger couldn't load net worth. Reload the page to try again.</p>
      ) : !data ? (
        <p>{LOADING}</p>
      ) : data.tooManyAccounts ? (
        <p>{tooManyAccountsMessage(data.tooManyAccounts.count, data.tooManyAccounts.limit)}</p>
      ) : data.points.length === 0 ? (
        <>
          <p>{data.notCounted.length === 0 ? 'There are no Accounts yet, so there is no net worth to draw.' : 'No Account has a bank balance to count yet, so there is no net worth to draw.'}</p>
          <NotCounted accounts={data.notCounted} />
        </>
      ) : (
        <>
          {isPlaceholderData && <p className="mb-2 font-medium">Updating…</p>}
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
