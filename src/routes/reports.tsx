import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { FolderOpen, Printer, Save, Share2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PageHeading } from '@/components/help-sheet'
import { ResponsiveTable, type Column } from '@/components/responsive-table'
import { RowAction, RowActions } from '@/components/row-actions'
import { Button } from '@/components/ui/button'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { keptAccount, keptDates, keptHref, keptInSentence, keptLoan, keptName, keptRowName, type KeptReport } from '@/lib/kept-reports'
import { HttpError, meQuery } from '@/lib/me'
import { askToPrint, clearPrintRequest } from '@/lib/print-request'
import { keptReportsQuery } from '@/lib/queries'

export const Route = createFileRoute('/reports')({
  component: Reports,
  staticData: { nav: { label: 'Reports', group: 'reports', order: 10 } },
})

/**
 * The Reports the Admin has made, newest first. A Report is made on its own page (in the sidebar, under Reports), which only the Admin has the form for, and each time the Admin
 * shows one its choices are kept here: which Report, its dates and Account (or Loans Category), not its figures. Opening a kept Report works it out again from today's data. Every
 * Member can open or print one (printing is how a Member saves a PDF on their own computer); only the Admin can delete one. Save and Share are for later.
 */
function Reports() {
  const { data: me } = useQuery(meQuery)
  const { data: kept, error } = useQuery(keptReportsQuery)
  // Until `me` arrives nobody is the Admin: Delete fails closed. The API refuses a Member's delete whatever the page shows.
  const isAdmin = me?.role === 'admin'
  const [deleting, setDeleting] = useState<number | null>(null)
  const [notice, setNotice] = useState('')

  // Back to the row's Actions button when a question is closed without a change (or, if its row is gone, the message), so keyboard focus is never lost.
  const status = useRef<HTMLParagraphElement>(null)
  const focusAfter = useRef<{ id?: string } | null>(null)
  useEffect(() => {
    if (deleting !== null || focusAfter.current === null) return
    const id = focusAfter.current.id
    focusAfter.current = null
    ;((id ? document.getElementById(id) : null) ?? status.current)?.focus()
  }, [deleting])
  const done = (message: string, focusId?: string) => {
    focusAfter.current = { id: focusId }
    setNotice(message)
    setDeleting(null)
  }

  const columns: Column<KeptReport>[] = [
    {
      key: 'report',
      header: 'Report',
      cell: (k) => {
        const loan = keptLoan(k)
        return (
          <>
            {keptName(k)}
            {loan && <span className="block text-muted-foreground">{loan}</span>}
          </>
        )
      },
    },
    { key: 'dates', header: 'Dates', cell: (k) => keptDates(k) },
    { key: 'account', header: 'Account', cell: (k) => keptAccount(k) },
    { key: 'lastMade', header: 'Last made', cell: (k) => formatDateTime(k.lastMadeAt) },
    { key: 'madeBy', header: 'Made by', cell: (k) => <span className="break-all">{k.madeBy}</span> },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (k) =>
        deleting === k.id ? (
          <DeleteConfirm
            kept={k}
            onDone={(message) => done(message)}
            onCancel={() => done('', actionsId(k))}
          />
        ) : (
          <KeptActions kept={k} isAdmin={isAdmin} onDelete={() => { setNotice(''); setDeleting(k.id) }} />
        ),
    },
  ]

  return (
    <>
      <PageHeading
        help={
          <p>
            {isAdmin
              ? "Each Report you show is kept here as its choices: which Report, its dates and its Account. Opening one works it out again from today's data. Choose a Report in the sidebar, under Reports, to make one."
              : "The Reports the Admin has made. Opening one works it out again from today's data. Print it to save a PDF on your computer."}
          </p>
        }
      >
        Reports
      </PageHeading>
      {/* Always in the page, so a screen reader announces the text when it appears. */}
      <p role="status" ref={status} tabIndex={-1} className="mt-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {notice}
      </p>
      <div className="mt-6">
        {error ? (
          <p role="alert">Fernledger couldn't load the Reports. Reload the page to try again.</p>
        ) : !kept ? (
          <p role="status">Loading…</p>
        ) : (
          <ResponsiveTable
            caption="Kept Reports"
            columns={columns}
            rows={kept}
            getRowKey={(k) => k.id}
            emptyMessage={isAdmin ? 'No Reports have been made yet. Choose one under Reports in the sidebar to make the first.' : 'No Reports have been made yet. The Admin makes them.'}
            look="shadcn"
          />
        )}
      </div>
    </>
  )
}

