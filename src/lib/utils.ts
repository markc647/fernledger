import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** How an amount of money is set wherever it is shown: fixed-width digits that never wrap or kern, so a column of them lines up and a big one never splits. */
export const MONEY_TEXT = 'whitespace-nowrap tabular-nums [font-kerning:none]'

/** The padding of a Report's table cells on paper, tighter than on screen, where a page is 680px wide and a Report is many pages long. */
export const PAPER = 'print:px-2 print:py-2'
