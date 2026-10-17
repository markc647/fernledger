import { MoreHorizontal } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

// The actions on one row of a table, in a "⋯" menu, as shadcn's table with actions has them.
//
// An action does not run when its item is chosen but once the menu has closed and put focus back on the button. A menu that is open traps focus, so a form that an action opens, which takes
// focus as it appears, would be refused it and left with the button; run after, the form takes focus from the button as it would from any other. The same goes for an action that moves a Rule: focus
// has already been put back on the button, and stays there. Escape, or a click away, chooses nothing and leaves focus where the menu's own rules put it.
const Queue = createContext<RefObject<(() => void) | null> | null>(null)

/**
 * `row` names the row ("Rule 3", "Groceries"), so the button says whose actions it opens, and `id` is the button's, so that a page can put focus back on it when what an action opened is
 * closed without a change. Its items are `RowAction`s (each with what it `run`s), with a `DropdownMenuSeparator` before the destructive one.
 */
export function RowActions({ row, id, children }: { row: string; id: string; children: ReactNode }) {
  const chosen = useRef<(() => void) | null>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 44px square, as every control on a page that is not in the header or the sidebar (README, Accessibility). */}
        <Button id={id} type="button" variant="ghost" size="touch" className="px-0 align-top" aria-label={`Actions for ${row}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // Named for the button that opened it. Radix names it for the id it gives the button, which the button's own `id` replaces.
        aria-labelledby={id}
        onCloseAutoFocus={() => {
          // Radix puts focus on the button as this returns, and the action goes after it.
          const run = chosen.current
          chosen.current = null
          if (run) setTimeout(run, 0)
        }}
      >
        <Queue.Provider value={chosen}>{children}</Queue.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** An item of `RowActions`: `run` is what it does, and it runs once the menu has closed (it is not Radix's `onSelect`, which runs while the menu is still open). */
export function RowAction({ run, ...props }: Omit<ComponentProps<typeof DropdownMenuItem>, 'onSelect'> & { run: () => void }) {
  const chosen = useContext(Queue)
  return (
    <DropdownMenuItem
      {...props}
      onSelect={() => {
        if (chosen) chosen.current = run
      }}
    />
  )
}

/**
 * Where focus goes when a form or a question that a row's menu opened is closed (cancelled, or saved with its row still there): back to the row's Actions button, by its `id`, or, if the row is gone
 * (removed, or no longer in the list), to `fallback`, the page's status line, so keyboard focus is never lost. `open` is what the page has open (null when nothing is: the effect waits for it to
 * close) and `refresh` is anything else the button waits for (a list that is read again after a save). The page calls the function this returns as it closes what is open, and says which button.
 */
export function useFocusBack(open: unknown, fallback: RefObject<HTMLElement | null> | null = null, refresh?: unknown) {
  const back = useRef<{ id?: string } | null>(null)
  useEffect(() => {
    if (open !== null || back.current === null) return
    const { id } = back.current
    back.current = null
    ;((id ? document.getElementById(id) : null) ?? fallback?.current)?.focus()
  }, [open, fallback, refresh])
  return (id?: string) => {
    back.current = { id }
  }
}
