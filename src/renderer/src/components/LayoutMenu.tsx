import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { LayoutPreset } from '@shared/types'
import { CheckIcon, ChevronIcon, PlusIcon, TrashIcon } from '../icons'

interface Props {
  layouts: LayoutPreset[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

/**
 * Switches between saved layouts and manages them in place.
 *
 * The built-in layout is deliberately still selectable and adjustable - only
 * rename and delete are withheld - so there is always a layout to fall back to
 * without the controls appearing dead while it is active.
 */
export default function LayoutMenu({
  layouts,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete
}: Props) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const active = layouts.find((l) => l.id === activeId) ?? layouts[0]

  // Close when the click lands anywhere else.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditingId(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const commitNew = (): void => {
    const name = newName.trim()
    if (!name) return
    onCreate(name)
    setNewName('')
  }

  const commitRename = (): void => {
    if (editingId && editName.trim()) onRename(editingId, editName.trim())
    setEditingId(null)
  }

  return (
    <div className="layout-menu" ref={rootRef}>
      <button
        className={`btn sm ghost ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Switch or save a layout"
      >
        <span className="layout-name">{active?.name ?? 'Default'}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} style={{ display: 'grid' }}>
          <ChevronIcon size={12} />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="layout-pop"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="layout-pop-label">Layouts</div>

            {layouts.map((l) => (
              <div key={l.id} className={`layout-row ${l.id === activeId ? 'active' : ''}`}>
                {editingId === l.id ? (
                  <input
                    className="input sm"
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <>
                    <button className="layout-pick" onClick={() => onSelect(l.id)}>
                      <span className="layout-tick">
                        {l.id === activeId && <CheckIcon size={11} />}
                      </span>
                      {l.name}
                      {l.builtIn && <span className="layout-lock">built-in</span>}
                    </button>

                    {!l.builtIn && (
                      <>
                        <button
                          className="btn icon sm ghost"
                          title="Rename"
                          onClick={() => {
                            setEditingId(l.id)
                            setEditName(l.name)
                          }}
                        >
                          <span style={{ fontSize: 11, fontWeight: 700 }}>Aa</span>
                        </button>
                        <button
                          className="btn icon sm ghost"
                          title="Delete layout"
                          onClick={() => onDelete(l.id)}
                        >
                          <TrashIcon size={13} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}

            <div className="layout-new">
              <input
                className="input sm"
                placeholder="Save current as..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNew()
                }}
              />
              <button
                className="btn icon sm ghost"
                disabled={!newName.trim()}
                onClick={commitNew}
                title="Save the current layout under this name"
              >
                <PlusIcon size={14} />
              </button>
            </div>

            <div className="layout-hint">
              Text size, chat width and preview visibility are saved into the selected layout as
              you change them.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
