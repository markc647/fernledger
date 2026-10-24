import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'
import { Status } from '@/components/status'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { featuresQuery } from '@/lib/features'
import { HttpError } from '@/lib/me'
import { accountsQuery } from '@/lib/queries'
import { accountNote, runSummary, type SyncRunOutcome } from '@/lib/sync'

/**
 * "Run a Sync now", on the Settings screen: the Admin asks for the daily pull from Akahu without waiting for the morning cron
 * (worker/sync-route.ts). It belongs here because this is the Admin-only screen the Akahu tokens' own "Setup needed" lives on,
 * and the Cutover Dates a Sync depends on are set a few centimetres above it: after adding the tokens, or fixing a Cutover
 * Date, the Admin can see straight away whether Sync works, on the screen they were already on.
 *
 * While Sync isn't set up the section says so in the Worker's own words, the same way the D1 usage bar does, and no request is
 * made: the route would answer "Not set up" and contact no one (ADR 0008, ADR 0010).
 *
 * The button is off while its own run is in flight, which is the only overlap of two Syncs worth narrowing; nothing stops the
 * rest, and nothing needs to ([ADR 0013](../../docs/adr/0013-no-sync-lock.md)).
 */
export function SyncNow() {
  const queryClient = useQueryClient()
  const { data: features } = useQuery(featuresQuery)
  const { data: accounts } = useQuery(accountsQuery)
  const feature = features?.find((candidate) => candidate.id === 'akahu-sync')
  const on = feature?.enabled === true
  const heading = useId()

  const run = useMutation({
    mutationFn: async (): Promise<SyncRunOutcome> => {
      const res = await api.sync.runs.$post({ json: {} })
      if (!res.ok) throw new HttpError(res.status)
      return res.json()
    },
    // A Sync writes Transactions, so everything drawn from them is stale: the Balances, the Summary's cards and the lists.
    onSuccess: () => queryClient.invalidateQueries(),
  })

  // Nothing until the Worker has said whether Sync is set up: the rest of the screen is complete without this.
  if (!feature) return null
  const summary = run.data && runSummary(run.data)
  const nameOf = (accountId: number) => accounts?.find((account) => account.id === accountId)?.name ?? `Account ${accountId}`
  return (
    <section aria-labelledby={heading} className="mt-10 max-w-xl">
      <h2 id={heading} className="text-lg font-semibold">
        Run a Sync now
      </h2>
      {!on ? (
        // Setup needed (GLOSSARY): optional, so it reads as an offer and not a fault. The Worker's own words for it, with the
        // secrets to add, are in the "Setup needed" section a few centimetres below, so this points at them rather than
        // repeating them: the Admin would otherwise read the same paragraph twice on one screen.
        <p className="mt-1">{feature.name} isn't set up yet, so there is nothing to run. Setup needed, below, says what to add.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Sync runs itself each morning. Run it now to see whether your Akahu tokens work, or to try again after fixing them. It reads the same dates the morning run would.
          </p>
          <Button className="mt-3" size="touch" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running a Sync…' : 'Run a Sync now'}
          </Button>
          <div role="status" className="mt-3 space-y-2">
            {run.isPending ? (
              <p>Asking Akahu for new Transactions…</p>
            ) : summary ? (
              <>
                <p>
                  <Status tone={summary.tone}>{summary.text}</Status>
                </p>
                {run.data!.accounts.length > 0 && (
                  <ul className="space-y-2">
                    {run.data!.accounts.map((account) => {
                      const note = accountNote(account)
                      return (
                        <li key={account.accountId}>
                          <span className="font-medium">{nameOf(account.accountId)}</span>
                          <br />
                          <Status tone={note.tone}>{note.text}</Status>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            ) : null}
          </div>
          {run.isError && (
            <p role="alert" className="mt-3">
              <Status tone="danger">Fernledger could not start a Sync. Reload the page and try again.</Status>
            </p>
          )}
        </>
      )}
    </section>
  )
}
