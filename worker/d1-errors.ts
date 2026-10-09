// D1 on the Workers Free plan refuses writes once the day's 100,000 row writes are used (ADR 0004). D1 words that
// error in prose, not a code, and Cloudflare doesn't promise the wording, so this matches on keywords. An error it
// doesn't recognise still ends as the generic failure; the only cost of a miss is a less helpful message.
const DAILY_LIMIT = /(daily|24[- ]hour|quota).*(limit|exceed|reach)|(limit|exceed|reach).*(daily|24[- ]hour|quota)|rows? written.*(limit|exceed)|(limit|exceed).*rows? written/i

/** True when D1 refused a query because the free plan's daily allowance is used up. */
export const isDailyLimitError = (error: unknown): boolean => error instanceof Error && DAILY_LIMIT.test(error.message)
