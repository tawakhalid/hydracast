/**
 * Kick follower events, and the one piece of state this broker holds.
 *
 * Kick only delivers events by webhook to a public HTTPS URL, so a desktop app
 * cannot receive them directly - which is why follows were the one audience
 * event Hydracast could not show for Kick. The broker already exists to hold
 * the client secret, so it is also the only public address Hydracast has.
 *
 * This is a relay with a short memory, not a store: each channel keeps at most
 * the last few dozen follows for a few hours so an app that was closed when
 * someone followed still sees it, and nothing else is retained. Follower names
 * are the only personal data here and they expire on their own.
 */

/** How many recent follows a channel keeps. */
const MAX_EVENTS = 50

/** How long an unread event is worth keeping. */
const TTL_MS = 6 * 60 * 60 * 1000

export interface FollowEvent {
  /** Kick's own message id, so a redelivery is recognisable. */
  id: string
  at: number
  followerName: string
  followerId: string
}

/**
 * One channel's events, plus the sockets currently listening to it.
 *
 * A Durable Object rather than KV because an alert that arrives a minute late
 * is not an alert, and KV is eventually consistent. This is also what lets a
 * connected app be pushed to instead of polling, which keeps the token
 * verification to once per connection rather than once per poll.
 */
export class KickChannel {
  private state: DurableObjectState
  private sockets = new Set<WebSocket>()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  private async recent(): Promise<FollowEvent[]> {
    const stored = (await this.state.storage.get<FollowEvent[]>('events')) ?? []
    const cutoff = Date.now() - TTL_MS
    return stored.filter((e) => e.at >= cutoff)
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/ingest') {
      const event = (await req.json()) as FollowEvent
      const events = await this.recent()
      // Kick retries deliveries, so the same follow can arrive twice.
      if (!events.some((e) => e.id === event.id)) {
        events.push(event)
        await this.state.storage.put('events', events.slice(-MAX_EVENTS))
        const payload = JSON.stringify({ type: 'follow', event })
        for (const socket of this.sockets) {
          try {
            socket.send(payload)
          } catch {
            this.sockets.delete(socket)
          }
        }
      }
      return new Response(null, { status: 204 })
    }

    if (url.pathname === '/socket') {
      if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 })
      }
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      server.accept()
      this.sockets.add(server)
      server.addEventListener('close', () => this.sockets.delete(server))
      server.addEventListener('error', () => this.sockets.delete(server))

      // Anything missed while the app was shut, oldest first. The app dedupes
      // on id, so replaying a little is safer than dropping a follow.
      const since = Number(url.searchParams.get('since')) || 0
      const backlog = (await this.recent()).filter((e) => e.at > since)
      server.send(JSON.stringify({ type: 'backlog', events: backlog }))

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('not found', { status: 404 })
  }
}

/* ------------------------------------------------------------ signature ---*/

const PUBLIC_KEY_URL = 'https://api.kick.com/public/v1/public-key'

let cachedKey: CryptoKey | null = null

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '')
  const raw = atob(body)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** Kick's signing key, fetched once per isolate. */
async function publicKey(): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey
  try {
    const res = await fetch(PUBLIC_KEY_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { public_key?: string } }
    const pem = body.data?.public_key
    if (!pem) return null
    cachedKey = await crypto.subtle.importKey(
      'spki',
      pemToDer(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    return cachedKey
  } catch {
    return null
  }
}

/**
 * Checks that a webhook really came from Kick.
 *
 * Not optional. This endpoint is public by necessity, so without verification
 * anyone who learned the URL could post invented follower alerts straight into
 * a user's activity feed. Kick signs `id.timestamp.body` with RSA-SHA256 and
 * publishes the key.
 */
export async function verifySignature(
  messageId: string,
  timestamp: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  const key = await publicKey()
  if (!key || !messageId || !timestamp || !signature) return false
  try {
    const sig = pemToDer(signature)
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      sig,
      new TextEncoder().encode(`${messageId}.${timestamp}.${rawBody}`)
    )
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- parsing --*/

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/**
 * Reads a `channel.followed` body.
 *
 * Kick sends no timestamp on this event, so arrival time is the best available
 * and is recorded here rather than left for the app to invent - the broker is
 * the first thing to see it.
 */
export function readFollowed(
  body: unknown,
  messageId: string,
  now = Date.now()
): { broadcasterId: string; event: FollowEvent } | null {
  const b = rec(body)
  const broadcaster = rec(b['broadcaster'])
  const follower = rec(b['follower'])
  const broadcasterId = String(broadcaster['user_id'] ?? '')
  const followerName = String(follower['username'] ?? '')
  if (!broadcasterId || !followerName) return null
  return {
    broadcasterId,
    event: {
      id: messageId,
      at: now,
      followerName,
      followerId: String(follower['user_id'] ?? '')
    }
  }
}
