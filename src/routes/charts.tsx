import { createFileRoute, redirect } from '@tanstack/react-router'

// There is no Charts page: net worth over time has the Net worth page (in the sidebar's Reports group) and spending by Category is on the Spending by Category Report. The address stays,
// for a bookmark or a link made when there was a page of charts, and goes to the Net worth page, the chart that was there which has a page of its own. It is no page of its own, so it is
// not in the sidebar.
export const Route = createFileRoute('/charts')({
  beforeLoad: () => {
    throw redirect({ to: '/reports/net-worth', replace: true })
  },
})
