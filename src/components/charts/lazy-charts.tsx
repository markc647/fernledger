import { lazy, Suspense } from 'react'
import { spanClass } from '@/components/summary/dashboard-card'

const Charts = lazy(() => import('./charts'))

/**
 * The charts' cards, loaded when the Summary or the Dashboard is first shown: the chart library is a large part of the app's code, and no other page needs it. Until it arrives
 * a line stands where the cards will be, across the whole of the grid.
 */
export function LazyCharts() {
  return (
    <Suspense fallback={<p className={spanClass('full')}>Loading the charts…</p>}>
      <Charts />
    </Suspense>
  )
}
