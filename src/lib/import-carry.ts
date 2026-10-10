// What the Admin is told about their Overrides (a Category they chose themselves) and Notes when imported history is
// replaced, in plain words. The Worker carries them over to the re-imported Transactions with the same bank number
// (worker/carry-over.ts). Kept apart from the screen so the wording can be tested without a browser.

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-NZ')} ${n === 1 ? one : many}`
const transactions = (n: number) => plural(n, 'Transaction', 'Transactions')

/** What the Worker forecasts for a replace with this file (POST /api/imports/carry-preview, added up over the file's chunks). */
export type CarryPreview = { waiting: number; carries: number; differing: number }

/**
 * Before the Admin confirms a replace: how many Transactions have an Override or a Note, how many of them carry over to this
 * file and how many won't (once the Worker has forecast it), and what can go wrong with the match. `withOwnWork` is the
 * Account's own, `waiting` what an earlier replace that did not finish is still holding, which this one carries over too.
 * The first paragraph is the one to set apart.
 */
export function describeCarryBefore({ withOwnWork, waiting, preview }: { withOwnWork: number; waiting: number; preview?: CarryPreview }): string[] {
  const total = preview?.waiting ?? withOwnWork + waiting
  if (total === 0) return []
  const one = total === 1
  const paragraphs: string[] = []
  const has = `${transactions(total)} ${one ? 'has' : 'have'} an Override (your own Category) or a Note.`
  if (preview) {
    const lose = total - preview.carries
    paragraphs.push(`${has} ${one ? (preview.carries ? 'It carries' : "It won't carry") + ' over to this file.' : `${preview.carries} of them carry over to this file; ${lose} won't.`}`)
  } else {
    paragraphs.push(`${has} ${one ? 'It is' : 'They are'} carried over to the Transaction with the same number from the bank in this file. Fernledger counts how many have no match once the Import has run.`)
  }
  if (waiting > 0) paragraphs.push(`${waiting === 1 ? 'One was' : `${waiting.toLocaleString('en-NZ')} were`} left by an earlier replace that did not finish.`)
  if (preview && preview.differing > 0) {
    paragraphs.push(`${preview.differing === 1 ? 'One' : preview.differing.toLocaleString('en-NZ')} of those would go to a Transaction with a different amount.`)
  }
  paragraphs.push(
    "Fernledger matches them by the bank's own number for each Transaction. ASB makes it from the date and a count for that day, so if the bank has numbered a day differently since the old export, an Override or Note can land on a different Transaction. After the Import, Fernledger says how many went to a Transaction with a different amount.",
  )
  return paragraphs
}

/** After an Import: what happened to the Overrides and Notes that had no Transaction to go to, or null when none were lost. */
export function describeLost(lost: number): string | null {
  if (lost === 0) return null
  const one = lost === 1
  return `${transactions(lost)} lost ${one ? 'its' : 'their'} Override or Note. The new file has no Transaction with the bank's own number for ${one ? 'it' : 'them'}, or ${one ? 'it is' : 'they are'} dated on or after the Cutover Date, or a Transaction from Sync now has that number. The Change Log lists ${one ? 'it' : 'them'}.`
}

/** After an Import: how many went to a Transaction with another amount than the one they were on, or null when none did. */
export function describeDiffering(differing: number): string | null {
  if (differing === 0) return null
  const one = differing === 1
  return `${transactions(differing)} now ${one ? 'has' : 'have'} an Override or Note that was on a Transaction with a different amount. The bank may have numbered that day differently, so check ${one ? 'it' : 'them'}.`
}

/** Overrides and Notes a replace that stopped is still holding: before another Import of the Account, and after one that finished. */
export function describeWaiting(waiting: number): string | null {
  if (waiting === 0) return null
  const one = waiting === 1
  return `${plural(waiting, 'Override or Note is', 'Overrides and Notes are')} waiting from a replace that stopped part way. An Import gives ${one ? 'it' : 'them'} to the Transaction with the same number from the bank. Replacing the imported history with the right file finishes the job, and what has no match is then lost. Or you can discard ${one ? 'it' : 'them'}.`
}
