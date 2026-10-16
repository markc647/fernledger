import { CircleQuestionMark } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'

// Text a reader reads once (what a page is for, how a form is filled in, how a figure is worked out) is in a sheet that opens from a "?" beside the page's heading, so that the table or the
// form under the heading is not pushed down the page by it (CODING_STANDARDS.md, UI). What stays on the page is what the reader needs each time: a warning, an error, a short hint for a
// field, the figures and the data. The speech-bubble icon is a Transaction's Note (transaction-list.tsx), so the "?" is for help and nothing else.

/** What the "?" is called, and what the sheet is titled: the same on every page, so it can be found by its name. */
export const HELP_LABEL = 'About this page'

/** A heading in the sheet's text, for a page whose help has more than one part. */
export function HelpHeading({ children }: { children: ReactNode }) {
  return <h3 className="pt-1 text-lg font-semibold">{children}</h3>
}

/**
 * The "?" button and the sheet it opens, from the right, with `children` for its text and a Close button at the foot (always in reach: the text scrolls, and Close does not). Esc, Close or
 * a tap on the page beside it closes the sheet, and focus goes back to the "?". The sheet is a dialog, so it opens with focus on itself and the text is read from the top; Tab then reaches the
 * text's links and Close. Use `PageHeading`, which puts the button where it belongs.
 */
export function HelpSheet({ children }: { children: ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className="rounded-full print:hidden" aria-label={HELP_LABEL}>
          <CircleQuestionMark className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        aria-describedby={undefined} // the text is the sheet's body, which can hold links and headings, not a one-line description
        className="w-[28rem] max-w-[calc(100vw-3rem)] gap-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
        }}
      >
        <SheetHeader>
          <SheetTitle className="text-xl">{HELP_LABEL}</SheetTitle>
        </SheetHeader>
        {/* Focusable so that the keyboard can scroll it when the text is longer than the room (large text on a phone). */}
        <div tabIndex={0} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          {children}
        </div>
        <SheetFooter className="border-t">
          <SheetClose asChild>
            <Button size="touch" variant="outline">
              Close
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/**
 * A page's heading, with the "?" beside it on the same row when the page has `help` (the text of its sheet). The heading is `children`; it wraps, and the button does not, so the two stay
 * on one row at every text size and width. A page with nothing to read once is a plain heading.
 */
export function PageHeading({ children, help }: { children: ReactNode; help?: ReactNode }) {
  const heading = <h1 className="min-w-0 text-2xl font-semibold">{children}</h1>
  if (!help) return heading
  return (
    <div className="flex items-center gap-3">
      {heading}
      <HelpSheet>{help}</HelpSheet>
    </div>
  )
}
