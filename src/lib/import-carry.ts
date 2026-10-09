// What the Admin is told about their own Categories (Overrides) and Notes when imported history is replaced, in plain
// words. The Worker carries them over to the re-imported Transactions with the same bank unique ID (worker/carry-over.ts).
// Kept apart from the screen so the wording can be tested without a browser.

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-NZ')} ${n === 1 ? one : many}`

/**
 * Before the Admin confirms a replace: how many Transactions have a Category or Note of their own, that they are
 * carried over, and that how many have no match can be counted only once the file is imported. `waiting` is what an
 * earlier replace that did not finish is still holding, which this one carries over too.
 */
export function describeCarryBefore({ withOwnWork, waiting }: { withOwnWork: number; waiting: number }): string[] {
  const paragraphs: string[] = []
  if (withOwnWork > 0) {
    const one = withOwnWork === 1
    paragraphs.push(
      `${plural(withOwnWork, 'Transaction', 'Transactions')} ${one ? 'has' : 'have'} your own Category or a Note. ${one ? 'This is' : 'These are'} carried over to ${one ? 'the Transaction' : 'the Transactions'} that ${one ? 'comes' : 'come'} back in this file with the same unique ID from your bank. Fernledger can only count how many have no match after the Import: the finished screen and the Change Log then say how many were lost.`,
    )
  }
  if (waiting > 0) {
    paragraphs.push(`${plural(waiting, 'Category or Note is', 'Categories and Notes are')} still waiting from an earlier replace that did not finish. ${waiting === 1 ? 'It is' : 'They are'} carried over the same way.`)
  }
  return paragraphs
}

/** After an Import: what happened to the Categories and Notes that had no Transaction to go to, or null when none were lost. */
export function describeLost(lost: number): string | null {
  if (lost === 0) return null
  const one = lost === 1
  return `${plural(lost, 'Transaction', 'Transactions')} had your own Category or a Note, but no Transaction in this file has ${one ? 'its' : 'their'} unique ID from your bank (or ${one ? 'it is' : 'they are'} dated on or after the Cutover Date), so ${one ? 'it is' : 'they are'} lost. The Change Log records the count.`
}
