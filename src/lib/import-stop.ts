// What the Admin is told when an Import stops part way, in plain words. Kept apart from run-import.ts so the wording
// can be tested without the network. "Parts" are the chunks of the file the Worker saved (worker/imports.ts).

export type Stop = {
  /** Parts of the file saved before the stop, out of `total`. */
  sent: number
  total: number
  /** Replacing imported history, and how many old rows were removed before the stop. */
  replacing: boolean
  removed: number
  /** The free plan's daily database allowance ran out (HTTP 429 from the Worker). */
  dailyLimit: boolean
}

/** Said when a replace stopped after removing history: the Admin's own Categories and Notes on it are held, not lost (worker/carry-over.ts). */
const KEPT = 'Any Override or Note you set on the removed Transactions is kept. It is carried over to the Transaction with the same number from the bank when the file is imported, and what has no match stays until you discard it.'

/** What happened and what to do, as separate sentences so the screen can set them apart. `kept` is set when history was removed. */
export function describeStop({ sent, total, replacing, removed, dailyLimit }: Stop): { headline: string; happened: string | null; kept: string | null; next: string } {
  const again = dailyLimit ? 'Choose the same file again tomorrow' : 'Choose the same file again'
  const headline = dailyLimit ? 'Daily limit reached. Try again tomorrow.' : `The Import stopped${total > 0 ? ` after ${sent} of ${total} parts were saved` : ''}.`
  const skipsSaved = 'rows already saved are recognised and skipped'

  if (!replacing) return { headline, happened: null, kept: null, next: `Nothing is lost. ${again} and import it: ${skipsSaved}.` }
  // The first part is saved in the same batch as the removal, so once any part is saved the old history is gone.
  if (sent > 0) {
    return {
      headline,
      happened: 'The old history has been removed and part of the new file is saved.',
      kept: KEPT,
      next: `${again} and import it: ${skipsSaved}. "Replace imported history" works too, but starts again from the beginning.`,
    }
  }
  if (removed > 0) {
    return {
      headline,
      happened: 'Part of the old history has been removed.',
      kept: KEPT,
      next: `${again} and use "Replace imported history" to remove the rest and import it. A plain Import would leave the rest of the old history in place.`,
    }
  }
  return { headline, happened: 'Nothing was removed.', kept: null, next: `${again} to try again.` }
}
