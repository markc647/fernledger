import { createFileRoute } from '@tanstack/react-router'
import Charts from '@/components/charts/charts'

export const Route = createFileRoute('/charts')({
  component: ChartsPage,
  staticData: { nav: { label: 'Charts', order: 5 } },
})

/** Trends for every Member: how net worth has changed, and where the money has gone in a period they choose. The Admin has the same charts on the Dashboard. */
function ChartsPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Charts</h1>
      <div className="mt-6">
        <Charts choosableRange />
      </div>
    </>
  )
}
