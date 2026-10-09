import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({
  component: Settings,
  staticData: { nav: { label: 'Settings', adminOnly: true, order: 90 } },
})

// Placeholder so the Admin-only navigation item has a page; the Settings screen replaces this file.
function Settings() {
  return <h1 className="text-2xl font-semibold">Settings</h1>
}
