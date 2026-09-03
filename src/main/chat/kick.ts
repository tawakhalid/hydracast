import { EventEmitter } from 'events'
import { net } from 'electron'
import WebSocket from 'ws'
import type { ActivityEvent, ActivityKind, ChatMessage, Platform } from '@shared/types'

/**
 * Kick chat rides on a public Pusher app - the same credentials the kick.com web
 * client uses - so like the Twitch connector this stays a read-only path with no
 * account linking, token or OAuth app registration.
 *
 * The trade-off is that this is an undocumented endpoint: Kick can change the
 * app key or the event shape without notice, and the chatroom lookup sits behind
 * Cloudflare. Every failure below therefore reports exactly what broke and
 * points at the manual chatroom-id escape hatch, rather than silently showing an
 * empty feed.
 */
const PUSHER_KEY = '32cbd69e4b950bf97679'
const PUSHER_URL = `wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`
const CHANNEL_API = 'https://kick.com/api/v2/channels'

/**
 * Kick has shipped this event under more than one name. Observed live on the
 * wire as `ChatMessageEvent`; `ChatMessage` appears in older captures and in
 * most third-party write-ups. Matching both means a rename in either direction
 * cannot silently empty the feed again - which is exactly how the first cut of
 * this connector failed: every message arrived and was dropped because the
 * event name did not match.
 */
const CHAT_EVENTS = new Set(['App\\Events\\ChatMessageEvent', 'App\\Events\\ChatMessage'])

/**
 * Kick activity events, mapped by the tail of the event name.
 *
 * UNVERIFIED against the wire, unlike the chat event above, which was captured
 * live. Kick documents none of this, so these names are a best guess and some
 * may be wrong or missing. That is survivable only because `handle()` reports
 * every unrecognised event it receives: switch on chat debugging, cause a
 * follow or a sub, and the Activity log names exactly what Kick sent, so the
 * table below can be corrected from evidence rather than guessed at again.
 */
const ACTIVITY_KINDS: Record<string, ActivityKind> = {
  FollowersUpdated: 'follow',
  SubscriptionEvent: 'subscription',
  ChannelSubscriptionEvent: 'subscription',
  GiftedSubscriptionsEvent: 'gift',
  LuckyUsersWhoGotGiftSubscriptionsEvent: 'gift',
  StreamHostEvent: 'raid',
  StreamHostedEvent: 'raid'
}

/** Strips the `App\Events\` prefix Kick puts on every event name. */
function eventTail(name: string): string {
  const idx = name.lastIndexOf('\\')
  return idx >= 0 ? name.slice(idx + 1) : name
}

/**
 * Issues the lookup through Chromium's network stack rather than Node's.
 *
 * Kick fronts its API with Cloudflare, which rejects Node's HTTP client outright
 * (`403 Request blocked by security policy`) because its TLS and header
 * signature is not a browser's. Electron already embeds a real browser, so
 * asking it to make the request is both simpler and more honest than dressing
 * Node up as one. Falls back to global fetch outside the Electron main process.
 */
function browserFetch(url: string, init: RequestInit): Promise<Response> {
  return typeof net?.fetch === 'function' ? net.fetch(url, init) : fetch(url, init)
}

/** Kick inlines emotes as `[emote:12345:name]`; render the name instead. */
function stripEmotes(text: string): string {
  return text.replace(/\[emote:\d+:([^\]]*)\]/g, '$1')
}

interface KickBadge {
  type?: string
  text?: string
}

interface KickChatEvent {
  id?: string
  content?: string
  created_at?: string
  sender?: {
    username?: string
    slug?: string
    identity?: {
      color?: string
      badges?: KickBadge[]
    }
  }
}

export class KickChat extends EventEmitter {
  private ws: WebSocket | null = null
  private platform: Platform
  private slug: string
  private chatroomId: string
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private closedByUs = false

