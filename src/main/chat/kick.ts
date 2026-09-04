import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { ActivityEvent, ActivityKind, ChatMessage, Platform } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from '../http'

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
 * Captured off a live channel rather than guessed: 25 minutes on a subathon
 * stream, ~13.6k frames. The first cut of this table was written from memory
 * and got the two money events wrong - both the name and the topic they ride -
 * so every entry below carries the payload shape that was actually observed.
 */
const ACTIVITY_KINDS: Record<string, ActivityKind> = {
  /** chatrooms.<id>.v2 - `{ chatroom_id, username, months }` */
  SubscriptionEvent: 'subscription',
  /** chatroom_<id> - `{ gifter_username, gifted_usernames[], gifted_total, gifter_total }` */
  GiftedSubscriptionsEvent: 'gift',
  /** channel_<id> - Kick's paid gifts: `{ sender, gift: { name, amount }, message }` */
  KicksGifted: 'donation',
  /**
   * Unverified, unlike the three above: no host happened during the capture.
   * Kept as a guess because an unmapped host shows up in the Logs tab anyway,
   * which is how the rest of this table got corrected.
   */
  StreamHostEvent: 'raid',
  StreamHostedEvent: 'raid'
}

/**
 * Events that are real but are not audience activity.
 *
 * Listed explicitly rather than left to fall through, because `PredictionUpdated`
 * alone fired 893 times in 25 minutes: unmapped, it would bury the Logs tab in
 * "unknown event" noise and hide the one line that matters.
 *
 * `FollowersUpdated` is deliberately absent from both tables. It was a guess in
 * the first version of this file and never arrived once on a live 277k-follower
 * channel, so follows appear not to be broadcast publicly at all. Leaving it
 * unmapped means that if Kick ever does send it, the Logs tab says so.
 */
const IGNORED_EVENTS = new Set([
  'PredictionCreated',
  'PredictionUpdated',
  'PredictionDeleted',
  'KicksLeaderboardUpdated',
  'GiftsLeaderboardUpdated',
  // The channel-wide twin of SubscriptionEvent. Its topic is not subscribed to,
  // precisely so that counting it as well cannot double every sub.
  'ChannelSubscriptionEvent',
  // The "X subscribed" line Kick writes into chat; SubscriptionEvent covers it.
  'ChatMessageSentEvent',
  'MessageDeletedEvent',
  'PinnedMessageCreatedEvent',
  'PinnedMessageDeletedEvent',
  'UserBannedEvent',
  'UserUnbannedEvent',
  'ChatroomUpdatedEvent'
])

/** Strips the `App\Events\` prefix Kick puts on every event name. */
function eventTail(name: string): string {
  const idx = name.lastIndexOf('\\')
  return idx >= 0 ? name.slice(idx + 1) : name
}

type ActivityFields = Pick<
  ActivityEvent,
  'actor' | 'detail' | 'amount' | 'amountLabel' | 'message'
>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** Lists gift recipients, keeping a large bomb to one readable line. */
function summarise(names: string[], cap = 8): string {
  if (names.length <= cap) return names.join(', ')
  return `${names.slice(0, cap).join(', ')} and ${names.length - cap} more`
}

/**
 * Turns one Kick payload into the fields an activity row shows.
 *
 * Written out per event rather than as one generic field hunt: Kick names the
 * actor `username`, `gifter_username` and `sender.username` across the three
 * events, and a generic search for "the username" silently produced "Someone"
 * for the two that matter most.
 */
