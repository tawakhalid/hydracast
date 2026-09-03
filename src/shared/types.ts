/**
 * Shared contract between the Electron main process and the renderer.
 * Everything crossing the IPC bridge is typed here.
 */

export type PlatformKind =
  | 'twitch'
  | 'youtube'
  | 'kick'
  | 'facebook'
  | 'trovo'
  | 'tiktok'
  | 'custom'

/** How a platform's video is delivered to the destination. */
export type EncodeMode = 'copy' | 'reencode'

/** Hardware/software encoder used when `mode === 'reencode'`. */
export type EncoderKind = 'auto' | 'x264' | 'nvenc' | 'qsv' | 'amf'

export interface PlatformVideoSettings {
  /** `copy` = passthrough (no CPU, keeps the Streamlabs bitrate). `reencode` = target bitrate below. */
  mode: EncodeMode
  /** Target video bitrate in kbps. Only used when mode === 'reencode'. */
  videoBitrate: number
  /** Encoder buffer size in kbps. 0 = derive from bitrate. */
  bufferSize: number
  /** Audio bitrate in kbps. 0 = copy the source audio track. */
  audioBitrate: number
  encoder: EncoderKind
  /** Optional downscale, e.g. 1280x720. Empty string = keep source resolution. */
  scale: string
  /** Optional fps cap. 0 = keep source. */
  fps: number
  /** Keyframe interval in seconds (most platforms want 2). */
  keyframeInterval: number
}

export interface ChatConfig {
  enabled: boolean
  /** Twitch channel login name, without the leading hash. */
  twitchChannel?: string
  /** YouTube Data API v3 key. */
  youtubeApiKey?: string
  /** YouTube video id of the live broadcast. */
  youtubeVideoId?: string
  /** YouTube channel id, used to auto-discover the active live broadcast. */
  youtubeChannelId?: string
  /** Kick channel slug, e.g. `xqc` from kick.com/xqc. */
  kickChannel?: string
  /**
   * Numeric Kick chatroom id. Normally resolved from the slug automatically;
   * set this by hand when Cloudflare blocks the lookup.
   */
  kickChatroomId?: string
}

export interface Platform {
  id: string
  kind: PlatformKind
  /** Display name shown on the card. */
  name: string
  /** RTMP/RTMPS ingest URL, e.g. rtmp://live.twitch.tv/app */
  url: string
  /** Stream key appended to the URL. */
  streamKey: string
  /** Whether this destination participates in the current broadcast. */
  enabled: boolean
  video: PlatformVideoSettings
  chat: ChatConfig
}

export interface AppSettings {
  /** Port the local RTMP ingest server listens on - point Streamlabs here. */
  rtmpPort: number
  /** Port for the HTTP-FLV preview endpoint. */
  httpPort: number
  /** Local ingest application name (rtmp://localhost:PORT/<app>). */
  ingestApp: string
  /** Local ingest stream key Streamlabs must publish under. */
  ingestKey: string
  /** Absolute path to ffmpeg.exe. Empty = use the bundled binary. */
  ffmpegPath: string
  /** Auto-start every enabled destination as soon as Streamlabs connects. */
  autoStartOnIngest: boolean
  /** Restart a relay automatically if ffmpeg dies while live. */
  autoReconnect: boolean
  /** Reconnect back-off in seconds. */
  reconnectDelay: number
  /** Keep at most this many chat messages in memory. */
  chatBufferSize: number
  showPreview: boolean
  theme: 'midnight' | 'nebula' | 'carbon'
}

export interface AppConfig {
  settings: AppSettings
  platforms: Platform[]
}

export type RelayStatus =
  | 'idle'
  | 'starting'
  | 'live'
  | 'reconnecting'
  | 'error'
  | 'stopping'

export interface RelayStats {
  platformId: string
  status: RelayStatus
  /** Measured TCP round-trip to the destination ingest host, in ms. */
  latencyMs: number
  /** Rolling latency samples for the sparkline. */
  latencyHistory: number[]
  /** Outgoing bitrate reported by ffmpeg, in kbps. */
  bitrateKbps: number
  bitrateHistory: number[]
  fps: number
  droppedFrames: number
  /** ffmpeg encode speed relative to realtime. 1.0 = keeping up. */
  speed: number
  /** Seconds this destination has been live. */
  uptimeSec: number
  /** Bytes pushed to the destination. */
  bytesSent: number
  /** Last error line from ffmpeg, if any. */
  error?: string
  /** How many times this relay auto-reconnected this session. */
  reconnects: number
  /** 0-100 composite health score derived from speed, drops and latency. */
  health: number
}

export interface IngestState {
  /** RTMP server is bound and listening. */
  listening: boolean
  /** Streamlabs (or any encoder) is currently publishing. */
  publishing: boolean
  /** Incoming bitrate from the encoder, kbps. */
  bitrateKbps: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string
  /** Seconds since the encoder connected. */
  uptimeSec: number
  /** URL the renderer can play with mpegts.js. */
  previewUrl: string
}

