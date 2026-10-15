import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type Modifier } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { GripVertical } from 'lucide-react'
import { createContext, useContext, useId, useRef, type ReactNode } from 'react'
import type { RowProps } from '@/components/responsive-table'
import { Button } from '@/components/ui/button'
import { TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

// Rows the reader can drag into a new order, as shadcn's dashboard data table does it: a grip at the start of each row (`DragHandle`) and `useSortable` on the row (`SortableRow`), inside
// a `DndContext` and `SortableContext` (`SortableFrame`). `ResponsiveTable` knows nothing of dragging: a page gives it `SortableRow` as its `RowElement` and a column with `handle`, and wraps it in
// the frame, so only a page that has draggable rows loads dnd-kit. The grip is the one way in with a pointer, a finger or the keyboard (Space or Enter, the arrow keys, Space or Enter
// again); the page offers Move up and Move down besides, which WCAG 2.5.7 asks of a drag.

/** A row can only move up and down. (dnd-kit's own `restrictToVerticalAxis` is in another package, @dnd-kit/modifiers, for these three lines.) */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

type Frame = { disabled: boolean; roleDescription: string }
const FrameContext = createContext<Frame>({ disabled: false, roleDescription: 'movable' })

/** What the grip of a row needs of the row's own `useSortable`. */
type Grip = Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners' | 'setActivatorNodeRef' | 'isDragging'>
const GripContext = createContext<Grip | null>(null)

/**
 * Makes the rows inside it draggable. `ids` are the rows' keys in the order they are shown; `onReorder` is told which row was dropped on which (the page works out the new order and saves
 * it). `disabled` stops a new drag, such as while the last order is being saved. `announcements`, `instructions` and `roleDescription` (what a handle is called, "movable Rule", in place of
 * dnd-kit's "sortable") are what a screen reader is told (src/lib/rules.ts). This is the only file that imports dnd-kit, so a page keeps its ids and its drop in its own plain types.
 */
export function SortableFrame({
  ids,
  onReorder,
  disabled = false,
  announcements,
  instructions,
  roleDescription,
  children,
}: {
  ids: number[]
  onReorder: (id: number, overId: number) => void
  disabled?: boolean
  announcements: Announcements
  instructions: string
  roleDescription: string
  children: ReactNode
}) {
  // A pointer (mouse, pen or finger) moves a short way before it is a drag, so a press that wanders a little is not one. The grip has `touch-action: none`, so a finger that starts on it drags
  // instead of scrolling the page, and a finger anywhere else scrolls as it always did.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  // The row that is picked up is "over" its own place at once, and dnd-kit says so in the same moment it says it was picked up, which replaces those words in the live region before a screen reader
  // reads them. The first "over" is left out, so that what the reader hears first is that the row was picked up.
  const justPickedUp = useRef(false)
  const instance = useId()
  const spoken: Announcements = {
    ...announcements,
    onDragStart: (event) => {
      justPickedUp.current = true
      return announcements.onDragStart?.(event)
    },
    onDragOver: (event) => {
      const first = justPickedUp.current && event.over?.id === event.active.id
      justPickedUp.current = false
      return first ? undefined : announcements.onDragOver?.(event)
    },
  }
  return (
    <DndContext
      id={instance}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      accessibility={{ announcements: spoken, screenReaderInstructions: { draggable: instructions } }}
      onDragEnd={({ active, over }) => {
        if (over && over.id !== active.id) onReorder(Number(active.id), Number(over.id))
      }}
    >
      <FrameContext.Provider value={{ disabled, roleDescription }}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </FrameContext.Provider>
    </DndContext>
  )
}

/** A row (a `tr`, or a card's `li`) that can be dragged by its `DragHandle`. It is the `RowElement` of a `ResponsiveTable`. */
export function SortableRow({ rowKey, layout, className, children }: RowProps) {
  const { disabled, roleDescription } = useContext(FrameContext)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: rowKey, disabled, attributes: { roleDescription } })
  const props = {
    ref: setNodeRef,
    // A row only moves up and down (the modifier above), so this is all of its transform.
    style: { transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition },
    'data-dragging': isDragging,
    // The row being dragged is drawn over the others, filled so that what it passes over does not show through its text, and a little faded. Windows high contrast removes the fill and the
    // fade, so it is outlined there (src/index.css).
    className: cn(className, 'relative z-0 data-[dragging=true]:z-10 data-[dragging=true]:bg-muted data-[dragging=true]:opacity-90 data-[dragging=true]:shadow-md'),
  }
  return (
    <GripContext.Provider value={{ attributes, listeners, setActivatorNodeRef, isDragging }}>
      {layout === 'table' ? <TableRow {...props}>{children}</TableRow> : <li {...props}>{children}</li>}
    </GripContext.Provider>
  )
}

/** The grip of a `SortableRow`. `label` names the row it moves, such as "Drag to reorder Rule 3". */
export function DragHandle({ label, id }: { label: string; id?: string }) {
  const grip = useContext(GripContext)
  if (!grip) return null
  return (
    <Button
      {...grip.attributes}
      {...grip.listeners}
      ref={grip.setActivatorNodeRef}
      id={id}
      type="button"
      variant="ghost"
      size="touch"
      aria-label={label}
      // 44px square for a finger as well as the mouse (the README's smallest target), and no touch-action, so a finger that starts on the grip drags and does not scroll the page.
      className={cn('touch-none px-0 text-muted-foreground', grip.isDragging ? 'cursor-grabbing' : 'cursor-grab')}
    >
      <GripVertical />
    </Button>
  )
}
