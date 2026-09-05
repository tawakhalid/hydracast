/**
 * Hydracast OAuth broker.
 *
 * Kick has no public client type: its token endpoint demands the client secret
 * for both the initial code exchange and every refresh. Hydracast ships as an
 * unpacked Electron app, so anything embedded in it is readable with a text
 * editor - a leaked secret would let someone put up a consent screen wearing
 * our name, and a revocation for their abuse would break every install at once.
 *
 * So the secret lives here instead. The desktop app runs the whole PKCE flow
 * itself and only hands this Worker the two things it cannot use alone: the
 * authorization code and the verifier. We add the secret, forward to Kick, and
 * pass the reply straight back.
 *
 * Twitch arrives here for one call only. Its device grant needs no secret, so
 * the app logs in by itself, but the refresh grant refuses a Confidential
 * client that omits one - which made every Twitch session die four hours after
 * it started. Only the refresh is served here; the login stays in the app.
 *
 * This is a relay, not a store. Tokens travel through it and are never logged,
 * cached, or persisted - the only long-lived secret here is the app's own.
 */

import { KickChannel, readFollowed, verifySignature } from './events'

export { KickChannel }

export interface Env {
  KICK_CLIENT_ID: string
  KICK_CLIENT_SECRET: string
  TWITCH_CLIENT_ID: string
  TWITCH_CLIENT_SECRET: string
  /** One instance per Kick channel; holds recent follows and live sockets. */
  KICK_CHANNELS: DurableObjectNamespace
}

const KICK_CHANNELS_API = 'https://api.kick.com/public/v1/channels'

/**
 * Establishes which channel a caller may read.
 *
 * The app proves ownership with its own Kick access token: the broker spends it
 * on the one call that names the account, and serves only that channel. No
 * separate credential to issue, revoke, or leak - and a token that has expired
 * simply stops working, which is the correct outcome.
 */
async function broadcasterFor(token: string): Promise<string | null> {
  if (!token) return null
  try {
    const res = await fetch(KICK_CHANNELS_API, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ broadcaster_user_id?: number }> }
    const id = body.data?.[0]?.broadcaster_user_id
    return id ? String(id) : null
  } catch {
    return null
  }
}

const KICK_TOKEN_URL = 'https://id.kick.com/oauth/token'
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token'

/** The loopback address the desktop app listens on. Anything else is refused. */
const ALLOWED_REDIRECTS = new Set(['http://localhost:8788/kick/callback'])

/** A generous ceiling; a real request is a few hundred bytes. */
const MAX_BODY = 4096

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  })

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text()
  if (raw.length > MAX_BODY) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Forwards a grant upstream with the secret attached.
 *
 * The upstream status is passed through unchanged so the app can tell an
 * expired code from a revoked one instead of seeing a flat failure. The token
 * in the reply is relayed byte for byte and never read, logged, or stored.
 */
