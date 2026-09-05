import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type {
  ActivityEvent,
  AppConfig,
  AppSettings,
  ChatMessage,
  LayoutValues,
  LogEntry,
  PanelId,
  PanelRegion,
  PanelState,
  PlatformKind,
  Snapshot
} from '@shared/types'
import {
  activeLayout,
  DEFAULT_LAYOUT_ID,
  isLayoutDirty,
  layoutLabel,
  layoutValuesOf,
  placePanel,
  panelsIn,
  PANEL_TITLES,
  totalViewers,
  uniqueLayoutName,
  withPanel
} from '@shared/types'
import {
  AlertIcon,
  BellIcon,
  PenIcon,
  BroadcastIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
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
import ActivityPane from './components/ActivityPane'
import LayoutMenu from './components/LayoutMenu'
import PanelFrame from './components/PanelFrame'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'
import ReconnectBanner from './components/ReconnectBanner'
import SettingsModal from './components/SettingsModal'

type View = 'broadcast' | 'logs'

/** Bounds for the draggable chat column, px. */
const MIN_CHAT_W = 280
const MAX_CHAT_W = 820

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
  viewers: {},
  auth: {},
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
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<{ id: PanelId; region: PanelRegion; index: number } | null>(null)
  const regionRefs = useRef<Record<PanelRegion, HTMLDivElement | null>>({ left: null, right: null })
  const panelRefs = useRef(new Map<PanelId, HTMLDivElement>())
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const [view, setView] = useState<View>('broadcast')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focusPlatform, setFocusPlatform] = useState<string | null>(null)
  const [encoders, setEncoders] = useState<string[]>([])
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [ingestInfo, setIngestInfo] = useState({ ingestUrl: '', streamKey: '', previewUrl: '' })
  const [maximized, setMaximized] = useState(false)
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: 'ok' | 'err' }[]>([])
  const [unreadChat, setUnreadChat] = useState(0)
  // The destination whose login is on screen, and whichever auth action is in
  // flight so its buttons can disable without blocking the rest of the UI.
  const [connecting, setConnecting] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState<string | null>(null)
  /** Ids the user has waved away this session, so the banner asks only once. */
  const [dismissedStale, setDismissedStale] = useState<Set<string>>(new Set())
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
      setActivity(await api.getActivity())
      setIngestInfo(await api.getIngestInfo())
      setFfmpegPath(await api.getFfmpegPath())
      setEncoders(await api.detectEncoders())
    })()

    const offSnapshot = api.onSnapshot(setSnapshot)
    const offChat = api.onChatMessage((m) => setMessages((prev) => [...prev.slice(-499), m]))
    const offLog = api.onLog((l) => setLogs((prev) => [...prev.slice(-399), l]))
    const offActivity = api.onActivity((e) => setActivity((prev) => [...prev.slice(-399), e]))
    const offConfig = api.onConfig(setConfig)
    const offWindow = api.onWindowState((s) => setMaximized(s.maximized))
    const offPublish = api.onIngestPublish((publishing) =>
      toast(
        publishing ? 'Streamlabs connected' : 'Streamlabs disconnected',
        publishing ? 'ok' : 'err'
      )
    )

    return () => {
      offSnapshot()
      offChat()
      offLog()
      offActivity()
      offConfig()
      offWindow()
      offPublish()
    }
  }, [toast])

  // Track unread chat while the user is on another view.
  useEffect(() => {
    if (view === 'broadcast') setUnreadChat(0)
  }, [view, messages.length])

  useEffect(() => {
    if (view !== 'broadcast') setUnreadChat((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.settings.theme
  }, [config?.settings.theme])

  // The device flow finishes in the main process; close the modal when the
  // account it was waiting for actually arrives.
  useEffect(() => {
    if (!connecting) return
    const state = snapshot.auth[connecting]?.state
    if (state === 'connected') {
      const name = snapshot.auth[connecting]?.account?.displayName
      setConnecting(null)
      toast(name ? `Connected as ${name}` : 'Account connected')
    }
  }, [snapshot.auth, connecting, toast])

  /* ---------------- actions ---------------- */

  const patchPlatform = async (
    id: string,
    patch: Parameters<typeof window.hydracast.updatePlatform>[1]
  ) => {
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

  /**
   * Starts a login. The main process drives the device flow and reports through
   * the snapshot, so this only has to open the modal and wait.
   */
  /**
   * Logins that lapsed while the app was closed, minus any the user waved away.
   * Keyed off `needsReconnect` rather than the error state, so an abandoned
   * connect attempt never raises the banner.
   */
  const staleLogins = useMemo(
    () =>
      (config?.platforms ?? []).filter(
        (p) => snapshot.auth[p.id]?.needsReconnect && !dismissedStale.has(p.id)
      ),
    [config, snapshot.auth, dismissedStale]
  )

  const connectAccount = async (id: string) => {
    setConnecting(id)
    setAuthBusy(id)
    try {
      await window.hydracast.connectAccount(id)
    } finally {
      setAuthBusy(null)
    }
  }

  const disconnectAccount = async (id: string) => {
    setAuthBusy(id)
    try {
      setConfig(await window.hydracast.disconnectAccount(id))
      toast('Account disconnected')
    } finally {
      setAuthBusy(null)
    }
  }

  const refreshStreamKey = async (id: string) => {
    setAuthBusy(id)
    try {
      setConfig(await window.hydracast.refreshStreamKey(id))
      toast('Stream key refreshed')
    } finally {
      setAuthBusy(null)
    }
  }

  /** Stable identity so the memoised composer is not re-rendered by the tick. */
  const sendChat = useCallback(
    (ids: string[], text: string) => window.hydracast.sendChat(ids, text),
    []
  )

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

  const patchSettings = (patch: Partial<AppSettings>): void => {
    if (!config) return
    void saveConfig({ ...config, settings: { ...config.settings, ...patch } })
  }

  /**
   * Records a layout edit as an unsaved draft rather than writing it into the
   * selected layout. Nothing is ever saved by accident, and Default in
   * particular stays exactly as it shipped.
   */
  const editLayout = (next: LayoutValues): void => {
    patchSettings({ draftLayout: layoutValuesOf(next) })
  }

  const patchPanel = (id: PanelId, patch: Partial<PanelState>): void =>
    editLayout(withPanel(layout, id, patch))

  const selectLayout = (id: string): void => {
    if (!config) return
    // Selecting always discards the draft, so a layout is what it says it is.
    patchSettings({ activeLayoutId: id, draftLayout: null })
  }

  const saveLayout = (): void => {
    if (!config?.settings.draftLayout) return
    const active = config.settings.layouts.find((l) => l.id === config.settings.activeLayoutId)
    if (!active || active.builtIn) return
    const values = layoutValuesOf(config.settings.draftLayout)
    patchSettings({
      layouts: config.settings.layouts.map((l) => (l.id === active.id ? { ...l, ...values } : l)),
      draftLayout: null
    })
    toast(`Saved "${active.name}"`)
  }

  const saveLayoutAs = (name: string): void => {
    if (!config) return
    const unique = uniqueLayoutName(name, config.settings.layouts)
    const preset = {
      id: `layout-${Date.now().toString(36)}`,
      name: unique,
      ...layoutValuesOf(layout)
    }
    patchSettings({
      layouts: [...config.settings.layouts, preset],
      activeLayoutId: preset.id,
      draftLayout: null
    })
    toast(`Layout "${unique}" saved`)
  }

  const revertLayout = (): void => {
    patchSettings({ draftLayout: null })
    toast('Changes discarded')
  }

  const renameLayout = (id: string, name: string): void => {
    if (!config) return
    const target = config.settings.layouts.find((l) => l.id === id)
    if (!target || target.builtIn) return
    const unique = uniqueLayoutName(name, config.settings.layouts, id)
    patchSettings({
      layouts: config.settings.layouts.map((l) => (l.id === id ? { ...l, name: unique } : l))
    })
  }

  const deleteLayout = (id: string): void => {
    if (!config) return
    const target = config.settings.layouts.find((l) => l.id === id)
    // The built-in is the guaranteed way back and is never removable.
    if (!target || target.builtIn) return
    const layouts = config.settings.layouts.filter((l) => l.id !== id)
    const wasActive = config.settings.activeLayoutId === id
    patchSettings({
      layouts,
      activeLayoutId: wasActive ? DEFAULT_LAYOUT_ID : config.settings.activeLayoutId,
      draftLayout: wasActive ? null : config.settings.draftLayout
    })
    toast(`Layout "${target.name}" removed`)
  }

  /**
   * Drags a panel to a new column and position.
   *
   * The drop target is worked out from the rendered geometry rather than from
   * HTML5 drag events: the column under the pointer decides the region, and the
   * first panel whose vertical midpoint the pointer is above decides the index.
   * That keeps the indicator honest even as panels resize mid-drag.
   */
  const startPanelDrag = (id: PanelId, e: React.PointerEvent): void => {
    e.preventDefault()

    const targetAt = (x: number, y: number): { region: PanelRegion; index: number } => {
      const right = regionRefs.current.right?.getBoundingClientRect()
      const region: PanelRegion = right && x >= right.left ? 'right' : 'left'

      const siblings = panelsIn(layout, region).filter((p) => p.id !== id)
      let index = siblings.length
      for (let i = 0; i < siblings.length; i++) {
        const el = panelRefs.current.get(siblings[i].id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (y < r.top + r.height / 2) {
          index = i
          break
        }
      }
      return { region, index }
    }

    setDrag({ id, ...targetAt(e.clientX, e.clientY) })

    const onMove = (ev: PointerEvent): void => setDrag({ id, ...targetAt(ev.clientX, ev.clientY) })
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const target = targetAt(ev.clientX, ev.clientY)
      setDrag(null)
      editLayout(placePanel(layout, id, target.region, target.index))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Drags the right-hand region wider or narrower. The width is tracked locally
   * for the duration of the drag and committed once on release, so a resize
   * costs one write rather than one per pointer move.
   */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const el = workspaceRef.current
    if (!el) return
    const right = el.getBoundingClientRect().right
    const clamp = (x: number): number =>
      Math.round(Math.min(MAX_CHAT_W, Math.max(MIN_CHAT_W, right - x)))

    setResizing(true)
    const onMove = (ev: PointerEvent): void => setDragWidth(clamp(ev.clientX))
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const next = clamp(ev.clientX)
      setResizing(false)
      setDragWidth(null)
      editLayout({ ...layout, chatWidth: next })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const platforms = config?.platforms ?? []
  const layout: LayoutValues = config
    ? activeLayout(config.settings)
    : { chatFontSize: 13.5, chatWidth: MIN_CHAT_W, panels: [] }
  // The dragged width wins while a drag is in flight; the saved one otherwise.
  const chatWidth = dragWidth ?? layout.chatWidth
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
  // Summed across the live destinations that report one; -1 while none does.
  const viewerTotal = useMemo(() => totalViewers(snapshot.viewers), [snapshot.viewers])
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

  const leftPanels = config ? panelsIn(layout, 'left') : []
  const rightPanels = config ? panelsIn(layout, 'right') : []

  /** Renders a region's panels with the drop indicator at the pending index. */
  const withDropLine = (panels: PanelState[], region: PanelRegion): JSX.Element[] => {
    const out: JSX.Element[] = []
    const showAt = drag && drag.region === region ? drag.index : -1
    const rest = panels.filter((p) => p.id !== drag?.id)

    rest.forEach((panel, i) => {
      if (i === showAt) out.push(<div key={`drop-${i}`} className="drop-line" />)
      out.push(renderPanel(panel))
    })
    if (showAt >= rest.length) out.push(<div key="drop-end" className="drop-line" />)
    return out
  }

  /** Renders one panel inside the shared shell. */
  const renderPanel = (panel: PanelState): JSX.Element => {
    let body: JSX.Element | null = null
    let actions: JSX.Element | null = null

    if (panel.id === 'preview') {
      body = (
        <PreviewPane
          ingest={snapshot.ingest}
          broadcasting={snapshot.broadcasting}
          ingestUrl={ingestInfo.ingestUrl}
          streamKey={ingestInfo.streamKey}
          destinationCount={liveCount}
        />
      )
    } else if (panel.id === 'destinations') {
      body = (
        <div className="platforms">
          <AnimatePresence mode="popLayout">
            {platforms.map((p) => (
              <PlatformCard
                key={p.id}
                platform={p}
                stats={snapshot.relays[p.id]}
                viewers={snapshot.viewers[p.id]}
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
      )
    } else if (panel.id === 'chat') {
      body = (
        <ChatPane
          messages={messages}
          platforms={platforms}
          chatStatus={snapshot.chatStatus}
          auth={snapshot.auth}
          onSend={sendChat}
          fontSize={layout.chatFontSize}
          onFontSize={(chatFontSize) => editLayout({ ...layout, chatFontSize })}
          onClear={() => {
            void window.hydracast.clearChat()
            setMessages([])
          }}
          onReconnect={(id) => {
            void window.hydracast.reconnectChat(id)
            toast('Reconnecting chat')
          }}
        />
      )
    } else {
      body = (
        <ActivityPane
          events={activity}
          platforms={platforms}
          fontSize={layout.chatFontSize}
          onClear={() => {
            void window.hydracast.clearActivity()
            setActivity([])
          }}
        />
      )
    }

    return (
      <PanelFrame
        key={panel.id}
        panel={panel}
        title={PANEL_TITLES[panel.id]}
        editing={editing}
        dragging={drag?.id === panel.id}
        frameRef={(el) => {
          if (el) panelRefs.current.set(panel.id, el)
          else panelRefs.current.delete(panel.id)
        }}
        onToggleCollapse={() => patchPanel(panel.id, { collapsed: !panel.collapsed })}
        onDragStart={(e) => startPanelDrag(panel.id, e)}
        onHide={() => patchPanel(panel.id, { visible: false })}
        actions={actions}
      >
        {body}
      </PanelFrame>
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

        <div className="titlebar-tools">
          <LayoutMenu
            layouts={config.settings.layouts}
            activeId={config.settings.activeLayoutId}
            dirty={isLayoutDirty(config.settings)}
            label={layoutLabel(config.settings)}
            onSelect={selectLayout}
            onSave={saveLayout}
            onSaveAs={saveLayoutAs}
            onRevert={revertLayout}
            onRename={renameLayout}
            onDelete={deleteLayout}
          />
          <button
            className={`btn icon sm ghost ${editing ? 'active' : ''}`}
            onClick={() => setEditing((v) => !v)}
            title={editing ? 'Finish editing the layout' : 'Edit layout'}
          >
            <PenIcon size={15} />
          </button>
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
              ['broadcast', BroadcastIcon, 'Workspace'],
              ['logs', LogsIcon, 'Logs']
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
              {id === 'broadcast' && unreadChat > 0 && view !== 'broadcast' && (
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
              <div
                className="stat"
                title={
                  viewerTotal >= 0
                    ? 'Concurrent viewers, summed across the destinations reporting one'
                    : 'No live destination is reporting a viewer count'
                }
              >
                <span className="k">
                  <EyeIcon size={11} /> Viewers
                </span>
                <span className="v">{viewerTotal >= 0 ? viewerTotal.toLocaleString() : '--'}</span>
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

          <AnimatePresence>
            {staleLogins.length > 0 && (
              <ReconnectBanner
                stale={staleLogins}
                auth={snapshot.auth}
                busy={authBusy}
                onReconnect={(id) => void connectAccount(id)}
                onDismiss={() =>
                  setDismissedStale((prev) => new Set([...prev, ...staleLogins.map((p) => p.id)]))
                }
              />
            )}
          </AnimatePresence>

          {/* views */}
          {view === 'broadcast' && (
            <div className="workspace" ref={workspaceRef}>
              <div className="workspace-left" ref={(el) => (regionRefs.current.left = el)}>
                {withDropLine(leftPanels, 'left')}
              </div>

              {/* The right column stays mounted mid-drag so it can be dropped
                  into even when the last panel has just been dragged out. */}
              {(rightPanels.length > 0 || drag) && (
                <>
                  <div
                    className={`splitter ${resizing ? 'dragging' : ''}`}
                    onPointerDown={startResize}
                    title="Drag to resize"
                  />
                  <div
                    className="chat-column"
                    style={{ width: chatWidth }}
                    ref={(el) => (regionRefs.current.right = el)}
                  >
                    {withDropLine(rightPanels, 'right')}
                  </div>
                </>
              )}

              {leftPanels.length === 0 && rightPanels.length === 0 && (
                <div className="empty-state" style={{ flex: 1 }}>
                  <AlertIcon size={26} />
                  <div>Every panel is hidden.</div>
                  <button className="btn primary" onClick={() => selectLayout(DEFAULT_LAYOUT_ID)}>
                    Restore the Default layout
                  </button>
                </div>
              )}
            </div>
          )}

          {view === 'logs' && (
            <div className="panel logs">
              <div className="panel-head">
                <LogsIcon size={16} />
                <span className="panel-title">Logs</span>
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
            auth={snapshot.auth}
            authBusy={authBusy}
            onConnect={(id) => void connectAccount(id)}
            onDisconnect={(id) => void disconnectAccount(id)}
            onRefreshKey={(id) => void refreshStreamKey(id)}
          />
        )}
      </AnimatePresence>

      {/* ---------------- account login ---------------- */}
      <AnimatePresence>
        {connecting && platforms.some((p) => p.id === connecting) && (
          <ConnectModal
            platform={platforms.find((p) => p.id === connecting)!}
            status={snapshot.auth[connecting]}
            onCancel={() => {
              void window.hydracast.cancelConnect(connecting)
              setConnecting(null)
            }}
            onCopied={(code) => copy(code, 'Code')}
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
              <span
                style={{ color: t.kind === 'ok' ? 'var(--ok)' : 'var(--warn)', display: 'grid' }}
              >
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