const actionsId = (kept: KeptReport) => `kept-${kept.id}-actions`

/** What Save and Share say instead of doing anything: they are shown so the menu is the one it will be, and are turned off until they work. */
const COMING_LATER = (
  <span className="ms-auto ps-4 text-sm text-muted-foreground">Coming later</span>
)

/** A kept Report's "⋯" menu. Open and Print are for every Member; Delete, after a line, is the Admin's. */
function KeptActions({ kept, isAdmin, onDelete }: { kept: KeptReport; isAdmin: boolean; onDelete: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const href = keptHref(kept)
  // A kept Report is read again when it is opened, whatever an earlier visit kept (a Report's data is read once and kept until then: src/lib/queries.ts).
  const show = (print: boolean) => {
    if (!href) return
    void queryClient.invalidateQueries({ queryKey: ['reports'], refetchType: 'none' })
    // Open asks for no print, and so ends a Print that never printed (its Report could not be read), which would otherwise print this Report when it arrives.
    if (print) askToPrint(href)
    else clearPrintRequest()
    void navigate({ href })
  }
  return (
    <RowActions row={keptRowName(kept)} id={actionsId(kept)}>
      <RowAction disabled={!href} run={() => show(false)}>
        <FolderOpen aria-hidden />
        Open
      </RowAction>
      <RowAction disabled={!href} run={() => show(true)}>
        <Printer aria-hidden />
        Print
      </RowAction>
      <RowAction disabled run={() => {}}>
        <Save aria-hidden />
        Save
        {COMING_LATER}
      </RowAction>
      <RowAction disabled run={() => {}}>
        <Share2 aria-hidden />
        Share
        {COMING_LATER}
      </RowAction>
      {isAdmin && (
        <>
          <DropdownMenuSeparator />
          <RowAction variant="destructive" run={onDelete}>
            <Trash2 aria-hidden />
            Delete
          </RowAction>
        </>
      )}
    </RowActions>
  )
}

/** The question Delete asks, in the row, as removing a Rule or a Category does. Opens on the safe answer; cancelling puts focus back on the row's Actions button, and a delete on the message. */
function DeleteConfirm({ kept, onDone, onCancel }: { kept: KeptReport; onDone: (message: string) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [])
  const name = keptRowName(kept)
  const remove = useMutation({
    mutationFn: async () => {
      const res = await api['kept-reports'][':id'].$delete({ param: { id: String(kept.id) }, json: {} })
      if (res.status === 404) return false // another page, or a second click, deleted it first: the list on this page is out of date, and nothing is left to delete
      if (!res.ok) throw new HttpError(res.status)
      return true
    },
    onSuccess: async (deleted) => {
      await queryClient.invalidateQueries({ queryKey: ['kept-reports'] })
      onDone(deleted ? `Deleted ${name}.` : `${name} had already been deleted, so nothing was changed. The list is up to date now.`)
    },
  })

  return (
    <div role="group" aria-label={`Delete ${name}`} className="space-y-2 text-start">
      <p>
        Delete the {keptInSentence(kept)}? It comes off this list, so no Member can open it. Show it again from its page in the sidebar to make it again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="touch" aria-label={`Yes, delete ${name}`} disabled={remove.isPending} onClick={() => remove.mutate()}>
          Yes, delete
        </Button>
        <Button ref={keep} size="touch" variant="outline" onClick={onCancel}>
          Keep it
        </Button>
      </div>
      {remove.isError && <p role="alert" className="font-medium text-destructive">That did not work. Try again.</p>}
    </div>
  )
}
