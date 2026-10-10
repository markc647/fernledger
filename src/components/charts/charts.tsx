import { NetWorthChart } from './net-worth-chart'
import { SpendingByCategory } from './spending-by-category'

/**
 * The two charts, one after the other: how net worth has changed, and where the money has gone. Shared by the Charts page, where the reader chooses how far back net
 * worth goes (`choosableRange`), and the Admin's Dashboard, which draws the last 24 months and links to the page for more.
 * It is the only part of the app that loads the chart library. The Dashboard loads it on demand (`LazyCharts`) and the Charts page is a route of its own, so a
 * Member's Summary does not download it.
 */
export default function Charts({ choosableRange = false }: { choosableRange?: boolean }) {
  return (
    <div className="grid gap-8">
      <NetWorthChart choosable={choosableRange} />
      <SpendingByCategory />
    </div>
  )
}
