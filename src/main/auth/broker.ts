import { browserFetch } from '../http'

/**
 * The hosted half of both logins.
 *
 * Neither platform will refresh a token for a Confidential client without the
 * client secret, and a secret shipped inside an unpacked Electron app is a
 * secret published. So the app keeps the user's tokens and this Worker keeps
 * the app's secret; a refresh needs both halves and neither side can act alone.
 *
 * Kick needed this from the start - it has no public client type at all. Twitch
 * needed it too, which was missed: its *device* grant accepts a Confidential
 * client with no secret, so logging in worked, and only the refresh grant
 * rejects one. That difference hid a broken refresh behind a working login.
 */
export const BROKER_BASE = 'https://hydracast-broker.tawakhalid.workers.dev'

/**
 * A refresh that did not produce a token.
 *
 * `retryable` is the whole point of this class. A provider that says the token
 * is no good has ended the session and the user must log in again; a broker
 * that could not be reached has said nothing at all, and treating the two alike
 * meant a dropped Wi-Fi connection silently deleted a perfectly good login.
 */
export class RefreshError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = false) {
    super(message)
    this.name = 'RefreshError'
    this.retryable = retryable
  }
}

/**
 * Posts to the broker and hands back the parsed reply.
 *
 * A 5xx is the broker itself failing rather than a verdict on the token, so it
 * is reported as retryable alongside outright transport errors.
 */
export async function brokerPost(
  path: string,
  payload: Record<string, string>
): Promise<{ body: unknown; ok: boolean; status: number }> {
  if (!BROKER_BASE) {
    throw new RefreshError('Hydracast was built without a broker URL - see main/auth/broker.ts')
  }

  let res: Response
  try {
    res = await browserFetch(`${BROKER_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch (err) {
    throw new RefreshError(`Could not reach the login service - ${(err as Error).message}`, true)
  }

  const text = await res.text()
  let body: unknown = {}
  try {
    body = JSON.parse(text)
  } catch {
    throw new RefreshError(`The login service replied HTTP ${res.status}`, res.status >= 500)
  }
  if (res.status >= 500) {
    throw new RefreshError(`The login service replied HTTP ${res.status}`, true)
  }
  return { body, ok: res.ok, status: res.status }
}
