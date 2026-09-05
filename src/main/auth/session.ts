import { EventEmitter } from 'events'
import { shell } from 'electron'
import type { AuthAccount, AuthStatus, LogEntry, Platform } from '@shared/types'
import { supportsAuth } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from '../http'
import { TokenStore, type StoredToken } from './store'
import { RefreshError } from './broker'
import {
  pollDeviceFlow,
  refreshTokens,
  revokeToken,
  startDeviceFlow,
  TWITCH_CLIENT_ID,
  TWITCH_SCOPES
} from './device'
import {
  awaitCallback,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  fetchChannel,
  refreshKickTokens,
  KICK_SCOPES
} from './kick'

/**
 * Owns every connected account: the login flow, token refresh, and the two
 * things a token is actually spent on - the user's identity and their stream
 * key.
 *
 * Emits rather than writing config itself. The stream key it fetches belongs in
 * the platform record, but this file has no business knowing how config is
 * persisted, so it hands the value up and `index.ts` applies it.
 */

const HELIX = 'https://api.twitch.tv/helix'

/** Refresh this far ahead of expiry, so a request never races the deadline. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** True when a stored token is close enough to expiry to be worth replacing. */
export function needsRefresh(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - now <= REFRESH_MARGIN_MS
}

/** Reads the identity out of a Helix `/users` response. */
export function readIdentity(body: unknown): {
  userId: string
  login: string
  displayName: string
  avatarUrl?: string
} | null {
  const data = rec(body)['data']
  const first = Array.isArray(data) ? rec(data[0]) : null
  if (!first) return null
  const userId = str(first['id'])
  const login = str(first['login'])
  if (!userId || !login) return null
  return {
    userId,
    login,
    displayName: str(first['display_name']) || login,
    avatarUrl: str(first['profile_image_url']) || undefined
  }
}

/** Reads the key out of a Helix `/streams/key` response. */
export function readStreamKey(body: unknown): string {
  const data = rec(body)['data']
  const first = Array.isArray(data) ? rec(data[0]) : null
  return first ? str(first['stream_key']) : ''
}

interface Pending {
  platformId: string
  timer: NodeJS.Timeout | null
  cancelled: boolean
  /** Kick's flow waits on a socket rather than a timer; this closes it. */
  cancel?: () => void
}

export class AuthSession extends EventEmitter {
  private store = new TokenStore()
  private platforms = new Map<string, Platform>()
  private status = new Map<string, AuthStatus>()
  private pending = new Map<string, Pending>()

  private log(level: LogEntry['level'], message: string): void {
    this.emit('log', level, message)
  }

  private touch(): void {
    this.emit('status')
  }

  init(platforms: Platform[]): void {
    this.store.init()
    this.syncPlatforms(platforms)
    // Restore what was saved, refreshing anything that expired while closed.
    for (const [id, token] of Object.entries(this.store.all())) {
      const platform = this.platforms.get(id)
      if (!platform) continue
      this.status.set(id, { platformId: id, state: 'connected', account: accountOf(token) })
      if (needsRefresh(token.expiresAt)) void this.ensureToken(id)
    }
    if (!this.store.persistent) {
      this.log('warn', 'This system offers no secure storage - logins will not be remembered')
    }
    this.touch()
  }

  syncPlatforms(platforms: Platform[]): void {
    this.platforms = new Map(platforms.map((p) => [p.id, p]))
    this.store.prune(platforms.map((p) => p.id))
    for (const id of [...this.status.keys()]) {
      if (!this.platforms.has(id)) this.status.delete(id)
    }
    // Every auth-capable destination gets a row, so the UI can show a Connect
    // button without inventing state for it.
    for (const p of platforms) {
      if (!supportsAuth(p.kind) || this.status.has(p.id)) continue
      this.status.set(p.id, { platformId: p.id, state: 'disconnected' })
    }
  }

  getStatus(): Record<string, AuthStatus> {
    return Object.fromEntries(this.status)
  }

  /** The account connected for a destination, if any. */
  account(platformId: string): AuthAccount | undefined {
    return this.status.get(platformId)?.account
  }

