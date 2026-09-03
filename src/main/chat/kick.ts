import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { ChatMessage, Platform } from '@shared/types'

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

const CHAT_EVENT = 'App\\Events\\ChatMessage'

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
      const res = await fetch(`${CHANNEL_API}/${encodeURIComponent(slug)}`, {
        headers: {
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
      })

      if (res.status === 404) {
        this.emit('status', 'error', `Kick channel "${slug}" not found`)
        return null
      }
      if (!res.ok) {
        this.emit(
          'status',
          'error',
          `Kick blocked the channel lookup (HTTP ${res.status}) - enter the chatroom id manually`
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

      case CHAT_EVENT:
        this.emitMessage(frame.data)
        return

      default:
        return
    }
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
