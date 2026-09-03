import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import type { AppSettings, Platform, RelayStats, RelayStatus } from '@shared/types'
import { measureLatency, parseEndpoint } from './latency'
import { hasErrors, probeDestination, summarise, validateDestination } from './diagnose'

const HISTORY = 40
/** Lines of ffmpeg stderr kept for the failure report. */
const STDERR_TAIL = 40
/**
 * How many times a relay may fail *before ever going live* before we stop
 * retrying. A destination that never connects is a configuration problem, and
 * looping on it forever is what hid the real error.
 */
const MAX_START_FAILURES = 3
/** stderr lines worth surfacing in the activity log while a relay is healthy. */
const SIGNIFICANT = /error|failed|unable|refused|invalid|denied|timed out|cannot/i

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
    // No -nostdin: stop() quits ffmpeg by writing "q" to its stdin, which a
    // dedicated pipe makes safe and which -nostdin would silently ignore.
    '-loglevel',
    'warning',
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
  /** True once media actually reached the platform on this attempt. */
  wentLive: boolean
  /** Consecutive failures that never reached `live`. */
  startFailures: number
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
  /** Whether an encoder is currently publishing into the local ingest. */
  private sourcePublishing = false
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

  /**
   * Relays can be armed before Streamlabs connects. While that is the case a
   * failed start is a missing source, not a broken destination, so it must not
   * spend the retry budget or trigger a destination report.
   */
  setSourcePublishing(publishing: boolean): void {
    this.sourcePublishing = publishing
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
          stopping: false,
          wentLive: false,
          startFailures: 0
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

  /** A user-initiated start clears the retry budget left by an earlier failure. */
  async start(platformId: string): Promise<void> {
    const relay = this.relays.get(platformId)
    if (relay) relay.startFailures = 0
    await this.launch(platformId)
  }

  private async launch(platformId: string): Promise<void> {
    const relay = this.relays.get(platformId)
    if (!relay) return
    if (relay.proc) return
    const platform = relay.platform

    // Config problems are caught here rather than left to ffmpeg, whose
    // handshake errors say nothing about which field is actually wrong.
    const checks = validateDestination(platform)
    for (const c of checks) {
      if (c.level === 'ok') continue
      this.emit('log', c.level === 'error' ? 'error' : 'warn', `${platform.name}: ${c.detail}`)
    }
    if (hasErrors(checks)) {
      this.setStatus(relay, 'error', summarise(checks))
      return
    }

    relay.stopping = false
    relay.stderrTail = []
    relay.wentLive = false
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
        if (relay.stderrTail.length > STDERR_TAIL) relay.stderrTail.shift()
        // A healthy relay still chatters at warning level. Those lines stay in
        // the tail for the failure report but out of the activity log; anything
        // logged before the relay is live is worth surfacing immediately.
        if (relay.wentLive && !SIGNIFICANT.test(line)) continue
        relay.stats.error = line
        this.emit('log', relay.wentLive ? 'warn' : 'error', `${platform.name}: ${line}`)
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

      // A relay that never reached `live` has a configuration or connectivity
      // problem, not a blip. Say what ffmpeg actually reported, probe the
      // network path, and stop retrying rather than hiding the cause in a loop.
      if (!relay.wentLive) {
        if (!this.sourcePublishing) {
          if (!this.settings.autoReconnect) {
            this.setStatus(relay, 'error', 'No encoder is publishing into the local ingest')
            this.emit('log', 'error', `${platform.name}: no encoder is publishing yet`)
            return
          }
          this.setStatus(relay, 'reconnecting', 'Waiting for the encoder')
          this.emit('log', 'info', `${platform.name}: waiting for Streamlabs to publish`)
          relay.reconnectTimer = setTimeout(
            () => void this.launch(platformId),
            Math.max(1, this.settings.reconnectDelay) * 1000
          )
          return
        }

        relay.startFailures += 1
        if (relay.startFailures === 1) void this.report(relay, args, code)

        const exhausted = relay.startFailures >= MAX_START_FAILURES
        if (!this.settings.autoReconnect || exhausted) {
          this.setStatus(relay, 'error', detail)
          if (exhausted) {
            this.emit(
              'log',
              'error',
              `${platform.name}: never connected after ${relay.startFailures} attempts - fix the destination, then press Start`
            )
          }
          return
        }
        // Back off between attempts. A platform that has just lost a session
        // often holds it open for another half-minute and rejects a reconnect
        // with the same key, so hammering every 5 s keeps the loop alive.
        const delay = Math.min(
          60,
          Math.max(1, this.settings.reconnectDelay) * 2 ** (relay.startFailures - 1)
        )
        relay.stats.reconnects += 1
        this.setStatus(relay, 'reconnecting', detail)
        this.emit(
          'log',
          'warn',
          `${platform.name}: connect attempt ${relay.startFailures} failed - retrying in ${delay}s`
        )
        relay.reconnectTimer = setTimeout(() => void this.launch(platformId), delay * 1000)
        return
      }

      if (this.settings.autoReconnect) {
        relay.stats.reconnects += 1
        this.setStatus(relay, 'reconnecting', detail)
        this.emit(
          'log',
          'warn',
          `${platform.name}: relay dropped - retrying in ${this.settings.reconnectDelay}s`
        )
        relay.reconnectTimer = setTimeout(
          () => void this.launch(platformId),
          Math.max(1, this.settings.reconnectDelay) * 1000
        )
      } else {
        this.setStatus(relay, 'error', detail)
        this.emit('log', 'error', `${platform.name}: ${detail}`)
      }
    })
  }

  /**
   * Dumps everything known about a failed start: the redacted ffmpeg command,
   * the captured stderr, and a live probe of the destination edge. This is the
   * report that used to be missing entirely.
   */
  private async report(relay: Relay, args: string[], code: number | null): Promise<void> {
    const name = relay.platform.name
    const key = relay.platform.streamKey.trim()
    const redacted = args
      .map((a) => (key && a.includes(key) ? a.replace(key, '<stream-key>') : a))
      .join(' ')

    this.emit('log', 'error', `${name}: relay never connected (ffmpeg exit ${code ?? 'unknown'})`)
    this.emit('log', 'info', `${name}: command was ffmpeg ${redacted}`)
    if (relay.stderrTail.length) {
      for (const line of relay.stderrTail) this.emit('log', 'error', `${name}: ffmpeg | ${line}`)
    } else {
      this.emit('log', 'warn', `${name}: ffmpeg exited without printing anything`)
    }

    for (const check of await probeDestination(relay.platform)) {
      const level = check.level === 'error' ? 'error' : check.level === 'warn' ? 'warn' : 'info'
      this.emit('log', level, `${name}: ${check.label} - ${check.detail}`)
    }
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
            relay.wentLive = true
            relay.startFailures = 0
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
