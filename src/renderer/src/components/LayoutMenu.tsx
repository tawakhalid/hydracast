import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { LayoutPreset } from '@shared/types'
import { CheckIcon, ChevronIcon, PlusIcon, RefreshIcon, TrashIcon } from '../icons'

interface Props {
  layouts: LayoutPreset[]
  activeId: string
  /** True when there are edits not yet written into a saved layout. */
  dirty: boolean
  /** Active layout name, already marked with (*) when dirty. */
  label: string
  onSelect: (id: string) => void
  onSave: () => void
  onSaveAs: (name: string) => void
  onRevert: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

/**
 * Picks and manages layouts.
 *
 * Edits never write through to a saved layout - they collect as a draft marked
 * `(*)` until saved deliberately. The built-in layout is therefore always
 * exactly as it shipped, which is what makes selecting it a reliable way back.
 */
export default function LayoutMenu({
  layouts,
  activeId,
  dirty,
  label,
  onSelect,
  onSave,
  onSaveAs,
  onRevert,
  onRename,
  onDelete
}: Props) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const active = layouts.find((l) => l.id === activeId)

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

  const commitSaveAs = (): void => {
    const name = newName.trim()
    if (!name) return
    onSaveAs(name)
    setNewName('')
  }

  const commitRename = (): void => {
    if (editingId && editName.trim()) onRename(editingId, editName.trim())
    setEditingId(null)
  }

  return (
    <div className="layout-menu" ref={rootRef}>
      <button
        className={`btn sm ghost ${open ? 'active' : ''} ${dirty ? 'dirty' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={dirty ? 'Layout has unsaved changes' : 'Switch or save a layout'}
      >
        <span className="layout-name">{label}</span>
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
            {dirty && (
              <div className="layout-dirty">
                <div className="layout-dirty-text">
                  Unsaved changes to <strong>{active?.name}</strong>
                </div>
                <div className="layout-dirty-actions">
                  <button
                    className="btn sm"
                    disabled={!!active?.builtIn}
                    onClick={onSave}
                    title={
                      active?.builtIn
                        ? 'The built-in layout cannot be overwritten - save these changes as a new layout instead'
                        : `Save into ${active?.name}`
                    }
                  >
                    Save
                  </button>
                  <button className="btn sm ghost" onClick={onRevert} title="Discard the changes">
                    <RefreshIcon size={13} />
                    Revert
                  </button>
                </div>
              </div>
            )}

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
                      {l.id === activeId && dirty && <span className="layout-star">(*)</span>}
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
                  if (e.key === 'Enter') commitSaveAs()
                }}
              />
              <button
                className="btn icon sm ghost"
                disabled={!newName.trim()}
                onClick={commitSaveAs}
                title="Save the current arrangement under this name"
              >
                <PlusIcon size={14} />
              </button>
            </div>

            <div className="layout-hint">
              Selecting <strong>Default</strong> always restores the original arrangement - it is
              never overwritten.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
