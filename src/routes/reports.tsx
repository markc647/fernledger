import { createFileRoute, Link } from '@tanstack/react-router'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { REPORTS } from '@/lib/reports'

export const Route = createFileRoute('/reports')({
  component: Reports,
  staticData: { nav: { label: 'Reports', group: 'reports', order: 50 } },
})

/**
 * Where a Member chooses a Report: a card for each of the six, which links to its page. On its page a Report has its form (the Account and the dates) and, once they are chosen,
 * the Report itself, laid out for paper, which the browser prints or saves as a PDF; nothing is made on the server. Every Member can open every Report.
 */
function Reports() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Reports</h1>
      <p className="mt-2">Choose a Report. Each is laid out for paper: choose its dates on its page, then print it or save it as a PDF.</p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Object.values(REPORTS).map((report) => (
          <li key={report.to} className="flex">
            {/* The stock Card, as the Summary's cards (src/components/summary/dashboard-card.tsx) use it: text at the page's size, and a border as well as the ring, which Windows high contrast removes. */}
            <Card className="w-full min-w-0 overflow-visible border text-base ring-0">
              <CardHeader>
                <CardTitle className="text-xl font-semibold">
                  <h2>{report.name}</h2>
                </CardTitle>
                <CardDescription className="text-base">{report.summary}</CardDescription>
              </CardHeader>
              <CardFooter className="mt-auto">
                <Link to={report.to} className={buttonVariants({ size: 'touch' })}>
                  Open<span className="sr-only"> {report.name}</span>
                </Link>
              </CardFooter>
            </Card>
          </li>
        ))}
      </ul>
    </>
  )
}