function describe(tail: string, body: Record<string, unknown>): ActivityFields {
  if (tail === 'SubscriptionEvent') {
    const months = num(body['months'])
    return {
      actor: str(body['username']) || 'Someone',
      detail: months && months > 1 ? `resubscribed for ${months} months` : 'subscribed',
      amount: months,
      amountLabel: months && months > 1 ? `${months} mo` : undefined
    }
  }

  if (tail === 'GiftedSubscriptionsEvent') {
    const names = Array.isArray(body['gifted_usernames'])
      ? (body['gifted_usernames'] as unknown[]).map(str).filter(Boolean)
      : []
    const total = num(body['gifted_total']) ?? names.length
    const lifetime = num(body['gifter_total'])
    return {
      actor: str(body['gifter_username']) || 'Someone',
      detail:
        `gifted ${total} subscription${total === 1 ? '' : 's'}` +
        (lifetime ? ` (${lifetime.toLocaleString('en-US')} all time)` : ''),
      amount: total,
      amountLabel: `${total}x`,
      // Naming the recipients is most of the point of a gift alert, but a
      // 50-sub bomb - observed live - would otherwise render as a wall of
      // usernames, so the tail is summarised.
      message: names.length ? summarise(names) : undefined
    }
  }

  if (tail === 'KicksGifted') {
    const gift = rec(body['gift'])
    const amount = num(gift['amount'])
    const note = str(body['message'])
    return {
      actor: str(rec(body['sender'])['username']) || 'Someone',
      detail: `sent ${str(gift['name']) || 'a gift'}`,
      amount,
      amountLabel: amount ? `${amount.toLocaleString('en-US')} Kicks` : undefined,
      message: note || undefined
    }
  }

  // A host. Unverified shape, so read the viewer count from either spelling.
  const viewers = num(body['number_viewers']) ?? num(body['numberViewers'])
  return {
    actor: str(body['username']) || str(rec(body['user'])['username']) || 'Someone',
    detail: 'hosted the stream',
    amount: viewers,
    amountLabel: viewers ? `${viewers} viewers` : undefined
  }
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
  /** Only known when the slug lookup succeeds; Kicks ride on it. */
  private channelId = ''
  private subscribed = 0
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

    // Worth attempting even when the chatroom id was typed in by hand, because
    // only the lookup can supply the channel id that Kicks ride on. It is fatal
    // only when there is no manual id to fall back on.
    if (this.slug) {
      const ok = await this.resolveChannel(this.slug, !this.chatroomId)
      if (this.closedByUs) return
      if (!ok && !this.chatroomId) return
    }

    this.open()
  }

  /**
   * Turns a channel slug into the numeric chatroom id the Pusher channel is
   * keyed on. Kick fronts this endpoint with Cloudflare, so a request that looks
   * automated can come back as an HTML challenge instead of JSON.
   */
  private async resolveChannel(slug: string, fatal: boolean): Promise<boolean> {
    // A non-fatal failure stays quiet: the connection still works from the
    // manually entered chatroom id, only Kicks are missing.
    const fail = (msg: string): boolean => {
      if (fatal) this.emit('status', 'error', msg)
      return false
    }

    try {
      const res = await browserFetch(`${CHANNEL_API}/${encodeURIComponent(slug)}`, {
        // No user-agent override: Chromium sends its own, which matches the TLS
        // fingerprint it presents. A hand-written UA only contradicts it.
        headers: BROWSER_HEADERS
      })

      if (res.status === 404) return fail(`Kick channel "${slug}" not found`)
      if (!res.ok) {
        return fail(
          res.status === 403
            ? 'Kick blocked the channel lookup (403). Set the chatroom id in Settings > Chat & viewers to connect anyway.'
            : `Kick channel lookup failed (HTTP ${res.status})`
        )
      }

      const body = await res.text()
      let data: { id?: number; chatroom?: { id?: number } }
      try {
        data = JSON.parse(body)
      } catch {
        // The Cloudflare interstitial is HTML, not JSON.
        return fail('Kick returned a Cloudflare challenge - enter the chatroom id manually')
      }

      if (data.id) this.channelId = String(data.id)
      const id = data.chatroom?.id
      if (!id) return fail(`Kick channel "${slug}" has no chatroom`)
      // A hand-entered id stays authoritative; it only exists because the
      // lookup was failing in the first place.
      if (!this.chatroomId) this.chatroomId = String(id)
      return true
    } catch (err) {
      return fail(`Kick lookup failed: ${(err as Error).message}`)
    }
  }

  /**
   * The Pusher topics one Kick channel spreads its events across.
   *
   * Not one feed but three, with inconsistent naming that is not a typo:
   * chat and subs arrive on the dotted plural, gifted subs on the underscored
   * singular, and Kicks on the channel rather than the chatroom.
   */
  private topics(): string[] {
    const list = [`chatrooms.${this.chatroomId}.v2`, `chatroom_${this.chatroomId}`]
    if (this.channelId) list.push(`channel_${this.channelId}`)
    return list
  }

  private open(): void {
    this.subscribed = 0
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
        for (const channel of this.topics()) {
          this.send({ event: 'pusher:subscribe', data: { auth: '', channel } })
        }
        // Pusher drops idle sockets after roughly two minutes.
        this.clearPing()
        this.pingTimer = setInterval(() => this.send({ event: 'pusher:ping', data: {} }), 60000)
        return

      case 'pusher_internal:subscription_succeeded':
        // One frame per topic; the feed counts as live on the first.
        if (this.subscribed++ === 0) {
          this.emit(
            'status',
            'connected',
            this.slug ? `kick.com/${this.slug}` : `chatroom ${this.chatroomId}`
          )
        }
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
        // Protocol chatter, including the pong that answers our own keepalive.
        // Reporting these as unknown events was pure noise in the Logs tab.
        if (frame.event.startsWith('pusher:') || frame.event.startsWith('pusher_internal:')) return
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
   * Maps a non-chat Kick event onto an activity event. Returns false only for
   * an event that is neither known activity nor known noise, so the caller can
   * report it and this file can be corrected from evidence.
   */
  private emitActivity(event: string, payload: unknown): boolean {
    const tail = eventTail(event)
    if (IGNORED_EVENTS.has(tail)) return true

    const kind = ACTIVITY_KINDS[tail]
    if (!kind) return false

    let body: Record<string, unknown> = {}
    try {
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      /* keep the empty body; the event itself is still worth showing */
    }

    this.emit('activity', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platformId: this.platform.id,
      platformKind: 'kick',
      timestamp: Date.now(),
      kind,
      ...describe(tail, body)
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
