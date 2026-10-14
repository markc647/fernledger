import { createFileRoute, redirect } from '@tanstack/react-router'

// There is no Charts page: its two charts are cards on the Summary (and the Dashboard). The address stays, for a bookmark or a link made when there was one, and goes to the
// page that has them now. It is no page of its own, so it is not in the sidebar.
export const Route = createFileRoute('/charts')({
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true })
  },
})
