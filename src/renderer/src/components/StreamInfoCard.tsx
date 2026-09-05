import { memo, useCallback, useEffect, useState } from 'react'
import type { Platform, StreamInfo } from '@shared/types'
import { AlertIcon, CheckIcon, RefreshIcon } from '../icons'
import CategoryPicker from './CategoryPicker'

interface Props {
  platform: Platform
  /** The last values Hydracast sent, used where the platform will not say. */
  fallback: StreamInfo | null
  /** Persists what was applied, so it survives a platform that reads back blank. */
  onApplied: (info: StreamInfo) => void
}

const EMPTY: StreamInfo = { title: '', categoryId: '', categoryName: '' }

/**
 * Sets the title and category shown to viewers, from inside Hydracast.
 *
 * The point of a multi-platform broadcast is not repeating yourself, and "what
 * am I streaming" is otherwise typed once per dashboard. It lives under the
 * automated header because it is only possible with a connected account: both
 * platforms gate the write behind a scope, and neither lets an anonymous
 * client near it.
 *
 * Current values are read from the platform rather than remembered locally,
 * since the streamer may well have changed them from the platform's own
 * dashboard since Hydracast last looked - showing a stale copy would invite
 * silently overwriting it.
 */
function StreamInfoCard({ platform, fallback, onApplied }: Props) {
  const [info, setInfo] = useState<StreamInfo>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Whether the platform told us what it is showing, or we are guessing. */
  const [readBack, setReadBack] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.hydracast.getStreamInfo(platform.id).then((current) => {
      if (cancelled) return
      // Kick's channels payload describes the current *livestream*, so it reads
      // back empty whenever the channel is offline even though the value was
      // stored - confirmed against a live token straight after an accepted
      // PATCH. Falling back to what was last sent beats showing a blank field
      // that looks like the setting was lost.
      setInfo({
        title: current?.title || fallback?.title || '',
        categoryId: current?.categoryId || fallback?.categoryId || '',
        categoryName: current?.categoryName || fallback?.categoryName || ''
      })
      setReadBack(!!current && (!!current.title || !!current.categoryId))
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
    // Re-reading on every fallback change would fight the user mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.id])

  const apply = useCallback(async () => {
    setBusy(true)
    setNote(null)
    const results = await window.hydracast.setStreamInfo([platform.id], info)
    const failed = results.filter((r) => !r.ok)
    setBusy(false)
    if (!failed.length) onApplied(info)
    setNote(
      failed.length === 0
        ? {
            ok: true,
            text: `Updated ${results.length} destination${results.length === 1 ? '' : 's'}`
          }
        : { ok: false, text: failed[0].detail ?? 'Update failed' }
    )
  }, [info, platform.id, onApplied])

  return (
    <div className="stream-info">
      <div className="field">
        <label>Stream title</label>
        <input
          className="input"
          placeholder={loaded ? 'What are you streaming?' : 'Loading…'}
          value={info.title}
          maxLength={140}
          onChange={(e) => setInfo({ ...info, title: e.target.value })}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>Category</label>
        <CategoryPicker
          platformId={platform.id}
          platformName={platform.name}
          value={{ id: info.categoryId, name: info.categoryName }}
          onChange={(next) => setInfo({ ...info, categoryId: next.id, categoryName: next.name })}
        />
      </div>

      {loaded && !readBack && (
        <div className="hint" style={{ marginTop: 10 }}>
          {platform.kind === 'kick'
            ? 'Kick only reports the title and category of a live stream, so this shows what Hydracast last sent rather than what Kick has stored.'
            : `${platform.name} did not report a current title or category.`}
        </div>
      )}

      <div className="stream-info-foot">
        {note && (
          <span className={`stream-info-note ${note.ok ? 'ok' : 'err'}`}>
            {note.ok ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
            {note.text}
          </span>
        )}
        <button className="btn primary sm" onClick={() => void apply()} disabled={busy || !loaded}>
          {busy ? <RefreshIcon size={13} /> : null}
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

export default memo(StreamInfoCard)
