import { createFileRoute } from '@tanstack/react-router'
import { LazyNetWorthChart } from '@/components/charts/lazy-charts'
import { PageHeading } from '@/components/help-sheet'
import { SummaryGrid } from '@/components/summary/dashboard-card'
import { NET_WORTH_ABOUT } from '@/lib/charts'

// A page of its own in the sidebar's Reports group, next to the Reports page and not one of the Reports (it is a chart, not a page laid out for paper), so it has a row of its own
// (`group`, and no `within`) where a Report is named under Reports. `order` puts it after the Reports page (10) and before the six Reports, which the Admin has rows for (20 to 70), and Accounts, which a Member finds there (60). The "reports_" in the file name
// keeps it from being a page inside the Reports page, as the Reports' own pages are.
export const Route = createFileRoute('/reports_/net-worth')({
  component: NetWorth,
  staticData: { nav: { label: 'Net worth', group: 'reports', order: 15 } },
})

/**
 * Net worth over time: the money in the Accounts added up at the end of each month. Opening the page reads nothing. The chart's card waits for "Show net worth", because working it out
 * reads every Transaction of every Account (ADR 0004). Every Member can open it, as every Member can read the Summary.
 */
function NetWorth() {
  return (
    <>
      <PageHeading
        help={NET_WORTH_ABOUT.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      >
        Net worth
      </PageHeading>
      <SummaryGrid>
        <LazyNetWorthChart />
      </SummaryGrid>
    </>
  )
}
