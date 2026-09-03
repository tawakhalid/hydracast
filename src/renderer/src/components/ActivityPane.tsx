import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { ActivityEvent, ActivityKind, Platform } from '@shared/types'
import { supportsChat } from '@shared/types'
import { BellIcon, PlatformIcon, PLATFORM_COLORS, TrashIcon } from '../icons'

interface Props {
  events: ActivityEvent[]
  platforms: Platform[]
  fontSize: number
  onClear: () => void
}

/** Short label shown on the pill beside each event. */
const KIND_LABEL: Record<ActivityKind, string> = {
  follow: 'follow',
  subscription: 'sub',
  gift: 'gift',
  raid: 'raid',
  cheer: 'cheer',
  donation: 'tip',
  announcement: 'notice',
  other: 'event'
}

const FILTERS: { id: 'all' | ActivityKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'subscription', label: 'Subs' },
  { id: 'gift', label: 'Gifts' },
  { id: 'cheer', label: 'Cheers' },
  { id: 'donation', label: 'Tips' },
  { id: 'raid', label: 'Raids' },
  { id: 'follow', label: 'Follows' }
]

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Merged audience-event feed. Only sources that need no account login feed it:
 * Twitch subs, gifts, raids and cheers, YouTube super chats and memberships,
 * and whatever Kick's socket turns out to carry.
 */
export default function ActivityPane({ events, platforms, fontSize, onClear }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<'all' | ActivityKind>('all')
  const [pinned, setPinned] = useState(true)

  const chatPlatforms = useMemo(() => platforms.filter((p) => supportsChat(p.kind)), [platforms])

  const visible = useMemo(
    () =>
      events
        .filter((e) => filter === 'all' || e.kind === filter)
        .sort((a, b) => a.timestamp - b.timestamp),
    [events, filter]
  )

  useEffect(() => {
    if (!pinned || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible.length, pinned])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  return (
    <div className="chat" style={{ ['--chat-fs' as string]: `${fontSize}px` }}>
      <div className="chat-filters">
        <span className="pill" style={{ height: 22, fontSize: 11 }}>
          {visible.length}
        </span>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`chip ${filter === f.id ? 'on' : ''}`}
            style={{ ['--pc' as string]: 'var(--accent)' }}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}

        <div className="spacer" />
        <button className="btn icon sm ghost" onClick={onClear} title="Clear the activity feed">
          <TrashIcon size={14} />
        </button>
      </div>

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        <AnimatePresence initial={false}>
          {visible.map((e) => (
            <motion.div
              key={e.id}
              className="msg activity-row"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              layout="position"
            >
              <span className="msg-time">{fmtTime(e.timestamp)}</span>
              <div className="msg-body">
                <span
                  className="msg-plat"
                  style={{ ['--pc' as string]: PLATFORM_COLORS[e.platformKind] }}
                >
                  <PlatformIcon kind={e.platformKind} size={Math.round(fontSize * 0.74)} />
                </span>
                <span className={`activity-pill ${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                <span
                  className="msg-author"
                  style={{ color: PLATFORM_COLORS[e.platformKind] }}
                >
                  {e.actor}
                </span>
                <span className="msg-text">{e.detail}</span>
                {e.amountLabel && <span className="activity-amount">{e.amountLabel}</span>}
                {e.message && <div className="activity-note">{e.message}</div>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {visible.length === 0 && (
          <div className="chat-empty">
            <BellIcon size={26} />
            {chatPlatforms.length === 0 ? (
              <div>Add a Twitch, YouTube or Kick destination to track activity.</div>
            ) : (
              <div>
                No activity yet.
                <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5, maxWidth: 340 }}>
                  Subs, gifts, raids and cheers on Twitch, plus Super Chats and memberships on
                  YouTube, appear here without any login. Follows need an account connection
                  Hydracast does not ask for, so they are not tracked.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
