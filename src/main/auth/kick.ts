import http from 'node:http'
import crypto from 'node:crypto'
import { browserFetch } from '../http'
import type { TokenSet } from './device'

/**
 * Kick login: OAuth 2.1 authorization code + PKCE over a loopback listener.
 *
 * Unlike Twitch there is no device flow and no public client type here. Kick's
 * token endpoint requires the client secret for the code exchange *and* for
 * every refresh - verified directly rather than assumed: one authorization code
 * was refused with HTTP 400 without the secret and accepted with HTTP 200 with
 * it, on the same code.
 *
 * Hydracast ships unpacked, so the secret cannot travel with it. The two halves
 * are split instead: this file runs the whole PKCE flow and holds the verifier,
 * while the broker (see broker/) holds the secret and performs the exchange.
 * The app never sees the secret; the broker never sees the user's password.
 */

/**
 * Hydracast's own Kick application id.
 *
 * Public by design, like the Twitch one. On its own it mints nothing: an
 * exchange also needs a code bound to this request's PKCE challenge, and the
 * secret that only the broker holds.
 */
export const KICK_CLIENT_ID = '01M1RG56QX008VJH25R1PS55PE'

/**
 * Where the broker lives.
 *
 * Not a secret: it accepts only PKCE exchanges pinned to the loopback redirect
 * below, so knowing the URL grants nothing on its own.
 */
export const BROKER_BASE = 'https://hydracast-broker.tawakhalid.workers.dev'

/**
 * A fixed port, because Kick matches the redirect URI exactly against the one
 * registered on the app - an ephemeral port could not be registered ahead of
 * time. `localhost` rather than `127.0.0.1`: Kick's own docs warn that their
 * front end rewrites the latter, which would break the exact match.
 */
export const KICK_REDIRECT_PORT = 8788
export const KICK_REDIRECT_URI = `http://localhost:${KICK_REDIRECT_PORT}/kick/callback`

/**
 * `user:read` is deliberately absent. Kick shows it to the user as "read user
 * information (including email address)", and all it would add is a profile
 * picture - the channels endpoint already returns the slug, which is the
 * channel name. Asking for an email the app has no use for makes the consent
 * screen harder to trust and leaves PII to safeguard for nothing.
 */
export const KICK_SCOPES = [
  'channel:read',
  'channel:write',
  'streamkey:read',
  'chat:write',
  // Follows never appear on Kick's public chat socket, so the activity feed
  // needs the webhook subscription this scope authorises.
  'events:subscribe'
]

const CHANNELS_URL = 'https://api.kick.com/public/v1/channels'
const AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export interface PkcePair {
  verifier: string
  challenge: string
  state: string
}

/** A verifier, its S256 challenge, and a CSRF state, all base64url. */
export function createPkce(): PkcePair {
  const b64 = (buf: Buffer): string => buf.toString('base64url')
  const verifier = b64(crypto.randomBytes(48))
  return {
    verifier,
    challenge: b64(crypto.createHash('sha256').update(verifier).digest()),
    state: b64(crypto.randomBytes(16))
  }
}

export function buildAuthUrl(pkce: PkcePair, clientId = KICK_CLIENT_ID): string {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: KICK_REDIRECT_URI,
    scope: KICK_SCOPES.join(' '),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state
  })}`
}

/** How the browser half of the flow ended. */
export type CallbackOutcome =
  | { status: 'code'; code: string }
  | { status: 'denied'; detail: string }
  | { status: 'error'; detail: string }

/**
 * Classifies the query string Kick redirects back with.
 *
 * Pure, so the mismatch and denial paths can be tested without binding a port.
 * A state mismatch is the one case that must never be treated as a login.
 */
export function readCallback(params: URLSearchParams, expectedState: string): CallbackOutcome {
  const error = str(params.get('error'))
  if (error) {
    const detail = str(params.get('error_description')) || error
    return error.includes('denied')
      ? { status: 'denied', detail: 'You declined the request on Kick' }
      : { status: 'error', detail }
  }
  if (params.get('state') !== expectedState) {
    return {
      status: 'error',
      detail: 'Login response did not match this request'
    }
  }
  const code = str(params.get('code'))
  if (!code) return { status: 'error', detail: 'Kick returned no authorization code' }
  return { status: 'code', code }
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;padding:48px;background:#0f1014;color:#e8e8ea">` +
  `<h2 style="margin:0 0 8px">${title}</h2><p style="color:#9a9aa2">${body}</p>`

/**
 * Serves the single redirect Kick sends the browser to, then stops.
 *
 * The listener exists only for the seconds between the user clicking Connect
 * and Kick redirecting back, and binds 127.0.0.1 so nothing off this machine
 * can reach it.
 */
