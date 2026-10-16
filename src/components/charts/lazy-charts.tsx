import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react'
import { ErrorBoundary } from '@/components/error-boundary'

const NetWorthChart = lazy(() => import('./net-worth-chart').then((module) => ({ default: module.NetWorthChart })))
const SpendingChart = lazy(() => import('./spending-chart').then((module) => ({ default: module.SpendingChart })))

/**
 * Where a chart goes: the chart library is a large part of the app's code and no other page needs it, so a page loads a chart when it is shown. Until it arrives a line stands where
 * the chart will be, and if it cannot be loaded (a tab left open across a deploy asks for a chunk that is gone) that line says so and the rest of the page stays: the Net worth page's
 * heading, or the Spending by Category Report with its table.
 */
function WhereItLoads({ what, children }: { what: string; children: ReactNode }) {
  return (
    <ErrorBoundary fallback={<p role="alert">The {what} couldn't be loaded. Reload the page to try again.</p>}>
      <Suspense fallback={<p>Loading the {what}…</p>}>{children}</Suspense>
    </ErrorBoundary>
  )
}

/** The Net worth page's card: net worth over time, which waits for a button before it asks the Worker for anything (ADR 0004). */
export function LazyNetWorthChart() {
  return (
    <WhereItLoads what="net worth chart">
      <NetWorthChart />
    </WhereItLoads>
  )
}

/** The bars of the Spending by Category Report, drawn from the Report's own figures. */
export function LazySpendingChart(props: ComponentProps<typeof SpendingChart>) {
  return (
    <WhereItLoads what="chart">
      <SpendingChart {...props} />
    </WhereItLoads>
  )
}