  /* ------------------------------------------------------------ connect ---*/

  async connect(platformId: string): Promise<void> {
    const platform = this.platforms.get(platformId)
    if (!platform || !supportsAuth(platform.kind)) return

    this.cancel(platformId)
    this.status.set(platformId, { platformId, state: 'pending' })
    this.touch()

    // The two platforms need genuinely different flows: Twitch shows a code the
    // user types elsewhere, Kick sends them to a browser and waits for a
    // redirect back. Only the outcome is shared.
    if (platform.kind === 'kick') {
      await this.connectKick(platformId)
      return
    }

    let start: Awaited<ReturnType<typeof startDeviceFlow>>
    try {
      start = await startDeviceFlow(TWITCH_CLIENT_ID)
    } catch (err) {
      this.fail(platformId, (err as Error).message)
      return
    }

    this.status.set(platformId, {
      platformId,
      state: 'pending',
      verification: {
        userCode: start.userCode,
        url: start.verificationUri,
        expiresAt: start.expiresAt
      }
    })
    this.touch()
    this.log('info', `${platform.name}: waiting for you to approve the code on Twitch`)

    const entry: Pending = { platformId, timer: null, cancelled: false }
    this.pending.set(platformId, entry)

    let intervalMs = start.intervalSec * 1000
    const tick = async (): Promise<void> => {
      if (entry.cancelled) return
      if (Date.now() > start.expiresAt) {
        this.fail(platformId, 'The code expired before it was approved')
        return
      }

      const outcome = await pollDeviceFlow(TWITCH_CLIENT_ID, start.deviceCode)
      if (entry.cancelled) return

      switch (outcome.status) {
        case 'granted':
          this.pending.delete(platformId)
          await this.completeConnect(platformId, outcome.tokens)
          return
        case 'slow-down':
          // Twitch asks us to back off; obeying is what stops it refusing.
          intervalMs += 2000
          break
        case 'denied':
        case 'expired':
          this.fail(platformId, outcome.detail)
          return
        case 'error':
          this.fail(platformId, outcome.detail)
          return
        default:
          break
      }
      entry.timer = setTimeout(() => void tick(), intervalMs)
    }
    entry.timer = setTimeout(() => void tick(), intervalMs)
  }

  /**
   * Kick's half: authorization code + PKCE, with the browser doing the talking.
   *
   * The verifier stays in this process and the secret stays on the broker, so
   * neither half alone can mint a token. The loopback listener is opened before
   * the browser so a fast approval cannot arrive before anything is listening.
   */
  private async connectKick(platformId: string): Promise<void> {
    const platform = this.platforms.get(platformId)
    if (!platform) return

    const pkce = createPkce()
    const listener = awaitCallback(pkce.state)
    const entry: Pending = { platformId, timer: null, cancelled: false, cancel: listener.cancel }
    this.pending.set(platformId, entry)

    const url = buildAuthUrl(pkce)
    this.status.set(platformId, {
      platformId,
      state: 'pending',
      // No user code to read out: Kick approves in the page that just opened.
      verification: { userCode: '', url, expiresAt: Date.now() + 5 * 60_000 }
    })
    this.touch()
    this.log('info', `${platform.name}: approve the login in your browser`)

    try {
      await shell.openExternal(url)
    } catch (err) {
      listener.cancel()
      this.fail(platformId, `Could not open your browser - ${(err as Error).message}`)
      return
    }

    const outcome = await listener.result
    if (entry.cancelled) return
    this.pending.delete(platformId)

    if (outcome.status !== 'code') {
      this.fail(platformId, outcome.detail)
      return
    }

    try {
      const tokens = await exchangeCode(outcome.code, pkce.verifier)
      await this.completeKick(platformId, tokens)
    } catch (err) {
      this.fail(platformId, (err as Error).message)
    }
  }

