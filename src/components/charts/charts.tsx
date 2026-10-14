import { NetWorthChart } from './net-worth-chart'
import { SpendingByCategory } from './spending-by-category'

/**
 * The two charts, as the cards of the Summary and the Dashboard that draw them (a fragment, so each is a cell of the page's grid): how net worth has changed and
 * where the money has gone, each of which waits until the reader asks for it (ADR 0004).
 * It is the only part of the app that loads the chart library, and `LazyCharts` loads it when the page is shown, so no other page downloads it.
 */
export default function Charts() {
  return (
    <>
      <NetWorthChart />
      <SpendingByCategory />
    </>
  )
}