export function awaitCallback(
  expectedState: string,
  timeoutMs = 5 * 60_000
): { result: Promise<CallbackOutcome>; cancel: () => void } {
  let settle: (o: CallbackOutcome) => void = () => {}
  const result = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve
  })

  let finished = false
  const done = (outcome: CallbackOutcome): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    server.close()
    settle(outcome)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${KICK_REDIRECT_PORT}`)
    if (url.pathname !== '/kick/callback') {
      res.writeHead(404).end()
      return
    }
    const outcome = readCallback(url.searchParams, expectedState)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      outcome.status === 'code'
        ? PAGE('Kick connected', 'You can close this tab and return to Hydracast.')
        : PAGE('Kick login failed', outcome.detail)
    )
    done(outcome)
  })

  const timer = setTimeout(
    () => done({ status: 'error', detail: 'Timed out waiting for Kick' }),
    timeoutMs
  )
  if (typeof timer.unref === 'function') timer.unref()

  server.on('error', (err: NodeJS.ErrnoException) => {
    done({
      status: 'error',
      detail:
        err.code === 'EADDRINUSE'
          ? `Port ${KICK_REDIRECT_PORT} is in use - close whatever is using it and try again`
          : err.message
    })
  })
  server.listen(KICK_REDIRECT_PORT, '127.0.0.1')

  return {
    result,
    cancel: () => done({ status: 'error', detail: 'Cancelled' })
  }
}

/**
 * Reads a token reply relayed by the broker.
 *
 * Kick access tokens last two hours - half of Twitch's four - so a long stream
 * crosses several expiries and refreshing is routine rather than an edge case.
 * The refresh token that comes back replaces the one that was sent.
 */
export function readTokenSet(body: unknown, now = Date.now()): TokenSet {
  const b = rec(body)
  const token = str(b['access_token'])
  if (!token) {
    throw new Error(str(b['detail']) || str(b['error']) || 'Kick rejected the login')
  }
  const secs = Number(b['expires_in'])
  const refreshSecs = Number(b['refresh_expires_in'])
  const scope = str(b['scope'])
  return {
    accessToken: token,
    refreshToken: str(b['refresh_token']),
    expiresAt: now + (Number.isFinite(secs) && secs > 0 ? secs : 7200) * 1000,
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : KICK_SCOPES,
    refreshExpiresAt:
      Number.isFinite(refreshSecs) && refreshSecs > 0 ? now + refreshSecs * 1000 : undefined
  }
}

async function callBroker(path: string, payload: Record<string, string>): Promise<TokenSet> {
  if (!BROKER_BASE) {
    throw new Error('Hydracast was built without a Kick broker URL - see main/auth/kick.ts')
  }
  const res = await browserFetch(`${BROKER_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  let body: unknown = {}
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Broker replied HTTP ${res.status}`)
  }
  return readTokenSet(body)
}

export function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  return callBroker('/kick/token', {
    code,
    code_verifier: verifier,
    redirect_uri: KICK_REDIRECT_URI
  })
}

export function refreshKickTokens(refreshToken: string): Promise<TokenSet> {
  return callBroker('/kick/refresh', { refresh_token: refreshToken })
}

/** Everything a single authenticated channels call yields. */
export interface KickChannel {
  broadcasterUserId: number
  slug: string
  bannerUrl: string
  rtmpUrl: string
  streamKey: string
  isLive: boolean
  viewerCount: number
  title: string
  category: string
}

/**
 * Reads `GET /public/v1/channels`.
 *
 * This one response carries identity, the RTMP URL, the stream key, the live
 * flag and the viewer count together, which is why a connected Kick account
 * needs neither a hand-pasted key nor the undocumented `api/v2` endpoint the
 * anonymous path has to scrape through Cloudflare.
 */
export function readChannel(body: unknown): KickChannel | null {
  const data = rec(body)['data']
  // `rec(undefined)` is an empty object, not null, so an empty list has to be
  // rejected on its own - otherwise "no channel" reads as a blank channel.
  const first = Array.isArray(data) && data.length ? rec(data[0]) : null
  if (!first) return null
  const stream = rec(first['stream'])
  const category = rec(first['category'])
  return {
    broadcasterUserId: num(first['broadcaster_user_id']),
    slug: str(first['slug']),
    bannerUrl: str(first['banner_picture']),
    rtmpUrl: str(stream['url']),
    streamKey: str(stream['key']),
    isLive: stream['is_live'] === true,
    viewerCount: num(stream['viewer_count']),
    title: str(first['stream_title']),
    category: str(category['name'])
  }
}

export async function fetchChannel(accessToken: string): Promise<KickChannel> {
  const res = await browserFetch(CHANNELS_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json'
    }
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Kick session expired' : `Kick replied HTTP ${res.status}`)
  }
  const channel = readChannel(JSON.parse(text))
  if (!channel) throw new Error('Kick returned no channel for this account')
  return channel
}

/**
 * Kick publishes no revocation endpoint, so Disconnect drops the stored tokens
 * and lets them expire on their own. Saying so beats implying otherwise.
 */
export const KICK_REVOKE_SUPPORTED = false
