import { browserFetch } from '../http'
import { brokerPost, RefreshError } from './broker'

/**
 * Twitch Device Code Flow.
 *
 * Chosen over the authorization-code flow because it needs no client secret and
 * no redirect URI, which together are what let Hydracast ship one application
 * for everyone instead of asking each user to register a developer app of their
 * own. The user approves a short code in their own browser, so this process
 * never sees a password.
 *
 * Twitch's docs say a *Public* client is restricted to this flow, which reads as
 * though the two client types were mutually exclusive. They are not: a
 * Confidential registration was verified to accept the device flow too, which is
 * why no second app registration was needed.
 *
 * The secret is not unused, though, and believing it was cost a release. The
 * device grant ignores it; the *refresh* grant does not, and answers a
 * Confidential client that omits it with `400 missing client secret` before it
 * even reads the refresh token. Logging in therefore worked perfectly while
 * every refresh failed, so a session died silently four hours in. The refresh
 * is the one call in this file that goes through the broker for that reason.
 */

/**
 * Hydracast's own Twitch application id.
 *
 * Safe to ship and safe to commit. A client id identifies the application, not
 * a user, and can mint nothing on its own - the client *secret* is the half that
 * must never leave a trusted machine, and nothing in this file sends one.
 */
export const TWITCH_CLIENT_ID = 'megbb7zhns7vai7eufdou36gbq2uzf'

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke'

/**
 * Exactly what the three features need and nothing more. A consent screen that
 * asks for permissions the app does not use is both harder to trust and harder
 * to justify; device flow makes adding a scope later a one-click re-auth.
 */
export const TWITCH_SCOPES = [
  'channel:read:stream_key',
  'user:write:chat',
  // Follows never reach the anonymous IRC connection, so the activity feed
  // needs EventSub, and EventSub gates them behind a moderator scope.
  'moderator:read:followers',
  // Setting the title and category from Hydracast rather than the dashboard.
  'channel:manage:broadcast'
]

export interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Epoch ms the user code stops working. */
  expiresAt: number
  /** Seconds Twitch asks us to wait between polls. */
  intervalSec: number
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
  scopes: string[]
  /**
   * Epoch ms the *refresh* token dies, where the platform says so.
   *
   * Twitch omits it: a Confidential client's refresh token has no timer, and
   * only a password change or a revoked authorisation ends it. Kick returns
   * `refresh_expires_in`, so its logins do lapse - the value is not documented,
   * which is why it is recorded rather than assumed.
   */
  refreshExpiresAt?: number
}

/** How a single poll of the token endpoint turned out. */
export type PollOutcome =
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'granted'; tokens: TokenSet }
  | { status: 'denied'; detail: string }
  | { status: 'expired'; detail: string }
  | { status: 'error'; detail: string }

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Turns `expires_in` seconds into an absolute deadline. */
export function deadline(expiresIn: unknown, fallbackSec: number, now = Date.now()): number {
  const secs = Number(expiresIn)
  return now + (Number.isFinite(secs) && secs > 0 ? secs : fallbackSec) * 1000
}

/**
 * Classifies a token-endpoint reply.
 *
 * Split out from the request so the state machine can be tested without a
 * network: the interesting cases are all failure shapes, and Twitch signals
 * "not yet" with an HTTP 400 that must not be treated as a real error.
 */
export function readPoll(body: unknown, ok: boolean, now = Date.now()): PollOutcome {
  const b = rec(body)
  const token = str(b['access_token'])
  if (ok && token) {
    const scope = b['scope']
    return {
      status: 'granted',
      tokens: {
        accessToken: token,
        refreshToken: str(b['refresh_token']),
        expiresAt: deadline(b['expires_in'], 4 * 3600, now),
        scopes: Array.isArray(scope) ? scope.map(str).filter(Boolean) : TWITCH_SCOPES
      }
    }
  }

  // Twitch is inconsistent about where it puts this - `message` on some
  // responses, `error` on others - so both are checked.
  const reason = (str(b['message']) || str(b['error']) || '').toLowerCase()
  if (reason.includes('authorization_pending') || reason.includes('authorization pending')) {
    return { status: 'pending' }
  }
  if (reason.includes('slow_down') || reason.includes('slow down')) return { status: 'slow-down' }
  if (reason.includes('denied') || reason.includes('access_denied')) {
    return { status: 'denied', detail: 'You declined the request on Twitch' }
  }
  if (reason.includes('expired') || reason.includes('invalid device code')) {
    return {
      status: 'expired',
      detail: 'The code expired before it was approved'
    }
  }
  return { status: 'error', detail: reason || 'Twitch refused the request' }
}

