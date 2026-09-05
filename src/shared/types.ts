/**
 * Shared contract between the Electron main process and the renderer.
 * Everything crossing the IPC bridge is typed here.
 */

export type PlatformKind =
  'twitch' | 'youtube' | 'kick' | 'facebook' | 'trovo' | 'tiktok' | 'custom'

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

/**
 * Credentials the viewer count needs on platforms that will not hand one out
 * anonymously. Kept off `ChatConfig` because chat reads nothing from here: the
 * channel identity is shared, the credentials are not.
 */
export interface ViewerConfig {
  /**
   * Twitch application client id. Helix requires an app token even for the
   * entirely public `/streams` endpoint, so a viewer count is the one thing
   * Hydracast cannot read from Twitch without the user registering an app.
   * Client-credentials only - it grants no access to the user's own account.
   */
  twitchClientId?: string
  twitchClientSecret?: string
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
  /** Optional: only the platforms in `VIEWER_CAPABLE` read anything from it. */
  viewers?: ViewerConfig
}

/** A movable panel in the broadcast workspace. */
export type PanelId = 'preview' | 'destinations' | 'chat' | 'activity'

/** Which column a panel sits in. */
export type PanelRegion = 'left' | 'right'

export interface PanelState {
  id: PanelId
  region: PanelRegion
  /** Position within its region, ascending. */
  order: number
  /** Share of the region's height, relative to its siblings. */
  flex: number
  visible: boolean
  /** Rolled up to just its title bar. */
  collapsed: boolean
}

/** The part of the UI a layout captures. */
export interface LayoutValues {
  chatFontSize: number
  /** Width of the right-hand region, px. */
  chatWidth: number
  panels: PanelState[]
}

export interface LayoutPreset extends LayoutValues {
  id: string
  name: string
  /**
   * The built-in layout. It is never modified: editing while it is selected
   * produces an unsaved draft instead, so selecting it always restores the
   * original arrangement. That makes it the reliable way back.
   */
  builtIn?: boolean
}

export const DEFAULT_LAYOUT_ID = 'default'

export const PANEL_TITLES: Record<PanelId, string> = {
  preview: 'Preview',
  destinations: 'Destinations',
  chat: 'Chat',
  activity: 'Activity'
}

export const DEFAULT_PANELS: PanelState[] = [
  { id: 'preview', region: 'left', order: 0, flex: 1, visible: true, collapsed: false },
  { id: 'destinations', region: 'left', order: 1, flex: 1.4, visible: true, collapsed: false },
  { id: 'chat', region: 'right', order: 0, flex: 2, visible: true, collapsed: false },
  { id: 'activity', region: 'right', order: 1, flex: 1, visible: true, collapsed: false }
]

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
  /** Saved layouts the user can switch between. Always contains the built-in. */
  layouts: LayoutPreset[]
  /** Which saved layout is selected. */
  activeLayoutId: string
  /**
   * Unsaved edits sitting on top of the selected layout, or null when it is
   * clean. Editing never writes through to a saved layout, so switching away
   * and back always restores exactly what was saved.
   */
  draftLayout: LayoutValues | null
  theme: 'midnight' | 'nebula' | 'carbon'
  /** One title pushed to every connected destination; see StreamInfoPlan. */
  streamInfo: StreamInfoPlan
}

/**
 * The shared "what am I streaming" state.
 *
 * Optional automation rather than the only path: the shared title is applied to
 * every connected destination that has not been overridden, and any destination
 * can opt out by setting its own. Categories are never shared - Twitch and Kick
 * number their games differently, so an id copied across would select the wrong
 * game rather than none - which is why they are keyed per destination.
 */
export interface StreamInfoPlan {
  /** Push the shared title on apply. Off means every destination is manual. */
  enabled: boolean
  /** The title used by any destination without an override. */
  title: string
  /** Per-destination title that wins over the shared one. */
  overrides: Record<string, string>
  /** Per-destination category, because ids are not portable between platforms. */
  categories: Record<string, { id: string; name: string }>
}

/** The title a destination will actually receive. */
export function titleFor(plan: StreamInfoPlan, platformId: string): string {
  const override = plan.overrides[platformId]
  if (typeof override === 'string' && override.trim()) return override
  return plan.enabled ? plan.title : ''
}

export interface AppConfig {
  settings: AppSettings
  platforms: Platform[]
}

