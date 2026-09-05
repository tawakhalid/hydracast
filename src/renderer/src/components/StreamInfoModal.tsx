import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import type {
  AuthStatus,
  Platform,
  StreamInfo,
  StreamInfoPlan,
  StreamInfoResult
} from '@shared/types'
import { titleFor } from '@shared/types'
import { AlertIcon, CheckIcon, CloseIcon, PlatformIcon, PLATFORM_COLORS } from '../icons'
import CategoryPicker from './CategoryPicker'

interface Props {
  /** Destinations with a connected account; the only ones that can be set. */
  targets: Platform[]
  auth: Record<string, AuthStatus>
  plan: StreamInfoPlan
  onChange: (next: StreamInfoPlan) => void
  onClose: () => void
}

/**
 * One place to set what every connected destination is showing.
 *
 * The automation is optional and additive rather than a replacement: a shared
 * title is pushed to every destination that has not been given one of its own,
 * and any destination can opt out at any time by typing its own title. Nothing
 * here removes the per-destination editor in Settings.
 *
 * Categories stay per destination even here, because the platforms do not share
 * game ids - one shared category field would quietly set the wrong game
 * somewhere, which is worse than asking for two clicks.
 */
export default function StreamInfoModal({ targets, auth, plan, onChange, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, StreamInfoResult>>({})
  /** What each destination shows right now, read on open. */
  const [current, setCurrent] = useState<Record<string, StreamInfo>>({})

  // What each destination currently shows, so the modal opens on the truth
  // rather than on whatever was last typed here.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      targets.map(async (p) => [p.id, await window.hydracast.getStreamInfo(p.id)] as const)
    ).then((pairs) => {
      if (cancelled) return
      // Kept separate from the plan rather than written into it. What a
      // destination shows now is a fact to display, not an edit the user made -
      // folding it into the plan would turn "leave this alone" into "re-send
      // exactly what is already there" and make every field look dirty.
      const seen: Record<string, StreamInfo> = {}
      const categories = { ...plan.categories }
      let touched = false
      for (const [id, info] of pairs) {
        if (!info) continue
        seen[id] = info
        // Only seed a category the plan has never held, so reopening the modal
        // never discards a choice made a moment ago.
        if (info.categoryId && !categories[id]) {
          categories[id] = { id: info.categoryId, name: info.categoryName }
          touched = true
        }
      }
      setCurrent(seen)
      if (touched) onChange({ ...plan, categories })
    })
    return () => {
      cancelled = true
    }
    // Runs once per open: re-reading on every plan edit would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setOverride = useCallback(
    (platformId: string, value: string) => {
      const overrides = { ...plan.overrides }
      if (value.trim()) overrides[platformId] = value
      else delete overrides[platformId]
      onChange({ ...plan, overrides })
    },
    [plan, onChange]
  )

  const applyAll = useCallback(async () => {
    setBusy(true)
    setResults({})
    // Sent one at a time rather than as a batch: each destination needs its own
    // category, and a shared payload could not carry two different ones.
    const outcomes = await Promise.all(
      targets.map(async (platform) => {
        const category = plan.categories[platform.id] ?? { id: '', name: '' }
        const [result] = await window.hydracast.setStreamInfo([platform.id], {
          title: titleFor(plan, platform.id),
          categoryId: category.id,
          categoryName: category.name
        })
        return [platform.id, result] as const
      })
    )
    setResults(Object.fromEntries(outcomes))
    setBusy(false)
  }, [targets, plan])

  const failures = Object.values(results).filter((r) => r && !r.ok).length
  const applied = Object.keys(results).length

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <motion.div
        className="modal stream-plan"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      >
        <div className="modal-head">
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>Titles &amp; categories</h2>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
              Set once, push to every connected destination
            </div>
          </div>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <CloseIcon size={15} />
          </button>
        </div>

        {targets.length === 0 ? (
          <div className="stream-plan-empty">
            No connected destinations yet. Connect an account under Destinations and it will appear
            here.
          </div>
        ) : (
          <>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={plan.enabled}
                onChange={(e) => onChange({ ...plan, enabled: e.target.checked })}
              />
              <span>
                Use one shared title
                <span className="hint" style={{ margin: '2px 0 0' }}>
                  Off means every destination keeps its own title below.
                </span>
              </span>
            </label>

            {plan.enabled && (
              <div className="field" style={{ marginTop: 10 }}>
                <label>Shared title</label>
                <input
                  className="input"
                  placeholder="What are you streaming?"
                  value={plan.title}
                  maxLength={140}
                  onChange={(e) => onChange({ ...plan, title: e.target.value })}
                />
              </div>
            )}

            <div className="section-label">Per destination</div>

            <div className="stream-plan-list">
              {targets.map((platform) => {
                const override = plan.overrides[platform.id] ?? ''
                const result = results[platform.id]
                const effective = titleFor(plan, platform.id)
                return (
                  <div
                    key={platform.id}
                    className="stream-plan-row"
                    style={{ ['--pc' as string]: PLATFORM_COLORS[platform.kind] }}
                  >
                    <div className="stream-plan-who">
                      <div className="pcard-icon" style={{ width: 30, height: 30 }}>
                        <PlatformIcon kind={platform.kind} size={16} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="stream-plan-name">{platform.name}</div>
                        <div className="stream-plan-login">
                          @{auth[platform.id]?.account?.login ?? '—'}
                        </div>
                      </div>
                      {result && (
                        <span className={`stream-info-note ${result.ok ? 'ok' : 'err'}`}>
                          {result.ok ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
                          {result.ok ? 'Updated' : (result.detail ?? 'Failed')}
                        </span>
                      )}
                    </div>

                    <div className="stream-plan-fields">
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label>{plan.enabled ? 'Title override' : 'Title'}</label>
                        <input
                          className="input"
                          placeholder={
                            plan.enabled
                              ? plan.title || 'Using the shared title'
                              : (current[platform.id]?.title ?? 'Set a title')
                          }
                          value={override}
                          maxLength={140}
                          onChange={(e) => setOverride(platform.id, e.target.value)}
                        />
                        {plan.enabled && !override ? (
                          <div className="hint" style={{ marginTop: 5 }}>
                            Using the shared title. Type here to override it for {platform.name}.
                          </div>
                        ) : (
                          <div className="hint" style={{ marginTop: 5 }}>
                            {!current[platform.id]
                              ? 'Reading the current title…'
                              : current[platform.id].title
                                ? `Currently: ${current[platform.id].title}`
                                : platform.kind === 'kick'
                                  ? 'Kick only reports this for a live stream, so it reads blank while you are offline even when a title is set.'
                                  : 'No title set.'}
                          </div>
                        )}
                      </div>

                      <div className="field" style={{ marginBottom: 0 }}>
                        <label>Category</label>
                        <CategoryPicker
                          platformId={platform.id}
                          platformName={platform.name}
                          value={
                            plan.categories[platform.id] ??
                            (current[platform.id]?.categoryId
                              ? {
                                  id: current[platform.id].categoryId,
                                  name: current[platform.id].categoryName
                                }
                              : { id: '', name: '' })
                          }
                          onChange={(next) =>
                            onChange({
                              ...plan,
                              categories: { ...plan.categories, [platform.id]: next }
                            })
                          }
                        />
                      </div>
                    </div>

                    {!effective && (
                      <div className="stream-plan-warn">
                        No title for {platform.name} &mdash; it will keep whatever it shows now.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        <div className="modal-foot">
          <div className="hint" style={{ flex: 1, margin: 0 }}>
            {applied === 0
              ? 'Nothing is sent until you apply.'
              : failures === 0
                ? `Applied to ${applied} destination${applied === 1 ? '' : 's'}.`
                : `${failures} of ${applied} could not be updated.`}
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={() => void applyAll()}
            disabled={busy || targets.length === 0}
          >
            {busy ? 'Applying…' : 'Apply to all'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
