import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Tone = 'success' | 'pending' | 'warning' | 'danger' | 'neutral'

// Each tone has its own icon shape as well as its colour, so the meaning survives colour blindness, a printout
// in black and white, and Windows high-contrast mode. Drawn inline so the app needs no icon library.
const ICONS: Record<Tone, ReactNode> = {
  success: <path d="M5 12.5l4.5 4.5L19 7.5" />, // tick
  pending: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ), // clock
  warning: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ), // triangle with a mark
  danger: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
    </>
  ), // cross in a circle
  neutral: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </>
  ), // "i" in a circle
}

const COLOURS: Record<Tone, string> = {
  success: 'text-success',
  pending: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-muted-foreground',
}

/**
 * A short status such as "Synced" or "Needs attention": an icon, the words, and a colour, never the colour alone.
 * Pass the words as children, written for the reader ("Needs attention", not "ERR_2").
 */
export function Status({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', COLOURS[tone], className)}>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[tone]}
      </svg>
      <span>{children}</span>
    </span>
  )
}
