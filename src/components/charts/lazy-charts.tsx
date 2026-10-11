import { lazy, Suspense } from 'react'

const Charts = lazy(() => import('./charts'))

/** The Dashboard's charts, loaded when they are first shown: the chart library is a large part of the app's code, and not every page needs it. Net worth waits to be asked for. */
export function LazyCharts() {
  return (
    <Suspense fallback={<p>Loading the charts…</p>}>
      <Charts netWorthOnRequest />
    </Suspense>
  )
}