async function postForm(
  url: string,
  form: Record<string, string>
): Promise<{ body: unknown; ok: boolean }> {
  const res = await browserFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  const text = await res.text()
  let body: unknown = {}
  try {
    body = JSON.parse(text)
  } catch {
    /* an empty or non-JSON body is handled by the callers below */
  }
  return { body, ok: res.ok }
}

/** Asks Twitch for a code to show the user. */
export async function startDeviceFlow(
  clientId: string,
  scopes = TWITCH_SCOPES
): Promise<DeviceStart> {
  if (!clientId) {
    throw new Error('Hydracast was built without a Twitch client id - see main/auth/device.ts')
  }
  const { body, ok } = await postForm(DEVICE_URL, {
    client_id: clientId,
    scopes: scopes.join(' ')
  })
  const b = rec(body)
  const deviceCode = str(b['device_code'])
  const userCode = str(b['user_code'])
  if (!ok || !deviceCode || !userCode) {
    throw new Error(str(b['message']) || 'Twitch would not start the login')
  }
  return {
    deviceCode,
    userCode,
    verificationUri: str(b['verification_uri']) || 'https://www.twitch.tv/activate',
    expiresAt: deadline(b['expires_in'], 1800),
    intervalSec: Math.max(1, Number(b['interval']) || 5)
  }
}

/** One poll of the token endpoint for a device code that may not be approved yet. */
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  scopes = TWITCH_SCOPES
): Promise<PollOutcome> {
  try {
    const { body, ok } = await postForm(TOKEN_URL, {
      client_id: clientId,
      scopes: scopes.join(' '),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    return readPoll(body, ok)
  } catch (err) {
    // A dropped connection mid-flow is not a denial; keep polling.
    return { status: 'pending' }
  }
}

/**
 * Reads a refresh reply, whoever relayed it.
 *
 * Separated from the request so the failure shapes can be tested without a
 * network, and so the broker's own errors are told apart from Twitch's: a
 * broker that could not be reached has passed no judgement on the token, and
 * deleting a working login over it is the wrong answer.
 */
export function readRefresh(
  body: unknown,
  ok: boolean,
  previousRefreshToken: string,
  now = Date.now()
): TokenSet {
  const b = rec(body)
  const token = str(b['access_token'])
  if (!ok || !token) {
    throw new RefreshError(
      str(b['message']) || str(b['detail']) || str(b['error']) || 'Twitch rejected the refresh token'
    )
  }
  const scope = b['scope']
  return {
    accessToken: token,
    // Twitch returns a fresh single-use refresh token; fall back to the old one
    // only if it omits it, which would otherwise strand the account.
    refreshToken: str(b['refresh_token']) || previousRefreshToken,
    expiresAt: deadline(b['expires_in'], 4 * 3600, now),
    scopes: Array.isArray(scope) ? scope.map(str).filter(Boolean) : TWITCH_SCOPES
  }
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * Goes through the broker, unlike every other call here, because Twitch will
 * not refresh for a Confidential client without the client secret - see the
 * note at the top of this file. The client id is passed for symmetry with the
 * rest of the module but the broker supplies its own; the app has no secret to
 * send and is not trusted with one.
 *
 * The reply carries a *new* refresh token and invalidates the one passed in, so
 * every caller must persist what comes back.
 */
export async function refreshTokens(_clientId: string, refreshToken: string): Promise<TokenSet> {
  const { body, ok } = await brokerPost('/twitch/refresh', { refresh_token: refreshToken })
  return readRefresh(body, ok, refreshToken)
}

/** Best-effort revocation, so Disconnect actually ends Twitch's session too. */
export async function revokeToken(clientId: string, accessToken: string): Promise<void> {
  try {
    await postForm(REVOKE_URL, { client_id: clientId, token: accessToken })
  } catch {
    /* the local token is dropped regardless; revocation is a courtesy */
  }
}
