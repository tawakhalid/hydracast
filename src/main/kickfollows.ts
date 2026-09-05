import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { ActivityEvent, Platform } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from './http'
import { BROKER_BASE } from './auth/kick'

/**
 * Kick follower alerts.
 *
 * Kick delivers events only by webhook to a public HTTPS URL, so unlike Twitch
 * - whose EventSub has a WebSocket transport a desktop app can use directly -
 * this cannot work without a server in the middle. The broker that already
 * holds the client secret receives the webhook, verifies Kick's signature, and
 * pushes it down a socket to whichever app is listening for that channel.
 *
 * Follows are also the one Kick audience event that never appears on the public
 * chat socket: `FollowersUpdated` was tried and never arrived once on a live
 * 277k-follower channel, so this path is the only one there is.
 */

const SUBSCRIPTIONS_URL = 'https://api.kick.com/public/v1/events/subscriptions'

/** Registering the subscription needs this; the app asks for it at login. */
export const KICK_EVENTS_SCOPE = 'events:subscribe'

export type KickTokenProvider = (
  platformId: string
) => Promise<{ token: string; scopes: string[] } | null>

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** One follow as the broker relays it. */
export interface BrokerFollow {
  id: string
  at: number
  followerName: string
  followerId: string
}

/**
 * Reads a frame from the broker.
 *
 * Two shapes: a backlog sent on connect, covering follows that arrived while
 * the app was shut, and single events pushed live afterwards.
 */
export function readBrokerFrame(raw: unknown): BrokerFollow[] {
  const msg = rec(raw)
  const one = (v: unknown): BrokerFollow | null => {
    const e = rec(v)
    const name = str(e['followerName'])
    if (!name) return null
    return {
      id: str(e['id']),
      at: typeof e['at'] === 'number' ? (e['at'] as number) : Date.now(),
      followerName: name,
      followerId: str(e['followerId'])
    }
  }
  if (msg['type'] === 'backlog') {
    const events = Array.isArray(msg['events']) ? msg['events'] : []
    return events.map(one).filter((e): e is BrokerFollow => !!e)
  }
  if (msg['type'] === 'follow') {
    const single = one(msg['event'])
    return single ? [single] : []
  }
  return []
}

/** Turns a relayed follow into a feed entry. */
export function toActivity(follow: BrokerFollow, platformId: string): ActivityEvent {
  return {
    id: `kick-follow-${follow.id || follow.followerId || follow.followerName}`,
    platformId,
    platformKind: 'kick',
    timestamp: follow.at,
    kind: 'follow',
    actor: follow.followerName,
    detail: 'followed'
  }
}

/** What came of asking Kick to send this channel's follows. */
type SubscribeOutcome = 'ok' | 'needs-reconnect' | 'failed'

interface Connection {
  socket: WebSocket
  retryTimer: NodeJS.Timeout | null
  closedByUs: boolean
  attempts: number
  /** Newest event already delivered, so a reconnect does not replay it. */
  since: number
}

export class KickFollows extends EventEmitter {
  private tokens: KickTokenProvider
  private connections = new Map<string, Connection>()
  private wanted = new Map<string, Platform>()
  private subscribed = new Set<string>()
  /** Accounts already told to reconnect, so a retry loop says it once. */
  private warned = new Set<string>()

  constructor(tokens: KickTokenProvider) {
    super()
    this.tokens = tokens
  }

  sync(platforms: Platform[]): void {
    const next = new Map<string, Platform>()
    for (const platform of platforms) {
      if (platform.kind === 'kick' && platform.enabled) next.set(platform.id, platform)
    }
    this.wanted = next

    for (const id of [...this.connections.keys()]) {
      if (!next.has(id)) this.drop(id)
    }
    for (const id of next.keys()) {
      if (!this.connections.has(id)) void this.open(id)
    }
  }

