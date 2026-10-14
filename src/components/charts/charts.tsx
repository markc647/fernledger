import { NetWorthChart } from './net-worth-chart'
import { SpendingByCategory } from './spending-by-category'

/**
 * The two charts, as the cards of the Summary and the Dashboard that draw them (a fragment, so each is a cell of the page's grid): how net worth has changed, which waits until the
 * reader asks for it, and where the money has gone, which is drawn at once.
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