export interface ChatMessage {
  id: string
  platformId: string
  platformKind: PlatformKind
  /** Epoch ms - taken from the platform's own timestamp when available. */
  timestamp: number
  author: string
  /** Hex colour supplied by the platform for the author, if any. */
  authorColor?: string
  message: string
  badges: string[]
  isModerator: boolean
  isSubscriber: boolean
  isOwner: boolean
}

export type ChatConnState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ChatStatus {
  platformId: string
  state: ChatConnState
  detail?: string
}

/** Platforms Hydracast can read a chat feed from without an OAuth login. */
export const CHAT_CAPABLE: PlatformKind[] = ['twitch', 'youtube', 'kick']

export function supportsChat(kind: PlatformKind): boolean {
  return CHAT_CAPABLE.includes(kind)
}

export type CheckLevel = 'ok' | 'warn' | 'error'

/** One line of a destination diagnostic report. */
export interface CheckResult {
  /** What was checked, e.g. "DNS" or "Stream key". */
  label: string
  level: CheckLevel
  detail: string
}

export interface LogEntry {
  id: string
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'success'
  scope: string
  message: string
}

/** Everything the renderer needs, pushed on every tick. */
export interface Snapshot {
  ingest: IngestState
  relays: Record<string, RelayStats>
  chatStatus: Record<string, ChatStatus>
  broadcasting: boolean
  sessionStartedAt: number | null
}

export interface PresetTarget {
  kind: PlatformKind
  name: string
  url: string
  /** Recommended max video bitrate for the platform, kbps. */
  recommendedBitrate: number
  helpUrl: string
  /**
   * True when the platform issues every channel its own ingest host, so there is
   * no shared URL that can ship as a working default.
   */
  perChannelIngest?: boolean
  /** Example of a valid ingest URL, shown as the input placeholder. */
  urlPlaceholder?: string
  /** Host suffix every valid ingest URL must end with. Checked before starting. */
  urlHostSuffix?: string
  /** Explains where to find the ingest URL when it is per-channel. */
  urlHint?: string
}

export const PLATFORM_PRESETS: PresetTarget[] = [
  {
    kind: 'twitch',
    name: 'Twitch',
    url: 'rtmp://live.twitch.tv/app',
    recommendedBitrate: 6000,
    helpUrl: 'https://dashboard.twitch.tv/settings/stream'
  },
  {
    kind: 'youtube',
    name: 'YouTube',
    url: 'rtmp://a.rtmp.youtube.com/live2',
    recommendedBitrate: 9000,
    helpUrl: 'https://studio.youtube.com/channel/live_streaming'
  },
  {
    kind: 'kick',
    name: 'Kick',
    // Kick runs on Amazon IVS, which hands every channel its own contribute
    // host - there is no shared default that would work for anyone else.
    url: '',
    recommendedBitrate: 8000,
    helpUrl: 'https://kick.com/dashboard/settings/stream',
    perChannelIngest: true,
    urlPlaceholder: 'rtmps://xxxxxxxxxxxx.global-contribute.live-video.net:443/app',
    urlHostSuffix: '.global-contribute.live-video.net',
    urlHint:
      'Kick gives every channel its own ingest host. Copy the full Stream URL from your Kick dashboard - a URL from any other channel will reject your key.'
  },
  {
    kind: 'facebook',
    name: 'Facebook',
    url: 'rtmps://live-api-s.facebook.com:443/rtmp',
    recommendedBitrate: 4000,
    helpUrl: 'https://www.facebook.com/live/producer'
  },
  {
    kind: 'trovo',
    name: 'Trovo',
    url: 'rtmp://livepush.trovo.live/live',
    recommendedBitrate: 6000,
    helpUrl: 'https://studio.trovo.live/'
  },
  {
    kind: 'tiktok',
    name: 'TikTok',
    url: 'rtmp://push.live.tiktok.com/live',
    recommendedBitrate: 4000,
    helpUrl: 'https://livecenter.tiktok.com/'
  },
  {
    kind: 'custom',
    name: 'Custom RTMP',
    url: '',
    recommendedBitrate: 6000,
    helpUrl: ''
  }
]

export const DEFAULT_VIDEO: PlatformVideoSettings = {
  mode: 'copy',
  videoBitrate: 6000,
  bufferSize: 0,
  audioBitrate: 0,
  encoder: 'auto',
  scale: '',
  fps: 0,
  keyframeInterval: 2
}

export const DEFAULT_SETTINGS: AppSettings = {
  rtmpPort: 1935,
  httpPort: 8787,
  ingestApp: 'live',
  ingestKey: 'streamlabs',
  ffmpegPath: '',
  autoStartOnIngest: false,
  autoReconnect: true,
  reconnectDelay: 5,
  chatBufferSize: 500,
  showPreview: true,
  theme: 'midnight'
}
