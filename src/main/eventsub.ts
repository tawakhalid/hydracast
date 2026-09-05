import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { ActivityEvent, Platform } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from './http'
import { TWITCH_CLIENT_ID } from './auth/device'

/**
 * Twitch follower alerts, over EventSub's WebSocket transport.
 *
 * Follows are the one audience event that never reaches the anonymous IRC
 * connection the chat reader uses, which is why `follow` has existed as an
 * ActivityKind with nothing emitting it. EventSub carries them, and its
 * WebSocket transport takes a *user* access token - so unlike Kick, whose
 * follows only arrive by webhook to a public URL, this needs no server at all.
 * The account is already connected; this just listens.
 *
 * Twitch drops the socket if it hears nothing for longer than the keepalive it
 * advertises, and hands out a replacement socket rather than expecting a
 * reconnect, so both are handled explicitly below.
 */

const EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws'
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions'

/** Reading a channel's followers is gated behind a moderator scope. */
export const FOLLOWS_SCOPE = 'moderator:read:followers'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** What a frame off the socket turned out to be. */
export type Frame =
  | { type: 'welcome'; sessionId: string; keepaliveSec: number }
  | { type: 'keepalive' }
  | {
      type: 'notification'
      subscriptionType: string
      event: Record<string, unknown>
    }
  | { type: 'reconnect'; url: string }
  | { type: 'revocation'; reason: string }
  | { type: 'other' }

/**
 * Classifies one EventSub frame.
 *
 * Pure so the whole protocol can be exercised without a socket: welcome,
 * keepalive, reconnect and revocation are all failure-adjacent paths that are
 * painful to provoke against the live service.
 */
export function readFrame(raw: unknown): Frame {
  const msg = rec(raw)
  const meta = rec(msg['metadata'])
  const payload = rec(msg['payload'])
  const type = str(meta['message_type'])

  if (type === 'session_welcome') {
    const session = rec(payload['session'])
    const secs = Number(session['keepalive_timeout_seconds'])
    return {
      type: 'welcome',
      sessionId: str(session['id']),
      keepaliveSec: Number.isFinite(secs) && secs > 0 ? secs : 10
    }
  }
  if (type === 'session_keepalive') return { type: 'keepalive' }
  if (type === 'session_reconnect') {
    return {
      type: 'reconnect',
      url: str(rec(payload['session'])['reconnect_url'])
    }
  }
  if (type === 'revocation') {
    return {
      type: 'revocation',
      reason: str(rec(payload['subscription'])['status'])
    }
  }
  if (type === 'notification') {
    return {
      type: 'notification',
      subscriptionType: str(meta['subscription_type']),
      event: rec(payload['event'])
    }
  }
  return { type: 'other' }
}

/**
 * Turns a `channel.follow` notification into a feed entry.
 *
 * Twitch supplies its own timestamp; using it rather than arrival time keeps
 * the feed honest when a reconnect delivers a short backlog.
 */
export function readFollow(
  event: Record<string, unknown>,
  platform: Pick<Platform, 'id'>
): ActivityEvent | null {
  const actor = str(event['user_name']) || str(event['user_login'])
  if (!actor) return null
  const at = Date.parse(str(event['followed_at']))
  return {
    id: `follow-${str(event['user_id']) || actor}-${Number.isFinite(at) ? at : Date.now()}`,
    platformId: platform.id,
    platformKind: 'twitch',
    timestamp: Number.isFinite(at) ? at : Date.now(),
    kind: 'follow',
    actor,
    detail: 'followed'
  }
}

/** Where the token for a platform comes from; supplied by the auth session. */
export type FollowTokenProvider = (
  platformId: string
) => Promise<{ token: string; userId: string; scopes: string[] } | null>

interface Connection {
  socket: WebSocket
  keepaliveTimer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
  closedByUs: boolean
  attempts: number
}

export class TwitchEventSub extends EventEmitter {
  private tokens: FollowTokenProvider
  private connections = new Map<string, Connection>()
  private wanted = new Map<string, Platform>()

  constructor(tokens: FollowTokenProvider) {
    super()
    this.tokens = tokens
  }

  /**
   * Brings connections in line with the platforms that should have one.
   *
   * Called whenever configuration or auth changes; connecting is driven by the
   * account being connected rather than by the stream being live, because a
   * follow can arrive at any time.
   */
  sync(platforms: Platform[]): void {
    const next = new Map<string, Platform>()
    for (const platform of platforms) {
      if (platform.kind === 'twitch' && platform.enabled) next.set(platform.id, platform)
    }
    this.wanted = next

    for (const id of [...this.connections.keys()]) {
      if (!next.has(id)) this.dropConnection(id)
    }
    for (const id of next.keys()) {
      if (!this.connections.has(id)) void this.open(id, EVENTSUB_WS)
    }
  }

