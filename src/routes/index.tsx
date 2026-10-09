import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { meQuery } from '@/lib/me'

export const Route = createFileRoute('/')({ component: Summary })

function Summary() {
  const { data: me } = useQuery(meQuery)
  return (
    <>
      <h1 className="text-2xl font-semibold">Summary</h1>
      {me && <p className="mt-2">Signed in as {me.email} ({me.role === 'admin' ? 'Admin' : 'read-only Member'}).</p>}
    </>
  )
}
