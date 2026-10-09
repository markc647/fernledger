import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { meQuery } from '@/lib/me'
import { roleLabel, type Role } from '@/lib/role'

/**
 * Local development only (rendered under `import.meta.env.DEV`, so it is not in production builds).
 * Sets the cookie the Worker honours on localhost only; see `devMember` in worker/auth.ts.
 */
export function DevIdentitySwitcher() {
  const queryClient = useQueryClient()
  const { data: me } = useQuery(meQuery)

  const switchTo = (who: Role) => {
    document.cookie = `fernledger_dev_as=${who}; path=/; SameSite=Lax`
    void queryClient.invalidateQueries()
  }

  return (
    <div role="region" aria-label="Development identity" className="border-b bg-muted">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2 text-sm">
        <span>Development only. Viewing as:</span>
        {(['admin', 'member'] satisfies Role[]).map((who) => (
          <Button
            key={who}
            size="touch"
            variant={me?.role === who ? 'default' : 'outline'}
            aria-pressed={me?.role === who}
            onClick={() => switchTo(who)}
          >
            {roleLabel(who)}
          </Button>
        ))}
      </div>
    </div>
  )
}
