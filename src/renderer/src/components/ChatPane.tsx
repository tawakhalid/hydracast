import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { ChatMessage, ChatStatus, Platform } from '@shared/types'
import { supportsChat } from '@shared/types'
import { ChatIcon, PlatformIcon, PLATFORM_COLORS, RefreshIcon, TrashIcon } from '../icons'

interface Props {
  messages: ChatMessage[]
  platforms: Platform[]
  chatStatus: Record<string, ChatStatus>
  onClear: () => void
  onReconnect: (platformId: string) => void
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`
}

/** Merged, timestamped audience feed across every connected platform. */
export default function ChatPane({
  messages,
  platforms,
  chatStatus,
  onClear,
  onReconnect
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const [muted, setMuted] = useState<Set<string>>(new Set())
  const [pinned, setPinned] = useState(true)

  const chatPlatforms = useMemo(() => platforms.filter((p) => supportsChat(p.kind)), [platforms])

  const visible = useMemo(
    () =>
      messages
        .filter((m) => !muted.has(m.platformId))
        .sort((a, b) => a.timestamp - b.timestamp),
    [messages, muted]
  )

  // Stay pinned to the newest message unless the user scrolls up to read back.
  useEffect(() => {
    if (!pinned || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible.length, pinned])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  const toggleMute = (id: string): void => {
    setMuted((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const connectedCount = Object.values(chatStatus).filter((s) => s.state === 'connected').length

  return (
    <div className="panel chat" style={{ position: 'relative' }}>
      <div className="panel-head">
        <ChatIcon size={16} />
        <span className="panel-title">Audience Chat</span>
        <div className="spacer" />
        <span className="pill" style={{ height: 22, fontSize: 11 }}>
          {visible.length}
        </span>
        <button className="btn icon sm ghost" onClick={onClear} title="Clear chat history">
          <TrashIcon size={14} />
        </button>
      </div>

      <div className="chat-filters">
        {chatPlatforms.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: '4px 2px' }}>
            Add a Twitch, YouTube or Kick destination to read chat.
          </span>
        )}
        {chatPlatforms.map((p) => {
          const state = chatStatus[p.id]?.state ?? 'disconnected'
          const on = !muted.has(p.id)
          return (
            <button
              key={p.id}
              className={`chip ${on ? 'on' : ''}`}
              style={{ ['--pc' as string]: PLATFORM_COLORS[p.kind] }}
              onClick={() => toggleMute(p.id)}
              onDoubleClick={() => onReconnect(p.id)}
              title={
                chatStatus[p.id]?.detail
                  ? `${state} - ${chatStatus[p.id]?.detail}`
                  : `${state} (double-click to reconnect)`
              }
            >
              <span
                className={`dot ${
                  state === 'connected' ? 'ok' : state === 'error' ? 'err' : state === 'connecting' ? 'warn' : ''
                }`}
              />
              <PlatformIcon kind={p.kind} size={12} />
              {p.name}
            </button>
          )
        })}
      </div>

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        <AnimatePresence initial={false}>
          {visible.map((m) => (
            <motion.div
              key={m.id}
              className="msg"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              layout="position"
            >
              <span className="msg-time">{fmtTime(m.timestamp)}</span>
              <div className="msg-body">
                <span className="msg-plat" style={{ ['--pc' as string]: PLATFORM_COLORS[m.platformKind] }}>
                  <PlatformIcon kind={m.platformKind} size={10} />
                </span>
                {m.isOwner && <span className="msg-badge owner">host</span>}
                {m.isModerator && <span className="msg-badge mod">mod</span>}
                {m.isSubscriber && <span className="msg-badge sub">sub</span>}
                <span
                  className="msg-author"
                  style={{ color: m.authorColor || PLATFORM_COLORS[m.platformKind] }}
                >
                  {m.author}
                </span>
                <span className="msg-text">{m.message}</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {visible.length === 0 && (
          <div className="chat-empty">
            <ChatIcon size={26} />
            <div>
              No messages yet.
              <br />
              Chat appears here with timestamps as your audience talks.
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {!pinned && (
          <motion.button
            className="btn sm primary jump-btn"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => {
              setPinned(true)
              if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
            }}
          >
            Jump to latest
          </motion.button>
        )}
      </AnimatePresence>

      <div className="chat-foot">
        <span className={`dot ${connectedCount ? 'ok' : ''}`} />
        {connectedCount} chat source{connectedCount === 1 ? '' : 's'} connected
        <div className="spacer" />
        <button
          className="btn icon sm ghost"
          title="Reconnect all chat sources"
          onClick={() => chatPlatforms.forEach((p) => onReconnect(p.id))}
        >
          <RefreshIcon size={13} />
        </button>
      </div>
    </div>
  )
}
