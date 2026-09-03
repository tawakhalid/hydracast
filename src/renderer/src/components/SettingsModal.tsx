import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type {
  AppConfig,
  AppSettings,
  CheckResult,
  EncoderKind,
  Platform,
  PlatformKind
} from '@shared/types'
import { PLATFORM_PRESETS, supportsChat } from '@shared/types'
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  PlatformIcon,
  PLATFORM_COLORS,
  PlusIcon,
  TrashIcon
} from '../icons'

interface Props {
  config: AppConfig
  encoders: string[]
  ffmpegPath: string
  focusPlatformId: string | null
  onClose: () => void
  onSave: (config: AppConfig) => void
  onAddPlatform: (kind: PlatformKind) => void
  onRemovePlatform: (id: string) => void
}

type Tab = 'destinations' | 'chat' | 'app'

function Check({
  checked,
  onChange,
  title,
  description
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description?: string
}) {
  return (
    <div className="check" onClick={() => onChange(!checked)}>
      <div className={`checkbox ${checked ? 'on' : ''}`}>
        {checked && <CheckIcon size={12} />}
      </div>
      <div className="check-text">
        <div className="t">{title}</div>
        {description && <div className="d">{description}</div>}
      </div>
    </div>
  )
}

export default function SettingsModal({
  config,
  encoders,
  ffmpegPath,
  focusPlatformId,
  onClose,
  onSave,
  onAddPlatform,
  onRemovePlatform
}: Props) {
  const [tab, setTab] = useState<Tab>('destinations')
  const [draft, setDraft] = useState<AppConfig>(() => structuredClone(config))
  const [openId, setOpenId] = useState<string | null>(focusPlatformId ?? config.platforms[0]?.id ?? null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [testing, setTesting] = useState<string | null>(null)
  const [reports, setReports] = useState<Record<string, CheckResult[]>>({})
  const [showAdd, setShowAdd] = useState(false)

  // Platforms can be added or removed from outside the modal (main process owns
  // the list), so re-sync when the incoming config changes identity.
  useEffect(() => {
    setDraft(structuredClone(config))
  }, [config])

  useEffect(() => {
    if (focusPlatformId) {
      setTab('destinations')
      setOpenId(focusPlatformId)
    }
  }, [focusPlatformId])

  const patchPlatform = (id: string, patch: Partial<Platform>): void =>
    setDraft((d) => ({
      ...d,
      platforms: d.platforms.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))

  const patchVideo = (id: string, patch: Partial<Platform['video']>): void =>
    setDraft((d) => ({
      ...d,
      platforms: d.platforms.map((p) => (p.id === id ? { ...p, video: { ...p.video, ...patch } } : p))
    }))

  const patchChat = (id: string, patch: Partial<Platform['chat']>): void =>
    setDraft((d) => ({
      ...d,
      platforms: d.platforms.map((p) => (p.id === id ? { ...p, chat: { ...p.chat, ...patch } } : p))
    }))

  const patchSettings = (patch: Partial<AppSettings>): void =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }))

  const toggleReveal = (id: string): void =>
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const chatPlatforms = draft.platforms.filter((p) => supportsChat(p.kind))

  const runTest = async (platform: Platform): Promise<void> => {
    setTesting(platform.id)
    try {
      const checks = await window.hydracast.testRelay(platform)
      setReports((prev) => ({ ...prev, [platform.id]: checks }))
    } finally {
      setTesting(null)
    }
  }

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
        className="modal"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      >
        <div className="modal-head">
          <h2>Configuration</h2>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="modal-tabs">
          {(
            [
              ['destinations', 'Destinations'],
              ['chat', 'Chat sources'],
              ['app', 'Application']
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
              {tab === id && <motion.span className="tab-underline" layoutId="tab-underline" />}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'destinations' && (
            <>
              {draft.platforms.map((p) => {
                const color = PLATFORM_COLORS[p.kind]
                const open = openId === p.id
                const preset = PLATFORM_PRESETS.find((x) => x.kind === p.kind)
                return (
                  <div key={p.id} className="plat-editor" style={{ ['--pc' as string]: color }}>
                    <div className="plat-editor-head" onClick={() => setOpenId(open ? null : p.id)}>
                      <div className="pcard-icon" style={{ width: 32, height: 32 }}>
                        <PlatformIcon kind={p.kind} size={17} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                        <div className="pcard-sub" style={{ maxWidth: 420 }}>
                          {p.streamKey ? 'key configured' : 'no stream key'} &middot;{' '}
                          {p.video.mode === 'copy'
                            ? 'passthrough'
                            : `${p.video.videoBitrate.toLocaleString()} kbps`}
                        </div>
                      </div>
                      <span className={`dot ${p.enabled ? 'ok' : ''}`} />
                      <motion.span animate={{ rotate: open ? 180 : 0 }}>
                        <ChevronIcon />
                      </motion.span>
                    </div>

                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          className="plat-editor-body"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                        >
                          <div className="row c2">
                            <div className="field">
                              <label>Display name</label>
                              <input
                                className="input"
                                value={p.name}
                                onChange={(e) => patchPlatform(p.id, { name: e.target.value })}
                              />
                            </div>
                            <div className="field">
                              <label>Platform</label>
                              <select
                                className="input"
                                value={p.kind}
                                onChange={(e) => {
                                  const kind = e.target.value as PlatformKind
                                  const next = PLATFORM_PRESETS.find((x) => x.kind === kind)!
                                  patchPlatform(p.id, {
                                    kind,
                                    name: next.name,
                                    url: next.url || p.url
                                  })
                                }}
                              >
                                {PLATFORM_PRESETS.map((preset) => (
                                  <option key={preset.kind} value={preset.kind}>
                                    {preset.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="field">
                            <label>RTMP ingest URL</label>
                            <input
                              className="input mono"
                              placeholder={preset?.urlPlaceholder ?? 'rtmp://live.twitch.tv/app'}
                              value={p.url}
                              onChange={(e) => patchPlatform(p.id, { url: e.target.value })}
                            />
                            {preset?.urlHint && (
                              <div className="hint" style={{ marginTop: 6 }}>
                                {preset.urlHint}
                              </div>
                            )}
                          </div>

                          <div className="field">
                            <label>Stream key</label>
                            <div className="key-input">
                              <input
                                className="input mono"
                                type={revealed.has(p.id) ? 'text' : 'password'}
                                placeholder="live_123456789_abcdefghijklmnop"
                                value={p.streamKey}
                                onChange={(e) => patchPlatform(p.id, { streamKey: e.target.value })}
                              />
                              <div className="key-actions">
                                <button
                                  className="btn icon sm ghost"
                                  onClick={() => toggleReveal(p.id)}
                                  title={revealed.has(p.id) ? 'Hide key' : 'Reveal key'}
                                >
                                  {revealed.has(p.id) ? <EyeOffIcon /> : <EyeIcon />}
                                </button>
                                {preset?.helpUrl && (
                                  <button
                                    className="btn icon sm ghost"
                                    title="Open the platform dashboard to copy your key"
                                    onClick={() => window.hydracast.openExternal(preset.helpUrl)}
                                  >
                                    <LinkIcon />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              margin: '2px 0 4px'
                            }}
                          >
                            <button
                              className="btn sm ghost"
                              disabled={testing === p.id}
                              onClick={() => void runTest(p)}
                              title="Check the URL, key and network path to this destination"
                            >
                              {testing === p.id ? 'Testing...' : 'Test destination'}
                            </button>
                            <span className="hint" style={{ margin: 0 }}>
                              Resolves the host, opens a connection and reports what fails.
                            </span>
                          </div>

                          {reports[p.id] && (
                            <div className="check-report">
                              {reports[p.id].map((c, i) => (
                                <div key={i} className={`check-row ${c.level}`}>
                                  {c.level === 'ok' ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
                                  <strong>{c.label}</strong>
                                  <span>{c.detail}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="section-label">Video</div>

                          <div className="row c2">
                            <div className="field">
                              <label>Delivery mode</label>
                              <select
                                className="input"
                                value={p.video.mode}
                                onChange={(e) =>
                                  patchVideo(p.id, { mode: e.target.value as 'copy' | 'reencode' })
                                }
                              >
                                <option value="copy">Passthrough (no re-encode)</option>
                                <option value="reencode">Re-encode to target bitrate</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>Video bitrate (kbps)</label>
                              <input
                                className="input mono"
                                type="number"
                                min={500}
                                max={51000}
                                step={100}
                                disabled={p.video.mode === 'copy'}
                                value={p.video.videoBitrate}
                                onChange={(e) =>
                                  patchVideo(p.id, { videoBitrate: Number(e.target.value) })
                                }
                              />
                            </div>
                          </div>

                          <div className="row c3">
                            <div className="field">
                              <label>Encoder</label>
                              <select
                                className="input"
                                disabled={p.video.mode === 'copy'}
                                value={p.video.encoder}
                                onChange={(e) =>
                                  patchVideo(p.id, { encoder: e.target.value as EncoderKind })
                                }
                              >
                                <option value="auto">Auto</option>
                                <option value="x264">x264 (CPU)</option>
                                <option value="nvenc">NVENC (NVIDIA)</option>
                                <option value="qsv">QuickSync (Intel)</option>
                                <option value="amf">AMF (AMD)</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>Resolution</label>
                              <select
                                className="input"
                                disabled={p.video.mode === 'copy'}
                                value={p.video.scale}
                                onChange={(e) => patchVideo(p.id, { scale: e.target.value })}
                              >
                                <option value="">Source</option>
                                <option value="1920x1080">1920x1080</option>
                                <option value="1280x720">1280x720</option>
                                <option value="854x480">854x480</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>Frame rate</label>
                              <select
                                className="input"
                                disabled={p.video.mode === 'copy'}
                                value={p.video.fps}
                                onChange={(e) => patchVideo(p.id, { fps: Number(e.target.value) })}
                              >
                                <option value={0}>Source</option>
                                <option value={60}>60 fps</option>
                                <option value={30}>30 fps</option>
                                <option value={24}>24 fps</option>
                              </select>
                            </div>
                          </div>

                          <div className="row c3">
                            <div className="field">
                              <label>Buffer size (kbps)</label>
                              <input
                                className="input mono"
                                type="number"
                                min={0}
                                step={100}
                                disabled={p.video.mode === 'copy'}
                                placeholder="auto"
                                value={p.video.bufferSize}
                                onChange={(e) =>
                                  patchVideo(p.id, { bufferSize: Number(e.target.value) })
                                }
                              />
                            </div>
                            <div className="field">
                              <label>Audio bitrate (kbps)</label>
                              <input
                                className="input mono"
                                type="number"
                                min={0}
                                step={32}
                                disabled={p.video.mode === 'copy'}
                                placeholder="0 = copy"
                                value={p.video.audioBitrate}
                                onChange={(e) =>
                                  patchVideo(p.id, { audioBitrate: Number(e.target.value) })
                                }
                              />
                            </div>
                            <div className="field">
                              <label>Keyframe (sec)</label>
                              <input
                                className="input mono"
                                type="number"
                                min={1}
                                max={10}
                                disabled={p.video.mode === 'copy'}
                                value={p.video.keyframeInterval}
                                onChange={(e) =>
                                  patchVideo(p.id, { keyframeInterval: Number(e.target.value) })
                                }
                              />
                            </div>
                          </div>

                          {preset && preset.recommendedBitrate > 0 && (
                            <div className="hint">
                              {preset.name} accepts up to about{' '}
                              <strong style={{ color: 'var(--text-dim)' }}>
                                {preset.recommendedBitrate.toLocaleString()} kbps
                              </strong>
                              . Passthrough keeps whatever Streamlabs sends.
                            </div>
                          )}

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              marginTop: 16,
                              paddingTop: 14,
                              borderTop: '1px solid var(--stroke)'
                            }}
                          >
                            <Check
                              checked={p.enabled}
                              onChange={(v) => patchPlatform(p.id, { enabled: v })}
                              title="Enabled"
                              description="Include this destination when going live"
                            />
                            <div className="spacer" />
                            <button
                              className="btn sm ghost"
                              style={{ color: 'var(--live)' }}
                              onClick={() => onRemovePlatform(p.id)}
                            >
                              <TrashIcon />
                              Remove
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}

              <div style={{ position: 'relative', marginTop: 6 }}>
                <button className="btn" onClick={() => setShowAdd((v) => !v)}>
                  <PlusIcon />
                  Add destination
                </button>
                <AnimatePresence>
                  {showAdd && (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      style={{
                        position: 'absolute',
                        top: 40,
                        left: 0,
                        zIndex: 5,
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        padding: 8,
                        borderRadius: 'var(--r-md)',
                        background: '#171a29',
                        border: '1px solid var(--stroke-hi)',
                        boxShadow: 'var(--shadow)'
                      }}
                    >
                      {PLATFORM_PRESETS.map((preset) => (
                        <button
                          key={preset.kind}
                          className="chip on"
                          style={{ ['--pc' as string]: PLATFORM_COLORS[preset.kind], height: 30 }}
                          onClick={() => {
                            onAddPlatform(preset.kind)
                            setShowAdd(false)
                          }}
                        >
                          <PlatformIcon kind={preset.kind} size={13} />
                          {preset.name}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          )}

          {tab === 'chat' && (
            <>
              {chatPlatforms.length === 0 && (
                <div className="hint">
                  Chat reading is available for Twitch, YouTube and Kick destinations. Add one on
                  the Destinations tab.
                </div>
              )}
              {chatPlatforms.map((p) => (
                <div
                  key={p.id}
                  className="plat-editor"
                  style={{ ['--pc' as string]: PLATFORM_COLORS[p.kind], padding: '14px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
                    <div className="pcard-icon" style={{ width: 32, height: 32 }}>
                      <PlatformIcon kind={p.kind} size={17} />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{p.name}</div>
                    <Check
                      checked={p.chat.enabled}
                      onChange={(v) => patchChat(p.id, { enabled: v })}
                      title="Read chat"
                    />
                  </div>

                  {p.kind === 'twitch' && (
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Twitch channel</label>
                      <input
                        className="input mono"
                        placeholder="your_channel_name"
                        value={p.chat.twitchChannel ?? ''}
                        onChange={(e) => patchChat(p.id, { twitchChannel: e.target.value })}
                      />
                      <div className="hint" style={{ marginTop: 6 }}>
                        Read-only anonymous connection &mdash; no login or token required.
                      </div>
                    </div>
                  )}

                  {p.kind === 'kick' && (
                    <>
                      <div className="field">
                        <label>Kick channel</label>
                        <input
                          className="input mono"
                          placeholder="your_channel_name"
                          value={p.chat.kickChannel ?? ''}
                          onChange={(e) => patchChat(p.id, { kickChannel: e.target.value })}
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label>Chatroom id (only if the lookup is blocked)</label>
                        <input
                          className="input mono"
                          placeholder="auto-detected from the channel name"
                          value={p.chat.kickChatroomId ?? ''}
                          onChange={(e) => patchChat(p.id, { kickChatroomId: e.target.value })}
                        />
                      </div>
                      <div className="hint" style={{ marginTop: 8 }}>
                        Read-only, no login required. Kick puts the channel lookup behind
                        Cloudflare, so if the feed reports a challenge, open{' '}
                        <span className="mono">kick.com/api/v2/channels/your_channel</span> in a
                        browser and paste the <span className="mono">chatroom.id</span> above.
                      </div>
                    </>
                  )}

                  {p.kind === 'youtube' && (
                    <>
                      <div className="field">
                        <label>YouTube Data API key</label>
                        <input
                          className="input mono"
                          type="password"
                          placeholder="AIza..."
                          value={p.chat.youtubeApiKey ?? ''}
                          onChange={(e) => patchChat(p.id, { youtubeApiKey: e.target.value })}
                        />
                      </div>
                      <div className="row c2">
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label>Live video id or URL</label>
                          <input
                            className="input mono"
                            placeholder="dQw4w9WgXcQ"
                            value={p.chat.youtubeVideoId ?? ''}
                            onChange={(e) => patchChat(p.id, { youtubeVideoId: e.target.value })}
                          />
                        </div>
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label>...or channel id (auto-detect)</label>
                          <input
                            className="input mono"
                            placeholder="UCxxxxxxxxxxxxxxxx"
                            value={p.chat.youtubeChannelId ?? ''}
                            onChange={(e) => patchChat(p.id, { youtubeChannelId: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="hint" style={{ marginTop: 8 }}>
                        Create a key in Google Cloud Console with the YouTube Data API v3 enabled.
                        Polling respects the interval the API returns to protect your quota.
                      </div>
                    </>
                  )}
                </div>
              ))}
            </>
          )}

          {tab === 'app' && (
            <>
              <div className="section-label">Local ingest (point Streamlabs here)</div>
              <div className="row c2">
                <div className="field">
                  <label>RTMP port</label>
                  <input
                    className="input mono"
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.settings.rtmpPort}
                    onChange={(e) => patchSettings({ rtmpPort: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>Preview / HTTP port</label>
                  <input
                    className="input mono"
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.settings.httpPort}
                    onChange={(e) => patchSettings({ httpPort: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="row c2">
                <div className="field">
                  <label>Application path</label>
                  <input
                    className="input mono"
                    value={draft.settings.ingestApp}
                    onChange={(e) => patchSettings({ ingestApp: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Local stream key</label>
                  <input
                    className="input mono"
                    value={draft.settings.ingestKey}
                    onChange={(e) => patchSettings({ ingestKey: e.target.value })}
                  />
                </div>
              </div>
              <div className="hint">
                Streamlabs server:{' '}
                <strong style={{ color: 'var(--accent-2)', fontFamily: 'var(--mono)' }}>
                  rtmp://localhost:{draft.settings.rtmpPort}/{draft.settings.ingestApp}
                </strong>{' '}
                &middot; key:{' '}
                <strong style={{ color: 'var(--accent-2)', fontFamily: 'var(--mono)' }}>
                  {draft.settings.ingestKey}
                </strong>
              </div>

              <div className="section-label">Behaviour</div>
              <Check
                checked={draft.settings.autoStartOnIngest}
                onChange={(v) => patchSettings({ autoStartOnIngest: v })}
                title="Go live automatically"
                description="Start every enabled destination as soon as Streamlabs connects"
              />
              <Check
                checked={draft.settings.autoReconnect}
                onChange={(v) => patchSettings({ autoReconnect: v })}
                title="Auto-reconnect dropped destinations"
                description="Restart a relay if the platform drops the connection"
              />
              <div className="row c2" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>Reconnect delay (sec)</label>
                  <input
                    className="input mono"
                    type="number"
                    min={1}
                    max={120}
                    value={draft.settings.reconnectDelay}
                    onChange={(e) => patchSettings({ reconnectDelay: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>Chat buffer (messages)</label>
                  <input
                    className="input mono"
                    type="number"
                    min={50}
                    max={5000}
                    step={50}
                    value={draft.settings.chatBufferSize}
                    onChange={(e) => patchSettings({ chatBufferSize: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div className="section-label">Encoding</div>
              <div className="field">
                <label>ffmpeg executable</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input mono"
                    placeholder={ffmpegPath}
                    value={draft.settings.ffmpegPath}
                    onChange={(e) => patchSettings({ ffmpegPath: e.target.value })}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      const picked = await window.hydracast.pickFfmpeg()
                      if (picked) patchSettings({ ffmpegPath: picked })
                    }}
                  >
                    Browse
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  Active: <span style={{ fontFamily: 'var(--mono)' }}>{ffmpegPath}</span>
                  <br />
                  Detected encoders:{' '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent-2)' }}>
                    {encoders.length ? encoders.join(', ') : 'probing...'}
                  </span>
                </div>
              </div>

              <div className="section-label">Appearance</div>
              <div className="field">
                <label>Theme</label>
                <select
                  className="input"
                  value={draft.settings.theme}
                  onChange={(e) =>
                    patchSettings({ theme: e.target.value as AppSettings['theme'] })
                  }
                >
                  <option value="midnight">Midnight (violet)</option>
                  <option value="nebula">Nebula (magenta)</option>
                  <option value="carbon">Carbon (blue)</option>
                </select>
              </div>
              <Check
                checked={draft.settings.showPreview}
                onChange={(v) => patchSettings({ showPreview: v })}
                title="Show stream preview"
                description="Disable to save a little CPU on lower-end machines"
              />
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="hint">
            Changes to ports restart the ingest server. Bitrate changes apply on the next start of
            that destination.
          </span>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(draft)}>
            <CheckIcon />
            Save changes
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