async function forward(
  tokenUrl: string,
  credentials: { clientId: string; clientSecret: string },
  params: Record<string, string>
): Promise<Response> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams({
      ...params,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    })
  })

  const text = await res.text()
  if (!res.ok) {
    // Kick answers errors with an empty body and Twitch answers with a JSON
    // one. Both end up quoted in a message the user reads, so unwrap Twitch's
    // wording rather than showing them a serialised object, and invent
    // something for Kick rather than handing over a blank failure.
    let detail: string | null = text || null
    try {
      const upstream = JSON.parse(text) as Record<string, unknown>
      const message = upstream['message'] ?? upstream['error_description'] ?? upstream['error']
      if (typeof message === 'string' && message) detail = message
    } catch {
      /* not JSON; the raw text, or null, is the best available */
    }
    return json({ error: 'upstream_rejected', status: res.status, detail }, res.status)
  }
  return new Response(text, {
    status: res.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url)

    if (req.method === 'GET' && pathname === '/health') return json({ ok: true })

    /**
     * Kick's webhook. Public by necessity, so the signature is the only thing
     * standing between this and invented follower alerts in someone's feed.
     */
    if (req.method === 'POST' && pathname === '/kick/events') {
      const raw = await req.text()
      const ok = await verifySignature(
        req.headers.get('Kick-Event-Message-Id') ?? '',
        req.headers.get('Kick-Event-Message-Timestamp') ?? '',
        raw,
        req.headers.get('Kick-Event-Signature') ?? ''
      )
      // 401 rather than 400: this is an authentication failure, and Kick should
      // not retry a delivery we will refuse identically next time.
      if (!ok) return json({ error: 'bad_signature' }, 401)

      if (req.headers.get('Kick-Event-Type') !== 'channel.followed') {
        // Subscribed to nothing else, but acknowledge so Kick stops retrying.
        return new Response(null, { status: 204 })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return json({ error: 'bad_request' }, 400)
      }
      const followed = readFollowed(parsed, req.headers.get('Kick-Event-Message-Id') ?? '')
      if (!followed) return json({ error: 'unrecognised_payload' }, 400)

      const stub = env.KICK_CHANNELS.get(env.KICK_CHANNELS.idFromName(followed.broadcasterId))
      await stub.fetch('https://do/ingest', {
        method: 'POST',
        body: JSON.stringify(followed.event)
      })
      return new Response(null, { status: 204 })
    }

    /** The app's live feed of its own channel's follows. */
    if (req.method === 'GET' && pathname === '/kick/stream') {
      const url = new URL(req.url)
      const token =
        (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
        url.searchParams.get('token') ||
        ''
      const broadcasterId = await broadcasterFor(token)
      if (!broadcasterId) return json({ error: 'unauthorized' }, 401)

      const stub = env.KICK_CHANNELS.get(env.KICK_CHANNELS.idFromName(broadcasterId))
      const since = url.searchParams.get('since') ?? '0'
      return stub.fetch(`https://do/socket?since=${encodeURIComponent(since)}`, {
        headers: { upgrade: 'websocket' }
      })
    }

    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

    const body = await readBody(req)
    if (!body) return json({ error: 'bad_request' }, 400)

    /**
     * Twitch's refresh, and the only Twitch grant served here.
     *
     * There is nothing to pin the way the Kick redirect is pinned: a refresh
     * token is itself the credential, so anyone able to call this usefully
     * already holds what it would buy them. What this must not become is a way
     * to spend the secret on anything else, which is why the grant type is
     * fixed here rather than taken from the request.
     */
    if (pathname === '/twitch/refresh') {
      if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
        return json({ error: 'broker_not_configured', detail: 'twitch' }, 500)
      }
      const refresh = str(body['refresh_token'])
      if (!refresh) return json({ error: 'missing_refresh_token' }, 400)
      return forward(
        TWITCH_TOKEN_URL,
        { clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET },
        { grant_type: 'refresh_token', refresh_token: refresh }
      )
    }

    if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) {
      return json({ error: 'broker_not_configured', detail: 'kick' }, 500)
    }

    if (pathname === '/kick/token') {
      const code = str(body['code'])
      const verifier = str(body['code_verifier'])
      const redirect = str(body['redirect_uri'])
      if (!code || !verifier) return json({ error: 'missing_code_or_verifier' }, 400)
      // Pinning the redirect stops this broker being used to complete a flow
      // that was started against somebody else's listener.
      if (!ALLOWED_REDIRECTS.has(redirect)) return json({ error: 'redirect_not_allowed' }, 400)

      return forward(
        KICK_TOKEN_URL,
        { clientId: env.KICK_CLIENT_ID, clientSecret: env.KICK_CLIENT_SECRET },
        {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirect
        }
      )
    }

    if (pathname === '/kick/refresh') {
      const refresh = str(body['refresh_token'])
      if (!refresh) return json({ error: 'missing_refresh_token' }, 400)
      return forward(
        KICK_TOKEN_URL,
        { clientId: env.KICK_CLIENT_ID, clientSecret: env.KICK_CLIENT_SECRET },
        { grant_type: 'refresh_token', refresh_token: refresh }
      )
    }

    return json({ error: 'not_found' }, 404)
  }
}
