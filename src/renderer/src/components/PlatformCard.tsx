import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { EncodeMode, EncoderKind, Platform, RelayStats } from '@shared/types'
import { PLATFORM_PRESETS } from '@shared/types'
import {
  AlertIcon,
  ChevronIcon,
  PlatformIcon,
  PLATFORM_COLORS,
  PlayIcon,
  SettingsIcon,
  StopIcon
} from '../icons'
import Sparkline from './Sparkline'

interface Props {
  platform: Platform
  stats?: RelayStats
  encoders: string[]
  onPatch: (patch: Partial<Platform>) => void
  onStart: () => void
  onStop: () => void
  onConfigure: () => void
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Offline',
  starting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  error: 'Error',
  stopping: 'Stopping'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url || 'not configured'
  }
}

function latencyClass(ms: number): string {
  if (ms < 0) return ''
  if (ms < 60) return 'good'
  if (ms < 150) return 'warn'
  return 'bad'
}

export default function PlatformCard({
  platform,
  stats,
  encoders,
  onPatch,
  onStart,
  onStop,
  onConfigure
}: Props) {
  const [expanded, setExpanded] = useState(false)
  // The slider updates locally while dragging and commits once on release, so a
  // drag does not fire an IPC round trip and a config write per pixel.
  const [draftBitrate, setDraftBitrate] = useState(platform.video.videoBitrate)
  const [dragging, setDragging] = useState(false)
  const shownBitrate = dragging ? draftBitrate : platform.video.videoBitrate
  const color = PLATFORM_COLORS[platform.kind]
  const status = stats?.status ?? 'idle'
  const isLive = status === 'live'
  const isBusy = status === 'starting' || status === 'reconnecting' || status === 'stopping'
  const recommended =
    PLATFORM_PRESETS.find((p) => p.kind === platform.kind)?.recommendedBitrate ?? 6000

  const health = stats?.health ?? 0
  const healthClass = health >= 75 ? '' : health >= 45 ? 'warn' : 'bad'

  const patchVideo = (patch: Partial<Platform['video']>): void =>
    onPatch({ video: { ...platform.video, ...patch } })

  const dotClass = isLive
    ? 'live'
    : status === 'error'
      ? 'err'
      : status === 'reconnecting'
        ? 'warn'
        : platform.enabled
          ? 'ok'
          : ''

  return (
    <motion.div
      layout
      className={`pcard ${isLive ? 'is-live' : ''} ${platform.enabled ? '' : 'disabled'}`}
      style={{ ['--pc' as string]: color }}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      whileHover={{ y: -2 }}
    >
      <div className="pcard-glow" />

      <div className="pcard-head">
        <div className="pcard-icon">
          <PlatformIcon kind={platform.kind} size={21} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pcard-name">
            {platform.name}
            <span className={`dot ${dotClass}`} />
          </div>
          <div className="pcard-sub">{hostOf(platform.url)}</div>
        </div>
        <button
          className={`toggle ${platform.enabled ? 'on' : ''}`}
          onClick={() => onPatch({ enabled: !platform.enabled })}
          title={platform.enabled ? 'Disable destination' : 'Enable destination'}
        >
          <motion.span
            className="toggle-knob"
            animate={{ x: platform.enabled ? 18 : 0 }}
            transition={{ type: 'spring', stiffness: 520, damping: 32 }}
          />
        </button>
      </div>

      <div className="health-bar">
        <motion.div
          className={`health-fill ${healthClass}`}
          animate={{ width: `${isLive ? health : 0}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>

      <div className="pcard-metrics">
        <div className="metric">
          <div className="k">Latency</div>
          <div className={`v ${latencyClass(stats?.latencyMs ?? -1)}`}>
            {stats && stats.latencyMs >= 0 ? stats.latencyMs : '--'}
            <small>ms</small>
          </div>
        </div>
        <div className="metric">
          <div className="k">Outgoing</div>
          <div className="v">
            {isLive ? (stats?.bitrateKbps ?? 0).toLocaleString() : '--'}
            <small>kbps</small>
          </div>
        </div>
        <div className="metric">
          <div className="k">{isLive ? 'Dropped' : 'Status'}</div>
          <div className={`v ${stats?.droppedFrames ? 'warn' : ''}`}>
            {isLive ? (
              <>
                {stats?.droppedFrames ?? 0}
                <small>frames</small>
              </>
            ) : (
              <span style={{ fontSize: 12, letterSpacing: 0 }}>{STATUS_LABEL[status]}</span>
            )}
          </div>
        </div>
      </div>

      <Sparkline
        data={
          isLive && (stats?.bitrateHistory.length ?? 0) > 1
            ? stats!.bitrateHistory
            : (stats?.latencyHistory ?? [])
        }
        color={color}
      />

      {status === 'error' && stats?.error && (
        <div
          style={{
            display: 'flex',
            gap: 7,
            alignItems: 'flex-start',
            fontSize: 11,
            color: 'var(--live)',
            margin: '8px 0 2px',
            lineHeight: 1.45
          }}
        >
          <AlertIcon size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{stats.error}</span>
        </div>
      )}

      <div className="pcard-foot" style={{ marginTop: 10 }}>
        <button
          className={`mode-chip ${platform.video.mode === 'reencode' ? 'encode' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title="Video bitrate for this destination"
        >
          {platform.video.mode === 'copy'
            ? 'passthrough'
            : `${shownBitrate.toLocaleString()}k`}
          <motion.span
            animate={{ rotate: expanded ? 180 : 0 }}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <ChevronIcon size={13} />
          </motion.span>
        </button>

        <div className="spacer" />

        <button className="btn icon sm ghost" onClick={onConfigure} title="Configure keys and URL">
          <SettingsIcon size={15} />
        </button>

        {isLive || isBusy ? (
          <button className="btn sm danger" onClick={onStop} disabled={status === 'stopping'}>
            <StopIcon size={12} />
            Stop
          </button>
        ) : (
          <button
            className="btn sm"
            onClick={onStart}
            disabled={!platform.enabled || !platform.streamKey}
            title={!platform.streamKey ? 'Add a stream key first' : 'Start this destination'}
          >
            <PlayIcon size={12} />
            Start
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="bitrate-editor"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="seg">
              {(['copy', 'reencode'] as EncodeMode[]).map((mode) => (
                <button
                  key={mode}
                  className={platform.video.mode === mode ? 'active' : ''}
                  onClick={() => patchVideo({ mode })}
                  style={{ position: 'relative', zIndex: 1 }}
                >
                  {platform.video.mode === mode && (
                    <motion.span
                      className="seg-ind"
                      layoutId={`seg-${platform.id}`}
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  {mode === 'copy' ? 'Passthrough' : 'Re-encode'}
                </button>
              ))}
            </div>

            {platform.video.mode === 'copy' ? (
              <div className="hint">
                Forwards the Streamlabs feed untouched &mdash; no CPU cost, and every destination
                gets the same bitrate.
              </div>
            ) : (
              <>
                <div className="slider-row">
                  <input
                    type="range"
                    min={500}
                    max={12000}
                    step={100}
                    value={shownBitrate}
                    onPointerDown={() => {
                      setDraftBitrate(platform.video.videoBitrate)
                      setDragging(true)
                    }}
                    onChange={(e) => setDraftBitrate(Number(e.target.value))}
                    onPointerUp={() => {
                      setDragging(false)
                      patchVideo({ videoBitrate: draftBitrate })
                    }}
                    onKeyUp={() => {
                      setDragging(false)
                      patchVideo({ videoBitrate: draftBitrate })
                    }}
                    style={{
                      background: `linear-gradient(90deg, ${color} ${
                        ((shownBitrate - 500) / 11500) * 100
                      }%, rgba(255,255,255,0.1) ${
                        ((shownBitrate - 500) / 11500) * 100
                      }%)`
                    }}
                  />
                  <div className="bitrate-value" style={{ color }}>
                    {shownBitrate.toLocaleString()}
                    <span style={{ color: 'var(--text-faint)', fontSize: 10 }}> kbps</span>
                  </div>
                </div>

                <div className="row c2">
                  <div>
                    <label
                      style={{
                        fontSize: 10,
                        color: 'var(--text-faint)',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase'
                      }}
                    >
                      Encoder
                    </label>
                    <select
                      className="input"
                      style={{ height: 30, marginTop: 4 }}
                      value={platform.video.encoder}
                      onChange={(e) => patchVideo({ encoder: e.target.value as EncoderKind })}
                    >
                      <option value="auto">Auto</option>
                      {encoders.includes('x264') && <option value="x264">x264 (CPU)</option>}
                      {encoders.includes('nvenc') && <option value="nvenc">NVENC (NVIDIA)</option>}
                      {encoders.includes('qsv') && <option value="qsv">QuickSync (Intel)</option>}
                      {encoders.includes('amf') && <option value="amf">AMF (AMD)</option>}
                    </select>
                  </div>
                  <div>
                    <label
                      style={{
                        fontSize: 10,
                        color: 'var(--text-faint)',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase'
                      }}
                    >
                      Resolution
                    </label>
                    <select
                      className="input"
                      style={{ height: 30, marginTop: 4 }}
                      value={platform.video.scale}
                      onChange={(e) => patchVideo({ scale: e.target.value })}
                    >
                      <option value="">Source</option>
                      <option value="1920x1080">1080p</option>
                      <option value="1280x720">720p</option>
                      <option value="854x480">480p</option>
                    </select>
                  </div>
                </div>

                <div className="hint">
                  {platform.name} recommends up to{' '}
                  <strong style={{ color: 'var(--text-dim)' }}>
                    {recommended.toLocaleString()} kbps
                  </strong>
                  . Changes apply the next time this destination starts.
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
