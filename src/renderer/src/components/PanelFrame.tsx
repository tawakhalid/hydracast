import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { PanelState } from '@shared/types'
import { ChevronIcon, CloseIcon } from '../icons'

interface Props {
  panel: PanelState
  title: string
  /** Edit mode shows the move/hide controls. */
  editing: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onToggleCollapse: () => void
  onMove: (delta: -1 | 1) => void
  onSwitchRegion: () => void
  onHide: () => void
  /** Panel-specific buttons, shown on the right of the title bar. */
  actions?: ReactNode
  children: ReactNode
}

/**
 * The shell every workspace panel sits in.
 *
 * It owns the title bar, the collapse chevron and - while edit mode is on - the
 * controls that move the panel between columns and up or down within one. The
 * panel's own component renders only its contents, so all panels behave the
 * same way regardless of what they contain.
 */
export default function PanelFrame({
  panel,
  title,
  editing,
  canMoveUp,
  canMoveDown,
  onToggleCollapse,
  onMove,
  onSwitchRegion,
  onHide,
  actions,
  children
}: Props) {
  return (
    <motion.div
      layout
      className={`panel panel-frame ${panel.collapsed ? 'collapsed' : ''} ${
        editing ? 'editing' : ''
      }`}
      // A collapsed panel shrinks to its title bar; an expanded one takes its
      // share of the column.
      style={{ flex: panel.collapsed ? '0 0 auto' : `${panel.flex} 1 0` }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
    >
      <div className="panel-head panel-frame-head">
        <button
          className="btn icon sm ghost"
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
          <div className="panel-edit-controls">
            <button
              className="btn icon sm ghost"
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
              title="Move up"
            >
              <span className="panel-arrow up">
                <ChevronIcon size={13} />
              </span>
            </button>
            <button
              className="btn icon sm ghost"
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
              title="Move down"
            >
              <ChevronIcon size={13} />
            </button>
            <button
              className="btn sm ghost"
              onClick={onSwitchRegion}
              title={panel.region === 'left' ? 'Send to the right column' : 'Send to the left column'}
            >
              {panel.region === 'left' ? 'To right' : 'To left'}
            </button>
            <button className="btn icon sm ghost" onClick={onHide} title={`Hide ${title}`}>
              <CloseIcon size={13} />
            </button>
          </div>
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
