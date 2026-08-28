import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import type { AppSettings, Platform, RelayStats, RelayStatus } from '@shared/types'
import { measureLatency, parseEndpoint } from './latency'

const HISTORY = 40

/** Resolves ffmpeg: explicit setting, then the bundled binary, then PATH. */
export function resolveFfmpeg(settings: AppSettings): string {
  if (settings.ffmpegPath && fs.existsSync(settings.ffmpegPath)) return settings.ffmpegPath
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundled: string = require('ffmpeg-static')
    if (bundled) {
      // Inside an asar archive the binary must be run from the unpacked copy.
      const unpacked = bundled.replace('app.asar', 'app.asar.unpacked')
      if (fs.existsSync(unpacked)) return unpacked
      if (fs.existsSync(bundled)) return bundled
    }
  } catch {
    /* fall through to PATH */
  }
  return 'ffmpeg'
}

function joinUrl(url: string, key: string): string {
  const base = url.trim().replace(/\/+$/, '')
  const k = key.trim()
  if (!k) return base
  return `${base}/${k}`
}

/** Maps the encoder choice onto an ffmpeg encoder name. */
function encoderName(platform: Platform): string {
  switch (platform.video.encoder) {
    case 'nvenc':
      return 'h264_nvenc'
    case 'qsv':
      return 'h264_qsv'
    case 'amf':
      return 'h264_amf'
    case 'x264':
      return 'libx264'
    case 'auto':
    default:
      return process.platform === 'win32' ? 'h264_nvenc' : 'libx264'
  }
}

/**
 * Builds the ffmpeg command for one destination.
 *
 * `copy` mode remuxes only - no CPU cost, and the destination receives exactly
 * the bitrate Streamlabs produced. `reencode` mode transcodes video to the
 * per-platform target bitrate with CBR-style rate control, which is what lets
 * one 8000k source feed a 6000k Twitch and a 4000k Facebook simultaneously.
 */
export function buildArgs(platform: Platform, sourceUrl: string, sourceFps: number): string[] {
  const v = platform.video
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts',
    '-rtmp_live',
    'live',
    '-i',
    sourceUrl
  ]

  if (v.mode === 'copy') {
    args.push('-c:v', 'copy', '-c:a', 'copy')
  } else {
    const enc = encoderName(platform)
    const bitrate = Math.max(100, Math.round(v.videoBitrate))
    const bufsize = v.bufferSize > 0 ? Math.round(v.bufferSize) : bitrate * 2
    const fps = v.fps > 0 ? v.fps : sourceFps > 0 ? Math.round(sourceFps) : 30
    const gop = Math.max(1, Math.round(fps * (v.keyframeInterval || 2)))

    args.push('-c:v', enc)

    if (enc === 'libx264') {
      args.push('-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p')
      // nal-hrd cbr keeps the muxed rate flat, which platforms prefer.
      args.push('-x264-params', `nal-hrd=cbr:keyint=${gop}:min-keyint=${gop}:scenecut=0`)
    } else if (enc === 'h264_nvenc') {
      args.push('-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'high')
    } else if (enc === 'h264_qsv') {
      args.push('-preset', 'veryfast', '-profile:v', 'high')
    } else if (enc === 'h264_amf') {
      args.push('-quality', 'speed', '-rc', 'cbr', '-profile:v', 'high')
    }

    args.push(
      '-b:v',
      `${bitrate}k`,
      '-maxrate',
      `${bitrate}k`,
      '-minrate',
      `${bitrate}k`,
      '-bufsize',
      `${bufsize}k`,
      '-g',
      String(gop),
      '-keyint_min',
      String(gop)
    )

    const filters: string[] = []
    if (v.scale.trim()) {
      const m = v.scale.trim().match(/^(\d+)\s*[xX:]\s*(\d+)$/)
      if (m) filters.push(`scale=${m[1]}:${m[2]}`)
    }
    if (v.fps > 0) filters.push(`fps=${v.fps}`)
    if (filters.length) args.push('-vf', filters.join(','))

    if (v.audioBitrate > 0) {
      args.push('-c:a', 'aac', '-b:a', `${Math.round(v.audioBitrate)}k`, '-ar', '48000')
    } else {
      args.push('-c:a', 'copy')
    }
  }

  args.push(
    '-f',
    'flv',
    '-flvflags',
    'no_duration_filesize',
    '-progress',
    'pipe:1',
    '-nostats',
    joinUrl(platform.url, platform.streamKey)
  )
  return args
}

interface Relay {
  platform: Platform
  proc: ChildProcessWithoutNullStreams | null
  stats: RelayStats
  startedAt: number
  reconnectTimer: NodeJS.Timeout | null
  stderrTail: string[]
  /** Set while the user is intentionally stopping, to suppress auto-reconnect. */
  stopping: boolean
}

