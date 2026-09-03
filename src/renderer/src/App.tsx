import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type {
  AppConfig,
  ChatMessage,
  LogEntry,
  PlatformKind,
  Snapshot
} from '@shared/types'
import {
  AlertIcon,
  BroadcastIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  LogsIcon,
  MaximizeIcon,
  MinimizeIcon,
  PlayIcon,
  RestoreIcon,
  SettingsIcon,
  StopIcon
} from './icons'
import PreviewPane from './components/PreviewPane'
import PlatformCard from './components/PlatformCard'
import ChatPane from './components/ChatPane'
import SettingsModal from './components/SettingsModal'

type View = 'broadcast' | 'chat' | 'logs'

const emptySnapshot: Snapshot = {
  ingest: {
    listening: false,
    publishing: false,
    bitrateKbps: 0,
    width: 0,
    height: 0,
    fps: 0,
    videoCodec: '',
    audioCodec: '',
    uptimeSec: 0,
    previewUrl: ''
  },
  relays: {},
  chatStatus: {},
  broadcasting: false,
  sessionStartedAt: null
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [view, setView] = useState<View>('broadcast')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focusPlatform, setFocusPlatform] = useState<string | null>(null)
  const [encoders, setEncoders] = useState<string[]>([])
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [ingestInfo, setIngestInfo] = useState({ ingestUrl: '', streamKey: '', previewUrl: '' })
  const [maximized, setMaximized] = useState(false)
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: 'ok' | 'err' }[]>([])
  const [unreadChat, setUnreadChat] = useState(0)
  const toastId = useRef(0)

  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  /* ---------------- bootstrap + subscriptions ---------------- */

  useEffect(() => {
    const api = window.hydracast
    void (async () => {
      setConfig(await api.getConfig())
      setSnapshot(await api.getSnapshot())
      setMessages(await api.getChatHistory())
      setLogs(await api.getLogs())
      setIngestInfo(await api.getIngestInfo())
      setFfmpegPath(await api.getFfmpegPath())
      setEncoders(await api.detectEncoders())
    })()

    const offSnapshot = api.onSnapshot(setSnapshot)
    const offChat = api.onChatMessage((m) => setMessages((prev) => [...prev.slice(-499), m]))
    const offLog = api.onLog((l) => setLogs((prev) => [...prev.slice(-399), l]))
    const offWindow = api.onWindowState((s) => setMaximized(s.maximized))
    const offPublish = api.onIngestPublish((publishing) =>
      toast(publishing ? 'Streamlabs connected' : 'Streamlabs disconnected', publishing ? 'ok' : 'err')
    )

    return () => {
      offSnapshot()
      offChat()
      offLog()
      offWindow()
      offPublish()
    }
  }, [toast])

  // Track unread chat while the user is on another view.
  useEffect(() => {
    if (view === 'chat') setUnreadChat(0)
  }, [view, messages.length])

  useEffect(() => {
    if (view !== 'chat') setUnreadChat((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.settings.theme
  }, [config?.settings.theme])

  /* ---------------- actions ---------------- */

  const patchPlatform = async (id: string, patch: Parameters<typeof window.hydracast.updatePlatform>[1]) => {
    setConfig(await window.hydracast.updatePlatform(id, patch))
  }

  const saveConfig = async (next: AppConfig) => {
    setConfig(await window.hydracast.saveConfig(next))
    setIngestInfo(await window.hydracast.getIngestInfo())
    setFfmpegPath(await window.hydracast.getFfmpegPath())
    setSettingsOpen(false)
    setFocusPlatform(null)
    toast('Configuration saved')
  }

  const addPlatform = async (kind: PlatformKind) => {
    setConfig(await window.hydracast.addPlatform(kind))
  }

  const removePlatform = async (id: string) => {
    setConfig(await window.hydracast.removePlatform(id))
    toast('Destination removed')
  }

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text)
    toast(`${label} copied`)
  }

  /** Flattens the activity log into something pasteable into a bug report. */
  const logsAsText = (entries: LogEntry[]): string =>
    entries
      .map(
        (l) =>
          `${new Date(l.timestamp).toLocaleTimeString('en-GB')}  ${l.level.padEnd(7)} ${l.scope.padEnd(6)} ${l.message}`
      )
      .join('\n')

  const platforms = config?.platforms ?? []
  const liveCount = useMemo(
    () => Object.values(snapshot.relays).filter((r) => r.status === 'live').length,
    [snapshot.relays]
  )
  const enabledCount = platforms.filter((p) => p.enabled).length
  const sessionSec = snapshot.sessionStartedAt
    ? Math.floor((Date.now() - snapshot.sessionStartedAt) / 1000)
    : 0
  const totalOut = useMemo(
    () =>
      Object.values(snapshot.relays)
        .filter((r) => r.status === 'live')
        .reduce((sum, r) => sum + r.bitrateKbps, 0),
    [snapshot.relays]
  )
  const avgLatency = useMemo(() => {
    const values = Object.values(snapshot.relays)
      .map((r) => r.latencyMs)
      .filter((v) => v >= 0)
    if (!values.length) return -1
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  }, [snapshot.relays])

  if (!config) {
    return (
      <div className="app">
        <div className="aurora">
          <span />
          <span />
          <span />
        </div>
        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <div className="waiting-ring" />
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="aurora">
        <span />
        <span />
        <span />
      </div>

      {/* ---------------- title bar ---------------- */}
      <div className="titlebar">
        <div className="brand">
          <div className="brand-mark">
            <BroadcastIcon size={15} />
          </div>
          Hydracast
          <span className="dim" style={{ fontSize: 12 }}>
            multistream relay
          </span>
        </div>

        <div className="titlebar-center">
          <span className="pill">
            <span className={`dot ${snapshot.ingest.listening ? 'ok' : 'err'}`} />
            {snapshot.ingest.listening ? 'Ingest ready' : 'Ingest offline'}
          </span>
          <span className="pill">
            <span className={`dot ${snapshot.ingest.publishing ? 'live' : ''}`} />
            {snapshot.ingest.publishing ? 'Streamlabs connected' : 'Awaiting encoder'}
          </span>
          {snapshot.broadcasting && (
            <motion.span
              className="live-badge"
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
            >
              <span className="ring" />
              ON AIR
            </motion.span>
          )}
        </div>

        <div className="win-controls">
          <button className="win-btn" onClick={() => window.hydracast.minimize()}>
            <MinimizeIcon />
          </button>
          <button className="win-btn" onClick={() => window.hydracast.toggleMaximize()}>
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button className="win-btn close" onClick={() => window.hydracast.close()}>
            <CloseIcon size={15} />
          </button>
        </div>
      </div>

      <div className="body">
        {/* ---------------- rail ---------------- */}
        <div className="rail">
          {(
            [
              ['broadcast', BroadcastIcon, 'Broadcast'],
              ['chat', ChatIcon, 'Chat'],
              ['logs', LogsIcon, 'Activity']
            ] as [View, typeof BroadcastIcon, string][]
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              className={`rail-btn ${view === id ? 'active' : ''}`}
              onClick={() => setView(id)}
              title={label}
            >
              {view === id && <motion.span className="rail-indicator" layoutId="rail-indicator" />}
              <Icon size={19} />
              {id === 'chat' && unreadChat > 0 && view !== 'chat' && (
                <span className="rail-badge">{unreadChat > 99 ? '99+' : unreadChat}</span>
              )}
            </button>
          ))}
          <div className="spacer" />
          <button
            className="rail-btn"
            onClick={() => {
              setFocusPlatform(null)
              setSettingsOpen(true)
            }}
            title="Settings"
          >
            <SettingsIcon size={19} />
          </button>
        </div>

        {/* ---------------- main ---------------- */}
        <div className="main">
          {/* status bar */}
          <div className="panel statusbar">
            <div className="endpoint">
              <div>
                <div className="endpoint-label">Streamlabs server</div>
                <div className="endpoint-value">{ingestInfo.ingestUrl}</div>
              </div>
              <button
                className="btn icon sm ghost"
                onClick={() => copy(ingestInfo.ingestUrl, 'Server URL')}
                title="Copy server URL"
              >
                <CopyIcon />
              </button>
            </div>

            <div className="endpoint">
              <div>
                <div className="endpoint-label">Stream key</div>
                <div className="endpoint-value">{ingestInfo.streamKey}</div>
              </div>
              <button
                className="btn icon sm ghost"
                onClick={() => copy(ingestInfo.streamKey, 'Stream key')}
                title="Copy stream key"
              >
                <CopyIcon />
              </button>
            </div>

            <div className="spacer" />

            <div className="stat-group">
              <div className="stat">
                <span className="k">Session</span>
                <span className="v">{fmtDuration(sessionSec)}</span>
              </div>
              <div className="stat">
                <span className="k">Incoming</span>
                <span className="v">{snapshot.ingest.bitrateKbps.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="k">Outgoing</span>
                <span className="v">{totalOut.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="k">Avg latency</span>
                <span className="v">{avgLatency >= 0 ? `${avgLatency}ms` : '--'}</span>
              </div>
              <div className="stat">
                <span className="k">Live</span>
                <span className="v" style={{ color: liveCount ? 'var(--live)' : undefined }}>
                  {liveCount}/{enabledCount}
                </span>
              </div>
            </div>

            {snapshot.broadcasting ? (
              <button
                className="btn danger golive"
                onClick={() => {
                  void window.hydracast.stopBroadcast()
                  toast('Broadcast stopped')
                }}
              >
                <StopIcon size={14} />
                End broadcast
              </button>
            ) : (
              <motion.button
                className="btn primary golive"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                disabled={enabledCount === 0}
                onClick={() => {
                  void window.hydracast.startBroadcast()
                  toast(`Going live to ${enabledCount} destination${enabledCount === 1 ? '' : 's'}`)
                }}
              >
                <PlayIcon size={14} />
                Go live
              </motion.button>
            )}
          </div>

          {/* views */}
          {view === 'broadcast' && (
            <div className="workspace">
              <div className="workspace-left">
                {config.settings.showPreview && (
                  <PreviewPane
                    ingest={snapshot.ingest}
                    broadcasting={snapshot.broadcasting}
                    ingestUrl={ingestInfo.ingestUrl}
                    streamKey={ingestInfo.streamKey}
                    destinationCount={liveCount}
                  />
                )}

                <div className="platforms">
                  <AnimatePresence mode="popLayout">
                    {platforms.map((p) => (
                      <PlatformCard
                        key={p.id}
                        platform={p}
                        stats={snapshot.relays[p.id]}
                        encoders={encoders}
                        onPatch={(patch) => void patchPlatform(p.id, patch)}
                        onStart={() => void window.hydracast.startRelay(p.id)}
                        onStop={() => void window.hydracast.stopRelay(p.id)}
                        onConfigure={() => {
                          setFocusPlatform(p.id)
                          setSettingsOpen(true)
                        }}
                      />
                    ))}
                  </AnimatePresence>

                  {platforms.length === 0 && (
                    <div className="empty-state">
                      <AlertIcon size={26} />
                      <div>No destinations yet.</div>
                      <button className="btn primary" onClick={() => setSettingsOpen(true)}>
                        Add your first platform
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="chat-column">
                <ChatPane
                  messages={messages}
                  platforms={platforms}
                  chatStatus={snapshot.chatStatus}
                  onClear={() => {
                    void window.hydracast.clearChat()
                    setMessages([])
                  }}
                  onReconnect={(id) => {
                    void window.hydracast.reconnectChat(id)
                    toast('Reconnecting chat')
                  }}
                />
              </div>
            </div>
          )}

          {view === 'chat' && (
            <div className="workspace">
              <ChatPane
                messages={messages}
                platforms={platforms}
                chatStatus={snapshot.chatStatus}
                onClear={() => {
                  void window.hydracast.clearChat()
                  setMessages([])
                }}
                onReconnect={(id) => {
                  void window.hydracast.reconnectChat(id)
                  toast('Reconnecting chat')
                }}
              />
            </div>
          )}

          {view === 'logs' && (
            <div className="panel logs">
              <div className="panel-head">
                <LogsIcon size={16} />
                <span className="panel-title">Activity</span>
                <div className="spacer" />
                <button
                  className="btn sm ghost"
                  disabled={!logs.length}
                  onClick={() => copy(logsAsText(logs), `${logs.length} log lines`)}
                  title="Copy every line below to the clipboard"
                >
                  <CopyIcon size={13} />
                  Copy all
                </button>
                <button
                  className="btn sm ghost"
                  disabled={!logs.some((l) => l.level === 'error' || l.level === 'warn')}
                  onClick={() => {
                    const problems = logs.filter((l) => l.level === 'error' || l.level === 'warn')
                    copy(logsAsText(problems), `${problems.length} problem lines`)
                  }}
                  title="Copy only the warnings and errors"
                >
                  <CopyIcon size={13} />
                  Copy errors
                </button>
                <button className="btn sm ghost" onClick={() => setLogs([])}>
                  Clear
                </button>
              </div>
              <div className="log-list">
                {logs.map((l) => (
                  <div
                    key={l.id}
                    className={`log-row ${l.level}`}
                    onDoubleClick={() => copy(l.message, 'Log line')}
                    title="Double-click to copy this line"
                  >
                    <span className="log-time">
                      {new Date(l.timestamp).toLocaleTimeString('en-GB')}
                    </span>
                    <span className="log-scope">{l.scope}</span>
                    <span className="log-msg">{l.message}</span>
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="chat-empty">Nothing logged yet this session.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------- settings ---------------- */}
      <AnimatePresence>
        {settingsOpen && (
          <SettingsModal
            config={config}
            encoders={encoders}
            ffmpegPath={ffmpegPath}
            focusPlatformId={focusPlatform}
            onClose={() => {
              setSettingsOpen(false)
              setFocusPlatform(null)
            }}
            onSave={(next) => void saveConfig(next)}
            onAddPlatform={(kind) => void addPlatform(kind)}
            onRemovePlatform={(id) => void removePlatform(id)}
          />
        )}
      </AnimatePresence>

      {/* ---------------- toasts ---------------- */}
      <div className="toasts">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className="toast"
              initial={{ opacity: 0, x: 40, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            >
              <span style={{ color: t.kind === 'ok' ? 'var(--ok)' : 'var(--warn)', display: 'grid' }}>
                {t.kind === 'ok' ? <CheckIcon size={15} /> : <AlertIcon size={15} />}
              </span>
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
