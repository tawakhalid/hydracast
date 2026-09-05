import type { Platform, SendOutcome } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from '../http'
import type { AuthSession } from '../auth/session'
import { TWITCH_CLIENT_ID } from '../auth/device'

/**
 * Sending chat as the logged-in user.
 *
 * Reading chat needs no account, which is why the connectors are anonymous.
 * Writing is the opposite: every platform requires a user token, so this only
 * works for destinations with a connected account and reports plainly when
 * there is not one rather than dropping the message.
 */

const HELIX_MESSAGES = 'https://api.twitch.tv/helix/chat/messages'
const KICK_MESSAGES = 'https://api.kick.com/public/v1/chat'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Reads a Helix send-message reply.
 *
 * Twitch answers HTTP 200 even when it silently refused the message: the real
 * verdict is `is_sent`, and `drop_reason` says why. Treating 200 as success
 * would make blocked terms and follower-only mode look like they worked.
 */
export function readSendResult(body: unknown): { ok: boolean; detail?: string } {
  const data = rec(body)['data']
  const first = Array.isArray(data) ? rec(data[0]) : null
  if (!first) return { ok: false, detail: 'Twitch returned no result' }
  if (first['is_sent'] === true) return { ok: true }
  const reason = rec(first['drop_reason'])
  const message = str(reason['message']) || str(reason['code'])
  return { ok: false, detail: message || 'Twitch dropped the message' }
}

/**
 * Reads a Kick send reply.
 *
 * Kick nests the same `is_sent` verdict one level down and offers no drop
 * reason, so a refusal can only be reported as a refusal.
 */
export function readKickSendResult(body: unknown): { ok: boolean; detail?: string } {
  const data = rec(rec(body)['data'])
  if (data['is_sent'] === true) return { ok: true }
  return { ok: false, detail: str(rec(body)['message']) || 'Kick dropped the message' }
}

/** Both platforms reject anything longer; saying so beats a silent truncation. */
export const MAX_MESSAGE_LEN = 500

export class ChatSender {
  private session: AuthSession

  constructor(session: AuthSession) {
    this.session = session
  }

  /**
   * Sends one message to one destination. Never throws: a send that fails on
   * one platform must not stop the others in a multi-platform send.
   */
  async send(platform: Platform, text: string): Promise<SendOutcome> {
    const base = { platformId: platform.id, kind: platform.kind }
    const message = text.trim()
    if (!message) return { ...base, ok: false, detail: 'Nothing to send' }
    if (message.length > MAX_MESSAGE_LEN) {
      return { ...base, ok: false, detail: `Too long - ${message.length}/${MAX_MESSAGE_LEN}` }
    }
    if (platform.kind !== 'twitch' && platform.kind !== 'kick') {
      return { ...base, ok: false, detail: `Sending to ${platform.name} is not supported yet` }
    }

    const account = this.session.account(platform.id)
    if (!account) {
      return { ...base, ok: false, detail: `Connect your ${platform.name} account to send` }
    }
    const writeScope = platform.kind === 'kick' ? 'chat:write' : 'user:write:chat'
    if (!account.scopes.includes(writeScope)) {
      return { ...base, ok: false, detail: 'Reconnect to grant permission to send chat' }
    }

    try {
      const token = await this.session.ensureToken(platform.id)
      if (!token) return { ...base, ok: false, detail: 'Session expired - connect again' }

      if (platform.kind === 'kick') return await this.sendKick(base, account, message, token)

      const res = await browserFetch(HELIX_MESSAGES, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'client-id': TWITCH_CLIENT_ID,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          // Sending to one's own channel: broadcaster and sender are the same.
          broadcaster_id: account.userId,
          sender_id: account.userId,
          message
        })
      })
      const raw = await res.text()
      let body: unknown = {}
      try {
        body = JSON.parse(raw)
      } catch {
        return { ...base, ok: false, detail: `Twitch replied HTTP ${res.status}` }
      }
      if (!res.ok) {
        return { ...base, ok: false, detail: str(rec(body)['message']) || `HTTP ${res.status}` }
      }
      const result = readSendResult(body)
      return { ...base, ok: result.ok, detail: result.detail }
    } catch (err) {
      return { ...base, ok: false, detail: (err as Error).message }
    }
  }

  /**
   * Kick's equivalent request.
   *
   * `type: 'user'` posts as the account itself rather than as a bot, which is
   * what a streamer typing in their own composer expects; sending as a bot
   * would show a different name beside the message.
   */
  private async sendKick(
    base: { platformId: string; kind: SendOutcome['kind'] },
    account: { userId: string },
    message: string,
    token: string
  ): Promise<SendOutcome> {
    const res = await browserFetch(KICK_MESSAGES, {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        content: message,
        type: 'user',
        broadcaster_user_id: Number(account.userId)
      })
    })
    const raw = await res.text()
    let body: unknown = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      return { ...base, ok: false, detail: `Kick replied HTTP ${res.status}` }
    }
    if (!res.ok) {
      return { ...base, ok: false, detail: str(rec(body)['message']) || `HTTP ${res.status}` }
    }
    const result = readKickSendResult(body)
    return { ...base, ok: result.ok, detail: result.detail }
  }

  /*
   * There is deliberately no local echo here.
   *
   * The first cut added one, on the assumption that a user's own message does
   * not come back over the anonymous IRC connection. It does: justinfan
   * receives every PRIVMSG in the channel, including messages this app sends
   * through the API, so echoing produced every sent message twice. Waiting for
   * the real one costs about a tenth of a second and is always accurate.
   */
}