  /**
   * Finishes a Kick login.
   *
   * One channels call covers what takes three on Twitch: who the account is,
   * the ingest URL, and the stream key. There is no separate stream-key
   * endpoint on Kick - every candidate path 404s - so this is the only source.
   */
  private async completeKick(
    platformId: string,
    tokens: Awaited<ReturnType<typeof exchangeCode>>
  ): Promise<void> {
    const platform = this.platforms.get(platformId)
    if (!platform) return
    try {
      const channel = await fetchChannel(tokens.accessToken)
      if (!channel.slug) throw new Error('Kick did not return a channel')

      const token: StoredToken = {
        kind: 'kick',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length ? tokens.scopes : KICK_SCOPES,
        userId: String(channel.broadcasterUserId),
        login: channel.slug,
        // `user:read` is not requested, so the slug is the only name available -
        // and being the channel name, it is the one that matters here anyway.
        displayName: channel.slug,
        avatarUrl: channel.bannerUrl || undefined
      }
      this.store.set(platformId, token)
      this.status.set(platformId, { platformId, state: 'connected', account: accountOf(token) })
      this.touch()
      this.log('success', `${platform.name}: connected as ${channel.slug}`)

      this.emit('identity', platformId, channel.slug)
      if (tokens.refreshExpiresAt) {
        const days = Math.round((tokens.refreshExpiresAt - Date.now()) / 86_400_000)
        this.log('info', `${platform.name}: this login is good for about ${days} days`)
      }
      if (channel.rtmpUrl) this.emit('ingest-url', platformId, channel.rtmpUrl)
      if (channel.streamKey) {
        this.emit('stream-key', platformId, channel.streamKey)
        this.log('success', `${platform.name}: stream key filled in from your account`)
      }
    } catch (err) {
      this.fail(platformId, (err as Error).message)
    }
  }

  private async completeConnect(
    platformId: string,
    tokens: Awaited<ReturnType<typeof refreshTokens>>
  ): Promise<void> {
    const platform = this.platforms.get(platformId)
    if (!platform) return
    try {
      const identity = readIdentity(await this.helix('/users', tokens.accessToken))
      if (!identity) throw new Error('Twitch did not return an account')

      const token: StoredToken = {
        kind: 'twitch',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        ...identity
      }
      this.store.set(platformId, token)
      this.status.set(platformId, {
        platformId,
        state: 'connected',
        account: accountOf(token)
      })
      this.touch()
      this.log('success', `${platform.name}: connected as ${identity.displayName}`)

      // The channel name is the login, so chat no longer needs typing either.
      this.emit('identity', platformId, identity.login)
      await this.pullStreamKey(platformId)
    } catch (err) {
      this.fail(platformId, (err as Error).message)
    }
  }

  /* --------------------------------------------------------- stream key ---*/

  /** Fetches the stream key and hands it up to be written into the config. */
  async pullStreamKey(platformId: string): Promise<string> {
    const token = this.store.get(platformId)
    const platform = this.platforms.get(platformId)
    if (!token || !platform) return ''

    if (token.kind === 'kick') {
      try {
        const access = await this.ensureToken(platformId)
        if (!access) return ''
        const channel = await fetchChannel(access)
        if (channel.rtmpUrl) this.emit('ingest-url', platformId, channel.rtmpUrl)
        if (!channel.streamKey) throw new Error('Kick returned no stream key')
        this.emit('stream-key', platformId, channel.streamKey)
        this.log('success', `${platform.name}: stream key filled in from your account`)
        return channel.streamKey
      } catch (err) {
        this.log(
          'warn',
          `${platform.name}: could not read the stream key - ${(err as Error).message}`
        )
        return ''
      }
    }

    if (!token.scopes.includes('channel:read:stream_key')) {
      this.log('warn', `${platform.name}: reconnect to grant permission to read the stream key`)
      return ''
    }
    try {
      const access = await this.ensureToken(platformId)
      if (!access) return ''
      const body = await this.helix(`/streams/key?broadcaster_id=${token.userId}`, access)
      const key = readStreamKey(body)
      if (!key) throw new Error('Twitch returned no stream key')
      this.emit('stream-key', platformId, key)
      this.log('success', `${platform.name}: stream key filled in from your account`)
      return key
    } catch (err) {
      this.log(
        'warn',
        `${platform.name}: could not read the stream key - ${(err as Error).message}`
      )
      return ''
    }
  }