  private async open(platformId: string): Promise<void> {
    const platform = this.wanted.get(platformId)
    if (!platform || !BROKER_BASE) return

    const auth = await this.tokens(platformId)
    if (!auth) return

    // The stored scope list is a hint, not the authority. It was a hard gate
    // once, and a token saved before `events:subscribe` joined the list made
    // this return before subscribing or connecting - so the feature was dead
    // and the only trace was one info line among the relay chatter. Kick gets
    // asked either way now, and Kick's answer decides.
    const outcome = await this.subscribe(platformId, auth.token)
    if (outcome === 'needs-reconnect') {
      // Said once per connection, and loudly: this is the one failure here
      // that the user alone can clear, and it is invisible until they do.
      if (!this.warned.has(platformId)) {
        this.warned.add(platformId)
        this.emit(
          'log',
          'warn',
          `${platform.name}: disconnect and reconnect this account to turn on follower alerts`
        )
      }
      return
    }

    const previous = this.connections.get(platformId)
    const url = `${BROKER_BASE.replace(/^http/, 'ws')}/kick/stream?since=${previous?.since ?? 0}`
    // Sent as a header rather than a query parameter: a token in a URL ends up
    // in request logs, and this one can post as the user.
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${auth.token}` } })

    const conn: Connection = {
      socket,
      retryTimer: null,
      closedByUs: false,
      attempts: (previous?.attempts ?? 0) + 1,
      since: previous?.since ?? 0
    }
    this.connections.set(platformId, conn)

    socket.on('open', () => {
      conn.attempts = 0
      this.emit('log', 'info', `${platform.name}: follower alerts active`)
    })

    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      for (const follow of readBrokerFrame(parsed)) {
        if (follow.at > conn.since) conn.since = follow.at
        this.emit('activity', toActivity(follow, platformId))
      }
    })

    socket.on('error', (err: Error) => {
      this.emit('log', 'warn', `${platform.name} follows: ${err.message}`)
    })

    socket.on('close', () => {
      if (conn.closedByUs) return
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(conn.attempts, 6))
      conn.retryTimer = setTimeout(() => {
        if (this.wanted.has(platformId)) void this.open(platformId)
      }, delay)
      if (typeof conn.retryTimer.unref === 'function') conn.retryTimer.unref()
    })
  }

  /**
   * Registers the webhook subscription with Kick.
   *
   * Idempotent in practice - Kick accepts a repeat without duplicating - but
   * tracked anyway so a flapping socket does not re-post it on every retry.
   * The callback URL is not sent here: it is configured on the app itself in
   * Kick's developer portal, which is why the broker URL has to be set there.
   *
   * Reports whether the account needs re-authorising, because that is the one
   * outcome the user has to act on and it cannot be recovered from by retrying.
   */
  private async subscribe(platformId: string, token: string): Promise<SubscribeOutcome> {
    if (this.subscribed.has(platformId)) return 'ok'
    const platform = this.wanted.get(platformId)
    if (!platform) return 'failed'
    try {
      const res = await browserFetch(SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          events: [{ name: 'channel.followed', version: 1 }],
          method: 'webhook'
        })
      })
      if (res.ok) {
        this.subscribed.add(platformId)
        this.warned.delete(platformId)
        return 'ok'
      }
      // 401 is an expired token, which refreshes on its own; 403 is the token
      // being genuinely short this scope, which only a fresh consent fixes.
      if (res.status === 403) return 'needs-reconnect'

      let body: Record<string, unknown> = {}
      try {
        body = rec(JSON.parse((await res.text()) || '{}'))
      } catch {
        /* Kick sometimes answers with nothing at all; the status carries it */
      }
      this.emit(
        'log',
        'warn',
        `${platform.name}: could not subscribe to follows - ${str(body['message']) || `HTTP ${res.status}`}`
      )
      return 'failed'
    } catch (err) {
      this.emit('log', 'warn', `${platform.name} follows: ${(err as Error).message}`)
      return 'failed'
    }
  }

  private drop(platformId: string): void {
    const conn = this.connections.get(platformId)
    if (!conn) return
    conn.closedByUs = true
    if (conn.retryTimer) clearTimeout(conn.retryTimer)
    conn.socket.close()
    this.connections.delete(platformId)
    this.subscribed.delete(platformId)
    this.warned.delete(platformId)
  }

  stop(): void {
    for (const id of [...this.connections.keys()]) this.drop(id)
    this.wanted.clear()
  }
}