  private async open(platformId: string, url: string): Promise<void> {
    const platform = this.wanted.get(platformId)
    if (!platform) return

    const auth = await this.tokens(platformId)
    if (!auth) return
    if (!auth.scopes.includes(FOLLOWS_SCOPE)) {
      // Accounts connected before follows existed have no such scope. Say so
      // once, rather than reconnecting forever against a subscription that
      // Twitch will refuse every time.
      this.emit('log', 'info', `${platform.name}: reconnect the account to enable follower alerts`)
      return
    }

    const socket = new WebSocket(url)
    const conn: Connection = {
      socket,
      keepaliveTimer: null,
      retryTimer: null,
      closedByUs: false,
      attempts: (this.connections.get(platformId)?.attempts ?? 0) + 1
    }
    this.connections.set(platformId, conn)

    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      void this.handle(platformId, conn, readFrame(parsed))
    })

    socket.on('error', (err: Error) => {
      this.emit('log', 'warn', `${platform.name} follows: ${err.message}`)
    })

    socket.on('close', () => {
      if (conn.keepaliveTimer) clearTimeout(conn.keepaliveTimer)
      if (conn.closedByUs) return
      this.scheduleRetry(platformId, conn)
    })
  }

  private async handle(platformId: string, conn: Connection, frame: Frame): Promise<void> {
    const platform = this.wanted.get(platformId)
    if (!platform) return

    switch (frame.type) {
      case 'welcome':
        conn.attempts = 0
        this.armKeepalive(platformId, conn, frame.keepaliveSec)
        await this.subscribe(platformId, frame.sessionId)
        break

      case 'keepalive':
        this.armKeepalive(platformId, conn)
        break

      case 'notification':
        this.armKeepalive(platformId, conn)
        if (frame.subscriptionType === 'channel.follow') {
          const activity = readFollow(frame.event, platform)
          if (activity) this.emit('activity', activity)
        }
        break

      case 'reconnect':
        // Twitch hands over a replacement socket and keeps the old one alive
        // until it is connected, so this is a handover, not an outage.
        conn.closedByUs = true
        conn.socket.close()
        if (frame.url) void this.open(platformId, frame.url)
        break

      case 'revocation':
        this.emit(
          'log',
          'warn',
          `${platform.name}: Twitch revoked follower alerts (${frame.reason || 'unknown'}) - reconnect the account`
        )
        this.dropConnection(platformId)
        break
    }
  }

  /**
   * Twitch closes a silent socket, so a missed keepalive means the connection
   * is already gone even though the OS has not noticed yet.
   */
  private armKeepalive(platformId: string, conn: Connection, seconds?: number): void {
    if (conn.keepaliveTimer) clearTimeout(conn.keepaliveTimer)
    const window = (seconds ?? 10) * 1000 + 5000
    conn.keepaliveTimer = setTimeout(() => {
      conn.socket.terminate()
    }, window)
    if (typeof conn.keepaliveTimer.unref === 'function') conn.keepaliveTimer.unref()
  }

  private scheduleRetry(platformId: string, conn: Connection): void {
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(conn.attempts, 5))
    conn.retryTimer = setTimeout(() => {
      if (this.wanted.has(platformId)) void this.open(platformId, EVENTSUB_WS)
    }, delay)
    if (typeof conn.retryTimer.unref === 'function') conn.retryTimer.unref()
  }

  /**
   * Registers the follow subscription against this socket's session.
   *
   * `moderator_user_id` is the broadcaster themselves: Hydracast reads follows
   * for the account that logged in, never for anyone else's channel.
   */
  private async subscribe(platformId: string, sessionId: string): Promise<void> {
    const platform = this.wanted.get(platformId)
    const auth = await this.tokens(platformId)
    if (!platform || !auth) return

    try {
      const res = await browserFetch(SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'client-id': TWITCH_CLIENT_ID,
          authorization: `Bearer ${auth.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          type: 'channel.follow',
          version: '2',
          condition: {
            broadcaster_user_id: auth.userId,
            moderator_user_id: auth.userId
          },
          transport: { method: 'websocket', session_id: sessionId }
        })
      })
      if (!res.ok) {
        const body = rec(JSON.parse((await res.text()) || '{}'))
        this.emit(
          'log',
          'warn',
          `${platform.name}: follower alerts unavailable - ${str(body['message']) || `HTTP ${res.status}`}`
        )
        return
      }
      this.emit('log', 'info', `${platform.name}: follower alerts active`)
    } catch (err) {
      this.emit('log', 'warn', `${platform.name} follows: ${(err as Error).message}`)
    }
  }

  private dropConnection(platformId: string): void {
    const conn = this.connections.get(platformId)
    if (!conn) return
    conn.closedByUs = true
    if (conn.keepaliveTimer) clearTimeout(conn.keepaliveTimer)
    if (conn.retryTimer) clearTimeout(conn.retryTimer)
    conn.socket.close()
    this.connections.delete(platformId)
  }

  stop(): void {
    for (const id of [...this.connections.keys()]) this.dropConnection(id)
    this.wanted.clear()
  }
}
