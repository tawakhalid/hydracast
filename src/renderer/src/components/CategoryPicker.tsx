import { useEffect, useRef, useState } from 'react'
import type { CategoryOption } from '@shared/types'

interface Props {
  platformId: string
  platformName: string
  value: { id: string; name: string }
  onChange: (next: { id: string; name: string }) => void
}

/**
 * Searches one platform's category list.
 *
 * Bound to a single destination on purpose. Twitch and Kick both number their
 * games, but they are different numbers for the same game, so a category picked
 * once cannot be shared the way a title can - copying an id across would select
 * the wrong game rather than no game at all.
 */
export default function CategoryPicker({ platformId, platformName, value, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<CategoryOption[]>([])
  const [open, setOpen] = useState(false)
  const seq = useRef(0)

  // Debounced, and sequence-guarded so a slow reply cannot overwrite the
  // results of a later keystroke.
  useEffect(() => {
    const term = query.trim()
    if (!term) {
      setOptions([])
      return
    }
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.hydracast.searchCategories(platformId, term).then((found) => {
        if (mine === seq.current) setOptions(found)
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [query, platformId])

  return (
    <div className="category-picker">
      <button className="category-current" onClick={() => setOpen((v) => !v)}>
        {value.name || <span className="category-empty">No category set</span>}
      </button>

      {open && (
        <div className="category-pop">
          <input
            className="input"
            autoFocus
            placeholder={`Search ${platformName} categories…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="category-list">
            {options.map((option) => (
              <button
                key={option.id}
                className="category-item"
                onClick={() => {
                  onChange({ id: option.id, name: option.name })
                  setQuery('')
                  setOptions([])
                  setOpen(false)
                }}
              >
                {option.boxArtUrl ? (
                  <img src={option.boxArtUrl} alt="" />
                ) : (
                  <div className="category-art" />
                )}
                <span>{option.name}</span>
              </button>
            ))}
            {!options.length && (
              <div className="category-none">
                {query.trim() ? 'Nothing found' : 'Type to search'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