function blankStats(platformId: string): RelayStats {
  return {
    platformId,
    status: 'idle',
    latencyMs: -1,
    latencyHistory: [],
    bitrateKbps: 0,
    bitrateHistory: [],
    fps: 0,
    droppedFrames: 0,
    speed: 0,
    uptimeSec: 0,
    bytesSent: 0,
    reconnects: 0,
    health: 0
  }
}

function push(arr: number[], value: number): number[] {
  const next = [...arr, value]
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next
}

export class RelayManager extends EventEmitter {
  private relays = new Map<string, Relay>()
  private settings: AppSettings
  private sourceUrl = ''
  private sourceFps = 0
  private latencyTimer: NodeJS.Timeout | null = null

  constructor(settings: AppSettings) {
    super()
    this.settings = settings
    this.latencyTimer = setInterval(() => void this.probeLatency(), 5000)
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings
  }

  setSource(url: string, fps: number): void {
    this.sourceUrl = url
    this.sourceFps = fps
  }

  /** Keeps a stats entry alive for every configured platform, live or not. */
  syncPlatforms(platforms: Platform[]): void {
    for (const p of platforms) {
      const existing = this.relays.get(p.id)
      if (existing) {
        existing.platform = p
      } else {
        this.relays.set(p.id, {
          platform: p,
          proc: null,
          stats: blankStats(p.id),
          startedAt: 0,
          reconnectTimer: null,
          stderrTail: [],
          stopping: false
        })
      }
    }
    for (const id of [...this.relays.keys()]) {
      if (!platforms.some((p) => p.id === id)) {
        void this.stop(id)
        this.relays.delete(id)
      }
    }
  }

  getStats(): Record<string, RelayStats> {
    const out: Record<string, RelayStats> = {}
    for (const [id, relay] of this.relays) {
      const uptime =
        relay.stats.status === 'live' && relay.startedAt
          ? Math.floor((Date.now() - relay.startedAt) / 1000)
          : 0
      out[id] = { ...relay.stats, uptimeSec: uptime, health: this.health(relay) }
    }
    return out
  }

  isAnyLive(): boolean {
    for (const relay of this.relays.values()) {
      if (['live', 'starting', 'reconnecting'].includes(relay.stats.status)) return true
    }
    return false
  }

  private health(relay: Relay): number {
    const s = relay.stats
    if (s.status !== 'live') return 0
    let score = 100
    if (s.speed > 0 && s.speed < 0.98) score -= Math.min(45, (0.98 - s.speed) * 300)
    if (s.droppedFrames > 0) score -= Math.min(25, s.droppedFrames / 4)
    if (s.latencyMs > 120) score -= Math.min(20, (s.latencyMs - 120) / 15)
    score -= Math.min(15, s.reconnects * 5)
    return Math.max(0, Math.round(score))
  }

  private setStatus(relay: Relay, status: RelayStatus, error?: string): void {
    relay.stats.status = status
    relay.stats.error = error
    this.emit('status', relay.platform.id, status)
  }

  async start(platformId: string): Promise<void> {
    const relay = this.relays.get(platformId)
    if (!relay) return
    if (relay.proc) return
    const platform = relay.platform

    if (!platform.url.trim()) {
      this.setStatus(relay, 'error', 'No RTMP URL configured')
      this.emit('log', 'error', `${platform.name}: no RTMP URL configured`)
      return
    }
    if (!platform.streamKey.trim()) {
      this.setStatus(relay, 'error', 'No stream key configured')
      this.emit('log', 'error', `${platform.name}: no stream key configured`)
      return
    }

    relay.stopping = false
    relay.stderrTail = []
    this.setStatus(relay, 'starting')

    const bin = resolveFfmpeg(this.settings)
    const args = buildArgs(platform, this.sourceUrl, this.sourceFps)
    const modeLabel =
      platform.video.mode === 'copy'
        ? 'passthrough'
        : `${platform.video.videoBitrate}k ${encoderName(platform)}`
    this.emit('log', 'info', `${platform.name}: starting relay (${modeLabel})`)

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(bin, args, { windowsHide: true })
    } catch (err) {
      this.setStatus(relay, 'error', `Failed to launch ffmpeg: ${(err as Error).message}`)
      this.emit('log', 'error', `${platform.name}: ${(err as Error).message}`)
      return
    }