  constructor(platform: Platform) {
    super()
    this.platform = platform
    // Accept a pasted channel URL as readily as a bare slug.
    this.slug = (platform.chat.kickChannel || '')
      .trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, '')
      .replace(/[/?#].*$/, '')
      .toLowerCase()
    this.chatroomId = (platform.chat.kickChatroomId || '').trim()
  }

  async connect(): Promise<void> {
    if (!this.slug && !this.chatroomId) {
      this.emit('status', 'error', 'No Kick channel set')
      return
    }
    this.closedByUs = false
    this.emit('status', 'connecting')

    if (!this.chatroomId) {
      const resolved = await this.resolveChatroomId(this.slug)
      if (this.closedByUs) return
      if (!resolved) return
      this.chatroomId = resolved
    }

    this.open()
  }

  /**
   * Turns a channel slug into the numeric chatroom id the Pusher channel is
   * keyed on. Kick fronts this endpoint with Cloudflare, so a request that looks
   * automated can come back as an HTML challenge instead of JSON.
   */
  private async resolveChatroomId(slug: string): Promise<string | null> {
    try {
      const res = await browserFetch(`${CHANNEL_API}/${encodeURIComponent(slug)}`, {
        // No user-agent override: Chromium sends its own, which matches the TLS
        // fingerprint it presents. A hand-written UA only contradicts it.
        headers: { accept: 'application/json', 'accept-language': 'en-US,en;q=0.9' }
      })

      if (res.status === 404) {
        this.emit('status', 'error', `Kick channel "${slug}" not found`)
        return null
      }
      if (!res.ok) {
        this.emit(
          'status',
          'error',
          res.status === 403
            ? 'Kick blocked the channel lookup (403). Set the chatroom id in Settings > Chat sources to connect anyway.'
            : `Kick channel lookup failed (HTTP ${res.status})`
        )
        return null
      }

      const body = await res.text()
      let data: { chatroom?: { id?: number } }
      try {
        data = JSON.parse(body)
      } catch {
        // The Cloudflare interstitial is HTML, not JSON.
        this.emit(
          'status',
          'error',
          'Kick returned a Cloudflare challenge - enter the chatroom id manually'
        )
        return null
      }

      const id = data.chatroom?.id
      if (!id) {
        this.emit('status', 'error', `Kick channel "${slug}" has no chatroom`)
        return null
      }
      return String(id)
    } catch (err) {
      this.emit('status', 'error', `Kick lookup failed: ${(err as Error).message}`)
      return null
    }
  }

  private open(): void {
    const ws = new WebSocket(PUSHER_URL)
    this.ws = ws

    // Pusher expects the subscribe frame only after connection_established,
    // which arrives as the first message; see handle().
    ws.on('message', (data) => this.handle(data.toString()))

    ws.on('error', (err) => {
      this.emit('status', 'error', err.message)
    })

    ws.on('close', () => {
      this.ws = null
      this.clearPing()
      if (this.closedByUs) {
        this.emit('status', 'disconnected')
        return
      }
      this.emit('status', 'error', 'Disconnected - retrying')
      this.reconnectTimer = setTimeout(() => this.open(), 5000)
    })
  }

  private send(payload: unknown): void {
    try {
      this.ws?.send(JSON.stringify(payload))
    } catch {
      /* socket closed underneath us; the close handler retries */
    }
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private handle(raw: string): void {
    let frame: { event?: string; data?: unknown }
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }

    switch (frame.event) {
      case 'pusher:connection_established':
        this.send({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` }
        })
        // Pusher drops idle sockets after roughly two minutes.
        this.clearPing()
        this.pingTimer = setInterval(() => this.send({ event: 'pusher:ping', data: {} }), 60000)
        return

      case 'pusher_internal:subscription_succeeded':
        this.emit(
          'status',
          'connected',
          this.slug ? `kick.com/${this.slug}` : `chatroom ${this.chatroomId}`
        )
        return

      case 'pusher:ping':
        this.send({ event: 'pusher:pong', data: {} })
        return

      case 'pusher:error': {
        const data = frame.data as { message?: string } | undefined
        this.emit('status', 'error', data?.message || 'Pusher error')
        return
      }

      default:
        if (!frame.event) return
        if (CHAT_EVENTS.has(frame.event)) {
          this.emitMessage(frame.data)
          return
        }
        if (!this.emitActivity(frame.event, frame.data)) {
          // Nothing silently dropped: an unmapped event is reported so the
          // table above can be corrected from what Kick actually sends.
          this.emit('unknown-event', frame.event)
        }
        return
    }
  }

  /**
   * Maps a non-chat Kick event onto an activity event. Returns false when the
   * event is not one we know, so the caller can report it.
   */
  private emitActivity(event: string, payload: unknown): boolean {
    const kind = ACTIVITY_KINDS[eventTail(event)]
    if (!kind) return false

    let body: Record<string, unknown> = {}
    try {
      body = (typeof payload === 'string' ? JSON.parse(payload) : payload) ?? {}
    } catch {
      /* keep the empty body; the event itself is still worth showing */
    }

    const asRecord = (v: unknown): Record<string, unknown> =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

    // Kick is inconsistent about where the username sits, so try the shapes
    // seen in the wild before falling back to something printable.
    const actor =
      (body['username'] as string) ||
      (asRecord(body['user'])['username'] as string) ||
      (asRecord(body['sender'])['username'] as string) ||
      (body['followersCount'] !== undefined ? 'Someone' : 'Someone')

    const count =
      (body['followersCount'] as number) ??
      (body['months'] as number) ??
      (body['number_viewers'] as number) ??
      (Array.isArray(body['gifted_usernames'])
        ? (body['gifted_usernames'] as unknown[]).length
        : undefined)

    const detail =
      kind === 'follow'
        ? 'followed'
        : kind === 'raid'
          ? `hosted the stream${count ? ` with ${count} viewers` : ''}`
          : kind === 'gift'
            ? `gifted ${count ?? ''} subscription${count === 1 ? '' : 's'}`.replace('  ', ' ')
            : `subscribed${count ? ` for ${count} months` : ''}`

    this.emit('activity', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platformId: this.platform.id,
      platformKind: 'kick',
      timestamp: Date.now(),
      kind,
      actor,
      detail,
      amount: typeof count === 'number' ? count : undefined,
      amountLabel: typeof count === 'number' ? String(count) : undefined
    } satisfies ActivityEvent)
    return true
  }

  private emitMessage(payload: unknown): void {
    // Pusher nests the event body as a JSON string inside `data`.
    let event: KickChatEvent
    try {
      event = typeof payload === 'string' ? JSON.parse(payload) : (payload as KickChatEvent)
    } catch {
      return
    }
    if (!event?.content) return

    const badges = (event.sender?.identity?.badges ?? [])
      .map((b) => (b.type || '').toLowerCase())
      .filter(Boolean)

    const message: ChatMessage = {
      id: event.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platformId: this.platform.id,
      platformKind: 'kick',
      // Kick stamps the message server-side; prefer it over arrival time.
      timestamp: event.created_at ? Date.parse(event.created_at) || Date.now() : Date.now(),
      author: event.sender?.username || event.sender?.slug || 'unknown',
      authorColor: event.sender?.identity?.color || undefined,
      message: stripEmotes(event.content),
      badges,
      isModerator: badges.includes('moderator'),
      isSubscriber: badges.includes('subscriber') || badges.includes('founder'),
      isOwner: badges.includes('broadcaster')
    }
    this.emit('message', message)
  }

  disconnect(): void {
    this.closedByUs = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearPing()
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    this.ws = null
    this.emit('status', 'disconnected')
  }
}