export type RelayStatus = 'idle' | 'starting' | 'live' | 'reconnecting' | 'error' | 'stopping'

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

/**
 * Audience events that are not chat messages.
 *
 * Only kinds reachable without an account login are produced today: Twitch
 * subs, gifts, raids and cheers arrive on the anonymous IRC connection, and
 * YouTube super chats and memberships arrive on the same polled live-chat call
 * as ordinary messages. Follows and donations need credentials Hydracast
 * deliberately does not ask for, so `follow` and `donation` exist for a future
 * source rather than being emitted now.
 */
export type ActivityKind =
  'follow' | 'subscription' | 'gift' | 'raid' | 'cheer' | 'donation' | 'announcement' | 'other'

export interface ActivityEvent {
  id: string
  platformId: string
  platformKind: PlatformKind
  /** Epoch ms - the platform's own timestamp when it supplies one. */
  timestamp: number
  kind: ActivityKind
  /** Who caused it: the subscriber, raider, cheerer. */
  actor: string
  /** One-line description, e.g. "resubscribed for 8 months at Tier 1". */
  detail: string
  /**
   * Pre-formatted magnitude for display: "500 bits", "$5.00", "42 viewers".
   * Kept as a string because each platform formats currency its own way.
   */
  amountLabel?: string
  /** Numeric magnitude where one exists, for sorting or totals. */
  amount?: number
  /** A message the viewer attached, e.g. a resub or super chat comment. */
  message?: string
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

/**
 * Concurrent audience on one destination, sampled only while that destination
 * is live. Absent from the snapshot entirely when it is not.
 */
export interface ViewerCount {
  platformId: string
  /** Concurrent viewers, or -1 when no count is available. */
  count: number
  /** Epoch ms of the last successful sample; 0 when there has never been one. */
  updatedAt: number
  /**
   * Why the count is missing or stale - "No Twitch app credentials set", the
   * API's own error. Shown as the tooltip on the number.
   */
  detail?: string
}

/**
 * Platforms that publish a concurrent viewer count Hydracast can read.
 *
 * The rest are not an oversight: Facebook, Trovo and TikTok all put live
 * viewer counts behind an account-scoped OAuth token, and a custom RTMP
 * destination is by definition unknown. Those show "--" rather than a guess.
 */
export const VIEWER_CAPABLE: PlatformKind[] = ['twitch', 'youtube', 'kick']

export function supportsViewerCount(kind: PlatformKind): boolean {
  return VIEWER_CAPABLE.includes(kind)
}

/**
 * Audience across every destination that is reporting one, or -1 when none is.
 *
 * A plain sum, deliberately: the same person watching on two platforms is
 * counted twice, because there is no way to know that and pretending otherwise
 * would understate the number every platform's own dashboard shows.
 */
export function totalViewers(counts: Record<string, ViewerCount>): number {
  const known = Object.values(counts).filter((c) => c.count >= 0)
  return known.length ? known.reduce((sum, c) => sum + c.count, 0) : -1
}

/* ------------------------------------------------------------------ auth ---
 * Connected accounts.
 *
 * Hydracast ships its own Twitch client id and asks the user to approve it,
 * rather than asking every user to register a developer app of their own. The
 * id is public by design and carries no secret, so it is safe in the binary -
 * see AUTH_CLIENT_IDS in main/auth/device.ts for why the app must be
 * registered as a Public client for this to be possible at all.
 */

export type AuthState = 'disconnected' | 'pending' | 'connected' | 'error'

export interface AuthAccount {
  kind: PlatformKind
  /** The platform's own id for the user, needed by most write endpoints. */
  userId: string
  /** Lower-case login/slug, which is also the chat channel name. */
  login: string
  displayName: string
  avatarUrl?: string
  scopes: string[]
  /** Epoch ms the access token expires. Twitch issues only 4 hours. */
  expiresAt: number
}

/**
 * Shown while a device flow waits for the user to approve it. The code is
 * short-lived, so the UI counts down against `expiresAt` rather than leaving a
 * dead code on screen.
 */
export interface DeviceVerification {
  userCode: string
  url: string
  expiresAt: number
}

export interface AuthStatus {
  platformId: string
  state: AuthState
  account?: AuthAccount
  verification?: DeviceVerification
  detail?: string
  /**
   * A previously working login stopped working and needs the user to log in
   * again - distinct from a connect attempt that simply failed. Only this
   * deserves an unprompted banner: nagging about an attempt the user just
   * abandoned would be noise, while a session that died while the app was shut
   * would otherwise be discovered mid-broadcast.
   */
  needsReconnect?: boolean
}

/** Platforms that can be connected with a login rather than pasted keys. */
export const AUTH_CAPABLE: PlatformKind[] = ['twitch', 'kick']

export function supportsAuth(kind: PlatformKind): boolean {
  return AUTH_CAPABLE.includes(kind)
}

/**
 * What the viewer sees before they click: the title and the category.
 *
 * Editable only for a connected account - both platforms gate the write behind
 * a scope, and neither exposes it to an anonymous client. Kept as one object
 * because a partial update to either platform would clear the other field.
 */
export interface StreamInfo {
  title: string
  categoryId: string
  categoryName: string
}

/** One entry from a category search, for the picker. */
export interface CategoryOption {
  id: string
  name: string
  boxArtUrl?: string
}

/** The result of pushing stream info to one destination. */
export interface StreamInfoResult {
  platformId: string
  ok: boolean
  detail?: string
  /**
   * True when there was nothing to change, so nothing was sent.
   *
   * Distinct from a plain success: "left alone as asked" and "updated" read the
   * same to a caller checking `ok`, and only one of them is worth a log line.
   */
  skipped?: boolean
}

/**
 * A partial change to push to every connected destination.
 *
 * An absent field is left exactly as it is, which is what makes `/title` and
 * `/game` independent - setting one must never blank the other. `game` is a
 * name rather than an id because Twitch and Kick number the same game
 * differently, so it is looked up per destination.
 */
export interface StreamInfoPatch {
  title?: string
  game?: string
}

/**
 * Twitch and Kick both allow a logged-in client to set these. YouTube does too,
 * but its login is deliberately not built, so it is absent here rather than
 * offered and then failing.
 */
export const STREAM_INFO_CAPABLE: PlatformKind[] = ['twitch', 'kick']

export function supportsStreamInfo(kind: PlatformKind): boolean {
  return STREAM_INFO_CAPABLE.includes(kind)
}

/* ------------------------------------------------------------ chat send ---*/

/** Prefix that routes a composed message to a single platform. */
export const SEND_PREFIXES: Record<string, PlatformKind> = {
  '/twitch': 'twitch',
  '/kick': 'kick',
  '/youtube': 'youtube',
  '/yt': 'youtube'
}

/**
 * A slash command Hydracast carries out itself instead of sending as chat.
 *
 * Deliberately few. The composer is the one control that is always on screen
 * while live, so the things worth putting here are the ones you reach for
 * mid-broadcast without wanting to open a window: wiping the feed, and
 * retitling or re-categorising every destination at once.
 */
export type ComposeCommand =
  | { name: 'clear' }
  | { name: 'title'; value: string }
  | { name: 'game'; value: string }

/** Slash words the app answers to, mapped to what they do. */
export const COMPOSE_COMMANDS: Record<string, ComposeCommand['name']> = {
  '/clear': 'clear',
  '/title': 'title',
  '/game': 'game'
}

export interface ComposedMessage {
  /** The text to send, with any routing prefix stripped. */
  text: string
  /** The single platform to send to, or null for every connected one. */
  route: PlatformKind | null
  /**
   * True when the text opens with a slash that is not a routing prefix. Twitch
   * commands like /me are not processed by the send endpoint, so this is sent
   * as literal text and the UI warns rather than pretending it is a command.
   */
  literalSlash: boolean
  /** Set when the line is one of ours; it is acted on, never sent. */
  command: ComposeCommand | null
}

/**
 * Splits `/twitch hello` into a route and a message.
 *
 * Bare text goes everywhere, which is the whole point of a multi-platform
 * relay: one line typed once reaches every audience.
 */
export function parseCompose(input: string): ComposedMessage {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return { text: trimmed, route: null, literalSlash: false, command: null }
  }

