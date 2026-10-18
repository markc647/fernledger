import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RouteError } from './components/route-error'
import { sessionProblem, withoutSignInParam } from './lib/session'
import { routeTree } from './routeTree.gen'

// "Sign in again" (src/lib/session.ts) comes back to the same address with a value on its query; the router never sees it.
const address = `${location.pathname}${location.search}${location.hash}`
const tidy = withoutSignInParam(address)
if (tidy !== address) history.replaceState(history.state, '', tidy)

// A read is asked for again when it fails, three times, except once the sign-in is known to be gone: asking again would only reach Access again.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: (failureCount) => failureCount < 3 && sessionProblem() === null } } })
const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', defaultErrorComponent: RouteError })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