    relay.proc = proc
    relay.startedAt = Date.now()
    relay.stats.bitrateKbps = 0
    relay.stats.droppedFrames = 0

    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.parseProgress(relay, chunk))

    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (chunk: string) => {
      const lines = chunk.split(/\r?\n/).filter((l) => l.trim())
      for (const line of lines) {
        relay.stderrTail.push(line)
        if (relay.stderrTail.length > 12) relay.stderrTail.shift()
      }
      if (lines.length) {
        relay.stats.error = lines[lines.length - 1]
        this.emit('log', 'warn', `${platform.name}: ${lines[lines.length - 1]}`)
      }
    })

    proc.on('error', (err) => {
      this.setStatus(relay, 'error', err.message)
      this.emit('log', 'error', `${platform.name}: ${err.message}`)
    })

    proc.on('close', (code) => {
      relay.proc = null
      relay.stats.bitrateKbps = 0
      relay.stats.fps = 0
      relay.stats.speed = 0
      if (relay.stopping) {
        this.setStatus(relay, 'idle')
        this.emit('log', 'info', `${platform.name}: relay stopped`)
        return
      }
      const detail = relay.stderrTail[relay.stderrTail.length - 1] || `ffmpeg exited (${code})`
      if (this.settings.autoReconnect) {
        relay.stats.reconnects += 1
        this.setStatus(relay, 'reconnecting', detail)
        this.emit(
          'log',
          'warn',
          `${platform.name}: relay dropped - retrying in ${this.settings.reconnectDelay}s`
        )
        relay.reconnectTimer = setTimeout(
          () => void this.start(platformId),
          Math.max(1, this.settings.reconnectDelay) * 1000
        )
      } else {
        this.setStatus(relay, 'error', detail)
        this.emit('log', 'error', `${platform.name}: ${detail}`)
      }
    })
  }

  /** Consumes ffmpeg's `-progress` key=value stream. */
  private parseProgress(relay: Relay, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const idx = line.indexOf('=')
      if (idx < 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      switch (key) {
        case 'bitrate': {
          const n = parseFloat(value)
          if (!Number.isNaN(n)) {
            relay.stats.bitrateKbps = Math.round(n)
            relay.stats.bitrateHistory = push(relay.stats.bitrateHistory, Math.round(n))
          }
          break
        }
        case 'fps': {
          const n = parseFloat(value)
          if (!Number.isNaN(n)) relay.stats.fps = Math.round(n * 10) / 10
          break
        }
        case 'drop_frames': {
          const n = parseInt(value, 10)
          if (!Number.isNaN(n)) relay.stats.droppedFrames = n
          break
        }
        case 'total_size': {
          const n = parseInt(value, 10)
          if (!Number.isNaN(n)) relay.stats.bytesSent = n
          break
        }
        case 'speed': {
          const n = parseFloat(value.replace('x', ''))
          if (!Number.isNaN(n)) relay.stats.speed = n
          break
        }
        case 'progress': {
          // First progress block means media is actually flowing to the platform.
          if (relay.stats.status === 'starting' || relay.stats.status === 'reconnecting') {
            this.setStatus(relay, 'live')
            relay.startedAt = Date.now()
            this.emit('log', 'success', `${relay.platform.name}: LIVE`)
          }
          break
        }
      }
    }
  }

  async stop(platformId: string): Promise<void> {
    const relay = this.relays.get(platformId)
    if (!relay) return
    relay.stopping = true
    if (relay.reconnectTimer) {
      clearTimeout(relay.reconnectTimer)
      relay.reconnectTimer = null
    }
    if (relay.proc) {
      this.setStatus(relay, 'stopping')
      const proc = relay.proc
      try {
        proc.stdin.write('q')
      } catch {
        /* ffmpeg may already be gone */
      }
      const killed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2500)
        proc.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* nothing else to do */
        }
      }
    }
    relay.proc = null
    relay.stats = { ...blankStats(platformId), latencyHistory: relay.stats.latencyHistory }
    this.setStatus(relay, 'idle')
  }

  async startAll(platforms: Platform[]): Promise<void> {
    for (const p of platforms.filter((p) => p.enabled)) {
      await this.start(p.id)
      // Stagger so several ffmpeg handshakes do not contend for the same
      // local RTMP session at once.
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.relays.keys()].map((id) => this.stop(id)))
  }

  /** Background TCP probe of every configured destination edge. */
  private async probeLatency(): Promise<void> {
    for (const relay of this.relays.values()) {
      const endpoint = parseEndpoint(relay.platform.url)
      if (!endpoint) {
        relay.stats.latencyMs = -1
        continue
      }
      const ms = await measureLatency(endpoint)
      relay.stats.latencyMs = ms
      if (ms >= 0) relay.stats.latencyHistory = push(relay.stats.latencyHistory, ms)
    }
  }

  dispose(): void {
    if (this.latencyTimer) clearInterval(this.latencyTimer)
    this.latencyTimer = null
    for (const relay of this.relays.values()) {
      if (relay.reconnectTimer) clearTimeout(relay.reconnectTimer)
      relay.stopping = true
      relay.proc?.kill()
    }
    this.relays.clear()
  }
}

/** Probes which hardware encoders this machine's ffmpeg actually supports. */
export async function detectEncoders(settings: AppSettings): Promise<string[]> {
  const bin = resolveFfmpeg(settings)
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-hide_banner', '-encoders'], { windowsHide: true })
    let out = ''
    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (out += d.toString()))
    proc.on('error', () => resolve([]))
    proc.on('close', () => {
      const found: string[] = ['x264']
      if (out.includes('h264_nvenc')) found.push('nvenc')
      if (out.includes('h264_qsv')) found.push('qsv')
      if (out.includes('h264_amf')) found.push('amf')
      resolve(found)
    })
  })
}
