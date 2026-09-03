import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { PanelState } from '@shared/types'
import { ChevronIcon, CloseIcon, GripIcon } from '../icons'

interface Props {
  panel: PanelState
  title: string
  /** Edit mode turns the title bar into a drag handle and shows the hide button. */
  editing: boolean
  /** True while this panel is the one being dragged. */
  dragging: boolean
  onToggleCollapse: () => void
  onDragStart: (e: ReactPointerEvent) => void
  onHide: () => void
  /** Panel-specific buttons, shown on the right of the title bar. */
  actions?: ReactNode
  /** Keeps the frame measurable for drag hit-testing. */
  frameRef?: (el: HTMLDivElement | null) => void
  children: ReactNode
}

/**
 * The shell every workspace panel sits in.
 *
 * It owns the title bar, the collapse chevron and - while edit mode is on - the
 * drag handle that moves the panel between columns and within one. The panel's
 * own component renders only its contents, so all panels behave the same way
 * regardless of what they contain.
 */
export default function PanelFrame({
  panel,
  title,
  editing,
  dragging,
  onToggleCollapse,
  onDragStart,
  onHide,
  actions,
  frameRef,
  children
}: Props) {
  return (
    <motion.div
      layout
      ref={frameRef}
      className={`panel panel-frame ${panel.collapsed ? 'collapsed' : ''} ${
        editing ? 'editing' : ''
      } ${dragging ? 'dragging' : ''}`}
      // A collapsed panel shrinks to its title bar; an expanded one takes its
      // share of the column.
      style={{ flex: panel.collapsed ? '0 0 auto' : `${panel.flex} 1 0` }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
    >
      <div
        className={`panel-head panel-frame-head ${editing ? 'draggable' : ''}`}
        // Dragging is deliberately confined to edit mode, so an ordinary click
        // on a title bar can never rearrange the workspace by accident.
        onPointerDown={editing ? onDragStart : undefined}
      >
        {editing && (
          <span className="panel-grip" title={`Drag to move ${title}`}>
            <GripIcon size={13} />
          </span>
        )}

        <button
          className="btn icon sm ghost"
          // Stop the press reaching the drag handle underneath.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleCollapse}
          title={panel.collapsed ? `Expand ${title}` : `Minimise ${title}`}
        >
          <motion.span
            animate={{ rotate: panel.collapsed ? -90 : 0 }}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <ChevronIcon size={14} />
          </motion.span>
        </button>

        <span className="panel-title">{title}</span>

        <div className="spacer" />

        {editing ? (
          <button
            className="btn icon sm ghost"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onHide}
            title={`Hide ${title}`}
          >
            <CloseIcon size={13} />
          </button>
        ) : (
          actions
        )}
      </div>

      <AnimatePresence initial={false}>
        {!panel.collapsed && (
          <motion.div
            className="panel-frame-body"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
