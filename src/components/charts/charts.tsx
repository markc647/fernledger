import { NetWorthChart } from './net-worth-chart'
import { SpendingByCategory } from './spending-by-category'

/**
 * The two charts, one after the other: how net worth has changed, and where the money has gone. Shared by the Charts page and the Admin's Dashboard.
 * It is the only part of the app that loads the chart library. The Dashboard loads it on demand (`LazyCharts`) and the Charts page is a route of its
 * own, so a Member's Summary does not download it.
 */
export default function Charts() {
  return (
    <div className="grid gap-8">
      <NetWorthChart />
      <SpendingByCategory />
    </div>
  )
}
