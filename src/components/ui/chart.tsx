import * as React from 'react'
import { ResponsiveContainer, Tooltip } from 'recharts'
import { cn } from '@/lib/utils'

// shadcn/ui Charts (a container that gives a chart its colours and size, and a tooltip), written for Recharts 3 and for this app:
// - the colours go on the container as CSS variables (`--color-<key>`) set through the DOM, not in a <style> element, so a chart needs nothing from
//   the Content Security Policy beyond what the rest of the app already has;
// - text is sized in rem, so the A / A+ / A++ control scales an axis as it scales the page, and never below the 15px a table's text keeps;
// - nothing moves: a chart draws itself at once (each chart sets `isAnimationActive={false}`), which reduced-motion readers need and the accessibility
//   checks measure.
// A chart is a picture of numbers that are also written out: put it in a `ChartFigure`, which names it for a screen reader in a sentence, and write the
// figures beside it as a table. The picture itself is one image to assistive technology (Recharts' own keyboard layer is off), and takes no focus.

export type ChartConfig = Record<string, { label: string; /** Any CSS colour, normally a theme token such as `var(--chart-1)`. */ color: string }>

const ChartContext = React.createContext<ChartConfig | null>(null)

function useChart() {
  const config = React.useContext(ChartContext)
  if (!config) throw new Error('A chart part must be inside a ChartContainer')
  return config
}

function ChartContainer({ config, className, style, children, ...props }: Omit<React.ComponentProps<'div'>, 'children'> & { config: ChartConfig; children: React.ReactNode }) {
  const colours = Object.fromEntries(Object.entries(config).map(([key, { color }]) => [`--color-${key}`, color])) as React.CSSProperties
  return (
    <ChartContext.Provider value={config}>
      <div
        data-slot="chart"
        style={{ ...colours, ...style }}
        className={cn(
          'flex w-full justify-center text-[0.9375rem]',
          // Axis text: the muted colour that passes AA on the page and cards in both themes (scripts/theme-contrast.test.mjs).
          '[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground',
          '[&_.recharts-cartesian-grid_line]:stroke-border',
          '[&_.recharts-cartesian-axis-line]:stroke-border [&_.recharts-cartesian-axis-tick-line]:stroke-border',
          '[&_.recharts-surface]:outline-hidden',
          className,
        )}
        {...props}
      >
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

/** A chart as one image, with `label` saying what it shows (and where its figures are): what a screen reader announces instead of the chart's parts. */
function ChartFigure({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="img" aria-label={label} className={className}>
      {children}
    </div>
  )
}

const ChartTooltip = Tooltip

type TooltipItem = { dataKey?: string | number | ((...args: never[]) => unknown); name?: string | number; value?: unknown; color?: string }

/**
 * What a chart's tooltip says: the point's label, and a line for each series with its swatch, name and value. `labelFormatter` and
 * `valueFormatter` write them in the app's words (a date as "Thu 8 Oct 2026", an amount through `formatBalance`). The tooltip is for a pointer; the
 * same numbers are in the figures beside the chart.
 */
function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  className,
}: {
  active?: boolean
  payload?: readonly TooltipItem[]
  label?: React.ReactNode
  labelFormatter?: (label: unknown, payload: readonly TooltipItem[]) => React.ReactNode
  valueFormatter: (value: number) => string
  className?: string
}) {
  const config = useChart()
  if (!active || !payload?.length) return null
  return (
    <div className={cn('grid max-w-[min(20rem,90vw)] gap-1.5 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md', className)}>
      <div className="font-medium break-words">{labelFormatter ? labelFormatter(label, payload) : label}</div>
      {payload.map((item) => {
        const key = typeof item.dataKey === 'string' ? item.dataKey : String(item.name)
        return (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="size-3 shrink-0 rounded-xs border" style={{ backgroundColor: item.color }} />
              {config[key]?.label ?? item.name}
            </span>
            <span className="font-medium whitespace-nowrap tabular-nums">{valueFormatter(Number(item.value))}</span>
          </div>
        )
      })}
    </div>
  )
}

export { ChartContainer, ChartFigure, ChartTooltip, ChartTooltipContent }
