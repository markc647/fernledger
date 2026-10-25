import * as React from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui Field, trimmed to the parts the app uses (a field, its content, label and description), with a plain <label> for shadcn's Label, which
// is Radix's and does nothing a label element doesn't here.

function Field({ className, orientation = 'vertical', ...props }: React.ComponentProps<'div'> & { orientation?: 'vertical' | 'horizontal' }) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn('flex w-full gap-3', orientation === 'horizontal' ? 'flex-row items-center justify-between' : 'flex-col', className)}
      {...props}
    />
  )
}

function FieldContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field-content" className={cn('flex flex-1 flex-col gap-1', className)} {...props} />
}

function FieldLabel({ className, ...props }: React.ComponentProps<'label'>) {
  return <label data-slot="field-label" className={cn('w-fit font-medium', className)} {...props} />
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="field-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}

export { Field, FieldContent, FieldDescription, FieldLabel }
