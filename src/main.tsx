import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { routeTree } from './routeTree.gen'
import { withoutSignInParam } from './lib/session'

// "Sign in again" (src/lib/session.ts) comes back to the same address with a value on its query; the router never sees it.
const address = `${location.pathname}${location.search}${location.hash}`
const tidy = withoutSignInParam(address)
if (tidy !== address) history.replaceState(history.state, '', tidy)

const queryClient = new QueryClient()
const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' })

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
