// What to suggest for a Rule's "Text contains" when the Admin makes a Rule from a Transaction (Create Rule, in the Edit panel).
//
// A bank's description is the merchant wrapped in things that change from one visit to the next: how the payment was made (EFTPOS, POS W/D, VISA PURCHASE), the card number, the
// date and time, a receipt or reference number, a branch code, a place. A Rule that looks for all of that matches the one Transaction it was made from. The suggestion is the
// merchant's words alone, so the Rule matches the next visit too.
//
// The suggestion is always a stretch of the description exactly as it is written, spaces and all (a Rule finds its text by looking for it in the description, ignoring capital letters
// A to Z), so the Rule it makes matches the Transaction it was made from. Nothing is joined up from words that were apart. It is never empty for a description that is not blank: when
// nothing is left once the rest is taken away, it is the whole description.

/** The most a Rule's text can be (worker/rule-criteria.ts: `textContains`). */
const MAX_LENGTH = 100
/** Shorter than this is too little to look for: "Z" matches a Z in anything. */
const MIN_LENGTH = 3
/** A place is taken off the end only when this much of the merchant is left. */
const MIN_BEFORE_PLACE = 4

// How a payment was made, as a bank begins a description with it. Longest first, so "POS W/D" is taken before "POS".
const PREFIXES = [
  'DEBIT CARD PURCHASE',
  'EFTPOS PURCHASE',
  'CARD PURCHASE',
  'VISA PURCHASE',
  'VISA DEBIT',
  'ONLINE PURCHASE',
  'ONLINE PAYMENT',
  'AUTOMATIC PAYMENT',
  'AUTO PAYMENT',
  'DIRECT DEBIT',
  'DIRECT CREDIT',
  'DEBIT CARD',
  'POS W/D',
  'EFTPOS',
  'PAYWAVE',
  'CONTACTLESS',
  'PURCHASE',
  'VISA',
  'DEBIT',
  'CARD',
  'POS',
]
  .map((phrase) => phrase.split(' '))
  .toSorted((a, b) => b.length - a.length)

// Places at the end of a description: the cities and suburbs a payment is made in, and the country. Left out are the places that are also surnames, because a payee's name
// ends in one (MARY NELSON is not MARY at Nelson): Hamilton, Nelson, Hastings, Henderson, Napier, Levin, Parnell.
const PLACES = [
  'AUCKLAND',
  'AKL',
  'WELLINGTON',
  'WGTN',
  'CHRISTCHURCH',
  'CHCH',
  'TAURANGA',
  'DUNEDIN',
  'PALMERSTON NORTH',
  'ROTORUA',
  'NEW PLYMOUTH',
  'WHANGAREI',
  'INVERCARGILL',
  'WHANGANUI',
  'GISBORNE',
  'QUEENSTOWN',
  'TIMARU',
  'BLENHEIM',
  'MASTERTON',
  'TAUPO',
  'PUKEKOHE',
  'PAPAKURA',
  'MANUKAU',
  'ALBANY',
  'TAKAPUNA',
  'NEWMARKET',
  'PONSONBY',
  'BOTANY',
  'MANUREWA',
  'ONEHUNGA',
  'NEW LYNN',
  'GLENFIELD',
  'LOWER HUTT',
  'UPPER HUTT',
  'PORIRUA',
  'PETONE',
  'PARAPARAUMU',
  'JOHNSONVILLE',
  'NEW ZEALAND',
  'NZL',
  'NZ',
]
  .map((phrase) => phrase.split(' '))
  .toSorted((a, b) => b.length - a.length)

// Words that name a number which follows them (REF 887766, CARD 1234).
const LABELS = new Set(['REF', 'REFERENCE', 'REC', 'RECEIPT', 'TXN', 'TRANS', 'AUTH', 'TERM', 'TERMINAL', 'INV', 'INVOICE', 'NO', 'NUMBER', 'CARD'])

const MONTH = '(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)'
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:AM|PM)?$/i
// 12/10, 12/10/26, 12-10-2026, 2026-10-12, 12OCT, 12OCT26. A pair with a hyphen, such as the shop 7-11, is not a date; it takes three parts.
const DATE = new RegExp(`^(?:\\d{1,2}/\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}|\\d{1,2}${MONTH}(?:\\d{2}|\\d{4})?)$`, 'i')
const MONTH_NAME = new RegExp(`^${MONTH}$`, 'i')
const CURRENCY = /^\$\d[\d,]*(?:\.\d+)?$/
const MASK = /^[X*]{4,}$/i