  const space = trimmed.search(/\s/)
  const head = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim()

  // Checked before the routing prefixes so a command can never be mistaken for
  // a message, and before the literal-slash fallback so it is never typed into
  // chat by accident.
  const command = COMPOSE_COMMANDS[head]
  if (command) {
    return {
      text: rest,
      route: null,
      literalSlash: false,
      command: command === 'clear' ? { name: 'clear' } : { name: command, value: rest }
    }
  }

  const route = SEND_PREFIXES[head]
  if (!route) return { text: trimmed, route: null, literalSlash: true, command: null }
  return { text: rest, route, literalSlash: false, command: null }
}

/** What one platform did with a message that was sent to it. */
export interface SendOutcome {
  platformId: string
  kind: PlatformKind
  ok: boolean
  /** Why it was refused - Twitch's drop_reason, an API error, a missing login. */
  detail?: string
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
  /** Keyed by platform id; only live destinations appear. */
  viewers: Record<string, ViewerCount>
  /** Keyed by platform id; every auth-capable destination appears. */
  auth: Record<string, AuthStatus>
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
  /**
   * Application path the platform publishes under. When the pasted URL carries
   * no path this is filled in automatically, so a dashboard that shows only the
   * host still produces a working destination.
   */
  urlPath?: string
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
    urlPlaceholder: 'rtmps://xxxxxxxxxxxx.global-contribute.live-video.net',
    urlHostSuffix: '.global-contribute.live-video.net',
    urlPath: '/app',
    urlHint:
      'Kick gives every channel its own ingest host. Paste the Stream URL from your Kick dashboard exactly as it shows it - the :443/app part is filled in for you if it is missing.'
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
  layouts: [
    {
      id: DEFAULT_LAYOUT_ID,
      name: 'Default',
      builtIn: true,
      chatFontSize: 13.5,
      chatWidth: 380,
      panels: DEFAULT_PANELS
    }
  ],
  activeLayoutId: DEFAULT_LAYOUT_ID,
  draftLayout: null,
  theme: 'midnight',
  streamInfo: { enabled: false, title: '', overrides: {}, categories: {} }
}

