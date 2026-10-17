import { CircleQuestionMark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** A hint comes with the id of its hidden copy (the box needs both), or there is none. */
type Hint = { hint: string; hintId: string; about?: string } | { hint?: undefined; hintId?: undefined; about?: undefined }

/**
 * A form field's label, and its hint when it has one: a "?" beside the label, above the box, that opens the hint in a popover, so that a form with a hint for several boxes is not pushed
 * down the page by them (CODING_STANDARDS.md, UI). The hint is still the box's accessible description: it is also in the page, visually hidden, with the id `hintId`, which the box names in
 * its `aria-describedby` (with the id of its error, if it has one), so a screen reader reads it with the box whether or not the popover was ever opened.
 *
 * `about` is what the "?" is called, "About …", and what its popover is called (default the label, for a hint about a box alone; a hint about two boxes says both). The "?" is a 44px circle,
 * as the "?" of a page's help is, and the row is 3rem tall (the 44px, and two lines of the label's own words: they wrap when the room is short, which a "?" on a line of its own would cost
 * another 44px for). A box beside one with no hint has a `FieldLabel` with no `hint`, so that their rows are the same height and the boxes are level. The popover is the Note's: Escape and a press outside
 * close it, and Escape puts focus back on the "?"; focus goes to the words when it opens, so a hint too long for a short screen can be scrolled with the keyboard.
 */
export function FieldLabel({ htmlFor, label, hint, hintId, about = label }: { htmlFor: string; label: string } & Hint) {
  return (
    <div className="flex min-h-12 items-center gap-x-2">
      <label htmlFor={htmlFor} className="min-w-0 font-medium">
        {label}
      </label>
      {hint && (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="touch" className="rounded-full px-0" aria-label={`About ${about}`}>
                <CircleQuestionMark className="size-5" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              collisionPadding={8}
              aria-label={`About ${about}`}
              className="max-h-(--radix-popover-content-available-height) w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain"
            >
              <p tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {hint}
              </p>
            </PopoverContent>
          </Popover>
          <p id={hintId} className="sr-only">
            {hint}
          </p>
        </>
      )}
    </div>
  )
}