type Token = { start: number; end: number; core: string }

// A token without the punctuation round its edges. Its start and end are where it is in the description.
const EDGES = /^[^\p{L}\p{N}$]+|[^\p{L}\p{N}]+$/gu
const tokensOf = (description: string): Token[] => [...description.matchAll(/\S+/g)].map((match) => ({ start: match.index, end: match.index + match[0].length, core: match[0].replace(EDGES, '') }))

const digitsIn = (text: string) => text.match(/\d/g)?.length ?? 0
const isNumber = ({ core }: Token) => core === '' || TIME.test(core) || DATE.test(core) || CURRENCY.test(core) || MASK.test(core) || digitsIn(core) >= 4

/** Which tokens are not the merchant: dates, times, long numbers (a card, a receipt, a branch), and the word that labels one. */
function noiseIn(tokens: Token[], from: number): boolean[] {
  const noise = tokens.map((token, i) => i < from || isNumber(token))
  tokens.forEach((token, i) => {
    if (i < from) return
    const next = tokens[i + 1]
    // 12 OCT, 12 OCT 2026
    if (next && /^\d{1,2}$/.test(token.core) && MONTH_NAME.test(next.core)) {
      noise[i] = noise[i + 1] = true
      if (tokens[i + 2] && /^(?:\d{2}|\d{4})$/.test(tokens[i + 2]!.core)) noise[i + 2] = true
    }
    // REF 887766, CARD 1234, TERM 5
    if (next && LABELS.has(token.core.toUpperCase()) && digitsIn(next.core) > 0) noise[i] = noise[i + 1] = true
  })
  return noise
}

/** How many tokens at the start say how the payment was made. */
function prefixLength(tokens: Token[]): number {
  let at = 0
  for (let found = true; found; ) {
    const rest = tokens.slice(at).map((token) => token.core.toUpperCase())
    const prefix = PREFIXES.find((phrase) => phrase.every((word, i) => rest[i] === word))
    found = prefix !== undefined
    if (prefix) at += prefix.length
  }
  return at
}

// The words of the description from the first token to the last, as written. It ends on a letter or digit.
const span = (description: string, run: Token[]) => description.slice(run[0]!.start, run.at(-1)!.end).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/** Takes a place, and then another, off the end of the run, while enough of the merchant is left. */
function withoutPlaces(description: string, run: Token[]): Token[] {
  for (;;) {
    const words = run.map((token) => token.core.toUpperCase())
    const place = PLACES.find((phrase) => run.length > phrase.length && phrase.every((word, i) => words[words.length - phrase.length + i] === word))
    if (!place) return run
    const shorter = run.slice(0, run.length - place.length)
    if (span(description, shorter).length < MIN_BEFORE_PLACE) return run
    run = shorter
  }
}

/** At most MAX_LENGTH characters, cut after a whole word unless the first word is longer than that. */
function capped(text: string): string {
  if (text.length <= MAX_LENGTH) return text
  const head = text.slice(0, MAX_LENGTH)
  if (/\s/.test(text[MAX_LENGTH]!)) return head.trimEnd()
  const space = head.search(/\s\S*$/)
  return space > 0 ? head.slice(0, space).trimEnd() : head
}

/**
 * What a Rule made from a Transaction with this description should look for: the merchant's words. Takes off how the payment was made, dates and times, card, receipt and branch
 * numbers, and a place at the end (a short list of NZ cities and suburbs); keeps the first stretch of what is left that is long enough to be a merchant. A stretch of the
 * description as it is written, never empty unless the description is blank.
 */
export function suggestRuleText(description: string): string {
  const tokens = tokensOf(description)
  const whole = capped(description.trim())
  const noise = noiseIn(tokens, prefixLength(tokens))

  const runs: Token[][] = []
  tokens.forEach((token, i) => {
    if (noise[i]) return
    if (i > 0 && !noise[i - 1]) runs.at(-1)!.push(token)
    else runs.push([token])
  })
  if (runs.length === 0) return whole

  const lengthOf = (run: Token[]) => span(description, run).length
  const run = runs.find((candidate) => lengthOf(candidate) >= MIN_BEFORE_PLACE) ?? runs.toSorted((a, b) => lengthOf(b) - lengthOf(a))[0]!
  const suggested = capped(span(description, withoutPlaces(description, run)))
  return suggested.length >= MIN_LENGTH ? suggested : whole
}
