import { lazy, Suspense } from 'react'

const Charts = lazy(() => import('./charts'))

/** The charts, loaded when they are first shown: the chart library is a large part of the app's code, and not every page needs it. */
export function LazyCharts() {
  return (
    <Suspense fallback={<p role="status">Loading the charts…</p>}>
      <Charts />
    </Suspense>
  )
}