/**
 * Picks just the layout-owned values off anything that carries them - a saved
 * preset or a draft - so copying in either direction stays total.
 */
export function layoutValuesOf(source: LayoutValues): LayoutValues {
  return {
    chatFontSize: source.chatFontSize,
    chatWidth: source.chatWidth,
    panels: source.panels.map((p) => ({ ...p }))
  }
}

/** The arrangement currently on screen: the draft if one exists, else the saved layout. */
export function activeLayout(settings: AppSettings): LayoutValues {
  if (settings.draftLayout) return settings.draftLayout
  const preset =
    settings.layouts.find((l) => l.id === settings.activeLayoutId) ?? settings.layouts[0]
  return layoutValuesOf(preset)
}

/** True when there are edits that have not been saved into a layout. */
export function isLayoutDirty(settings: AppSettings): boolean {
  return settings.draftLayout !== null
}

/** Name for the layout button, marked with (*) while there are unsaved edits. */
export function layoutLabel(settings: AppSettings): string {
  const preset = settings.layouts.find((l) => l.id === settings.activeLayoutId)
  const name = preset?.name ?? 'Layout'
  return isLayoutDirty(settings) ? `${name} (*)` : name
}

/** Panels of one region, in display order. Hidden panels are excluded. */
export function panelsIn(values: LayoutValues, region: PanelRegion): PanelState[] {
  return values.panels
    .filter((p) => p.region === region && p.visible)
    .sort((a, b) => a.order - b.order)
}

/**
 * Applies a change to one panel, returning fresh layout values. Orders are
 * renumbered per region so repeated moves cannot leave gaps or ties.
 */
export function withPanel(
  values: LayoutValues,
  id: PanelId,
  patch: Partial<PanelState>
): LayoutValues {
  const panels = values.panels.map((p) => (p.id === id ? { ...p, ...patch } : p))
  return { ...layoutValuesOf(values), panels: renumber(panels) }
}

/** Moves a panel up or down within its region. */
export function movePanel(values: LayoutValues, id: PanelId, delta: -1 | 1): LayoutValues {
  const panel = values.panels.find((p) => p.id === id)
  if (!panel) return values
  const siblings = values.panels
    .filter((p) => p.region === panel.region)
    .sort((a, b) => a.order - b.order)
  const at = siblings.findIndex((p) => p.id === id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= siblings.length) return values

  const reordered = [...siblings]
  const [moved] = reordered.splice(at, 1)
  reordered.splice(to, 0, moved)

  const orders = new Map(reordered.map((p, index) => [p.id, index]))
  const panels = values.panels.map((p) =>
    orders.has(p.id) ? { ...p, order: orders.get(p.id)! } : { ...p }
  )
  return { ...layoutValuesOf(values), panels }
}

