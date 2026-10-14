import * as React from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'

// shadcn/ui Collapsible, as `npx shadcn@latest add collapsible` writes it, importing `@radix-ui/react-collapsible` rather than the whole `radix-ui` package
// (CODING_STANDARDS.md: the smallest entry point).

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