  /* -------------------------------------------------------------- token ---*/

  /**
   * A usable access token, refreshed if it is at or near expiry. Twitch issues
   * only four hours, so a long broadcast crosses this more than once.
   */
  async ensureToken(platformId: string): Promise<string> {
    const token = this.store.get(platformId)
    if (!token) return ''
    if (!needsRefresh(token.expiresAt)) return token.accessToken

    try {
      // Kick refreshes through the broker, because Kick demands the client
      // secret even here; Twitch refreshes directly, needing none.
      const next =
        token.kind === 'kick'
          ? await refreshKickTokens(token.refreshToken)
          : await refreshTokens(TWITCH_CLIENT_ID, token.refreshToken)
      // The old refresh token is now dead; persisting the replacement is what
      // keeps the account connected across restarts.
      this.store.update(platformId, {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: next.expiresAt,
        scopes: next.scopes
      })
      const updated = this.store.get(platformId)!
      this.status.set(platformId, {
        platformId,
        state: 'connected',
        account: accountOf(updated)
      })
      this.touch()
      return next.accessToken
    } catch (err) {
      const name = this.platforms.get(platformId)?.name ?? 'Account'

      // Being unable to ask is not the same as being told no. A refusal ends
      // the session; an unreachable network says nothing about the token, and
      // discarding a good login over a Wi-Fi drop would force a login the user
      // never needed. The stored token survives and the next call tries again.
      if (err instanceof RefreshError && err.retryable) {
        this.log('warn', `${name}: could not renew the login just now - ${err.message}`)
        return ''
      }

      // Refused: the refresh token is spent or revoked and no retry will help.
      this.store.remove(platformId)
      this.status.set(platformId, {
        platformId,
        state: 'error',
        detail: `Session expired - connect again (${(err as Error).message})`,
        // A login that used to work has stopped; the UI may say so unprompted.
        needsReconnect: true
      })
      this.touch()
      this.log('warn', `${name}: session expired, reconnect to restore it`)
      return ''
    }
  }

  private async helix(pathAndQuery: string, accessToken: string): Promise<unknown> {
    const res = await browserFetch(`${HELIX}${pathAndQuery}`, {
      headers: {
        ...BROWSER_HEADERS,
        'client-id': TWITCH_CLIENT_ID,
        authorization: `Bearer ${accessToken}`
      }
    })
    const text = await res.text()
    let body: unknown = {}
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`Twitch returned a non-JSON reply (HTTP ${res.status})`)
    }
    if (!res.ok) throw new Error(str(rec(body)['message']) || `HTTP ${res.status}`)
    return body
  }

  /* --------------------------------------------------------- disconnect ---*/

  cancel(platformId: string): void {
    const entry = this.pending.get(platformId)
    if (!entry) return
    entry.cancelled = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.cancel?.()
    this.pending.delete(platformId)
  }

  async disconnect(platformId: string): Promise<void> {
    this.cancel(platformId)
    const token = this.store.get(platformId)
    // Kick publishes no revocation endpoint, so its tokens are simply dropped
    // and left to expire; Twitch's are revoked so the session really ends.
    if (token && token.kind === 'twitch') await revokeToken(TWITCH_CLIENT_ID, token.accessToken)
    this.store.remove(platformId)
    this.status.set(platformId, { platformId, state: 'disconnected' })
    this.touch()
    const name = this.platforms.get(platformId)?.name ?? 'Account'
    this.log('info', `${name}: disconnected`)
  }

  private fail(platformId: string, detail: string): void {
    this.cancel(platformId)
    this.status.set(platformId, { platformId, state: 'error', detail })
    this.touch()
    const name = this.platforms.get(platformId)?.name ?? 'Account'
    this.log('error', `${name}: ${detail}`)
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id)
  }
}

function accountOf(token: StoredToken): AuthAccount {
  return {
    kind: token.kind,
    userId: token.userId,
    login: token.login,
    displayName: token.displayName,
    avatarUrl: token.avatarUrl,
    scopes: token.scopes,
    expiresAt: token.expiresAt
  }
}

export { TWITCH_SCOPES }