/**
 * Drops a panel into `region` at `index`, where `index` counts visible panels -
 * that is what a drag indicator points at. Hidden panels keep their relative
 * position rather than being shuffled by a move they had no part in.
 */
export function placePanel(
  values: LayoutValues,
  id: PanelId,
  region: PanelRegion,
  index: number
): LayoutValues {
  const panel = values.panels.find((p) => p.id === id)
  if (!panel) return values

  const full = values.panels
    .filter((p) => p.region === region && p.id !== id)
    .sort((a, b) => a.order - b.order)
  const visible = full.filter((p) => p.visible)

  // Translate an index over visible panels into one over all of them.
  let insertAt = full.length
  if (index < visible.length) {
    const anchor = visible[Math.max(0, index)]
    const found = full.findIndex((p) => p.id === anchor.id)
    if (found >= 0) insertAt = found
  }
  full.splice(insertAt, 0, { ...panel, region })

  const orders = new Map(full.map((p, i) => [p.id, i]))
  const panels = values.panels.map((p) =>
    orders.has(p.id)
      ? { ...p, region: p.id === id ? region : p.region, order: orders.get(p.id)! }
      : { ...p }
  )
  return { ...layoutValuesOf(values), panels: renumber(panels) }
}

/** Sends a panel to the other region, placing it last. */
export function switchRegion(values: LayoutValues, id: PanelId): LayoutValues {
  const panel = values.panels.find((p) => p.id === id)
  if (!panel) return values
  const region: PanelRegion = panel.region === 'left' ? 'right' : 'left'
  const last = values.panels.filter((p) => p.region === region).length
  return withPanel(values, id, { region, order: last })
}

function renumber(panels: PanelState[]): PanelState[] {
  const out: PanelState[] = []
  for (const region of ['left', 'right'] as PanelRegion[]) {
    panels
      .filter((p) => p.region === region)
      .sort((a, b) => a.order - b.order)
      .forEach((p, index) => out.push({ ...p, order: index }))
  }
  return out
}

/**
 * Makes `name` unique within `layouts`, ignoring `exceptId` so renaming a
 * layout to its own name is not treated as a collision. Suffixes rather than
 * rejecting, so saving a layout never fails on a name clash.
 */
export function uniqueLayoutName(name: string, layouts: LayoutPreset[], exceptId?: string): string {
  const trimmed = name.trim() || 'Layout'
  const taken = new Set(
    layouts.filter((l) => l.id !== exceptId).map((l) => l.name.trim().toLowerCase())
  )
  if (!taken.has(trimmed.toLowerCase())) return trimmed
  for (let n = 2; ; n++) {
    const candidate = `${trimmed} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Guarantees the built-in layout exists, that every layout has a full panel
 * set, and that the active id points at a real layout.
 *
 * Strictly additive: a user's own layouts are never rewritten, reordered or
 * dropped, and missing panels are filled from the defaults rather than the
 * whole set being replaced. A migration that edits saved values silently
 * destroys a working setup, and the user has no way to tell it happened.
 */
export function ensureLayouts(settings: AppSettings): AppSettings {
  const builtIn = DEFAULT_SETTINGS.layouts.find((l) => l.id === DEFAULT_LAYOUT_ID)!

  const fill = (values: LayoutValues): LayoutValues => {
    const existing = Array.isArray(values.panels) ? values.panels : []
    const panels = DEFAULT_PANELS.map((d) => existing.find((p) => p.id === d.id) ?? { ...d })
    return {
      chatFontSize: values.chatFontSize ?? builtIn.chatFontSize,
      chatWidth: values.chatWidth ?? builtIn.chatWidth,
      panels: renumber(panels)
    }
  }

  const layouts = (Array.isArray(settings.layouts) ? settings.layouts : []).map((l) =>
    l.id === DEFAULT_LAYOUT_ID ? { ...builtIn } : { ...l, ...fill(l) }
  )
  if (!layouts.some((l) => l.id === DEFAULT_LAYOUT_ID)) layouts.unshift({ ...builtIn })

  const activeLayoutId = layouts.some((l) => l.id === settings.activeLayoutId)
    ? settings.activeLayoutId
    : DEFAULT_LAYOUT_ID

  return {
    ...settings,
    layouts,
    activeLayoutId,
    draftLayout: settings.draftLayout ? fill(settings.draftLayout) : null
  }
}
