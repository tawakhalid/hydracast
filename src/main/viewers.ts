import { EventEmitter } from 'events'
import type { LogEntry, Platform, ViewerCount } from '@shared/types'
import { supportsViewerCount } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from './http'

/**
 * Concurrent viewer counts, sampled per destination while it is live.
 *
 * Three platforms publish a number this can read. Twitch and YouTube are read
 * through their documented public APIs; Kick's channel endpoint is the same
 * undocumented one the chat connector already resolves its chatroom id from,
 * so it carries the same Cloudflare caveat.
 *
 * Polling starts when a relay reaches `live` and stops the moment it does not,
 * so a configured-but-idle destination costs nothing - which matters most for
 * YouTube, where every sample spends API quota.
 */

/** How often each platform is sampled, ms. */
const POLL_MS: Record<string, number> = {
  // Twitch's own dashboard updates on roughly this cadence, and Helix rate
  // limits per app rather than per endpoint - 30s leaves the budget alone.
  twitch: 30_000,
  // One YouTube sample costs 1 quota unit against a 10,000/day default, so a
  // 12-hour stream spends 720 of it. Tighter polling is not worth starving the
  // chat feed, which spends the same key.
  youtube: 60_000,
  kick: 20_000
}

/**
 * How long a count survives failed refreshes before it is shown as unknown.
 *
 * A brief network blip should not blank a number the user is watching, but a
 * count frozen at a stale value is worse than no count at all - so it expires.
 */
const STALE_MS = 90_000

/** Twitch app tokens are long-lived; refresh a minute before the stated expiry. */
const TOKEN_SKEW_MS = 60_000

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const TWITCH_STREAMS_URL = 'https://api.twitch.tv/helix/streams'
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'
const KICK_AUTHED_API = 'https://api.kick.com/public/v1/channels'
const KICK_CHANNEL_API = 'https://kick.com/api/v2/channels'

/**
 * Supplies a connected account's credentials for a destination, or null when
 * there is none.
 *
 * A callback rather than an import of AuthSession, so this file stays testable
 * without the auth stack and the two do not depend on each other.
 */
export type TokenProvider = (
  platformId: string
) => Promise<{ clientId: string; token: string; userId: string } | null>

/** One reading: a count, plus why it is what it is. */
export interface Sample {
  /** Concurrent viewers, or -1 when the platform will not say. */
  count: number
  detail?: string
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/**
 * Reads a Kick channel payload.
 *
 * `livestream` is null while the channel is offline, which is a real answer
 * rather than a failure: Kick has simply not registered the relay's frames yet.
 */
/**
 * Reads the authenticated `GET /public/v1/channels` payload.
 *
 * Preferred over the anonymous reader below whenever an account is connected:
 * it is an officially supported endpoint, needs no Cloudflare-dodging, and is
 * the same request that supplies the stream key, so it is already understood.
 */
export function readKickAuthedCount(body: unknown): Sample {
  const data = rec(body)['data']
  // An empty list means Kick answered about no channel at all, which is not the
  // same as a channel that is offline - reporting 0 there would be a lie.
  const first = Array.isArray(data) && data.length ? rec(data[0]) : null
  if (!first) return { count: -1, detail: 'Kick returned no channel' }
  const stream = rec(first['stream'])
  if (stream['is_live'] !== true) {
    return { count: 0, detail: 'Kick has not registered the stream as live yet' }
  }
  const count = stream['viewer_count']
  if (typeof count !== 'number') return { count: -1, detail: 'Kick returned no viewer count' }
  return { count }
}

export function readKickCount(body: unknown): Sample {
  const live = rec(body)['livestream']
  if (!live) return { count: 0, detail: 'Kick has not registered the stream as live yet' }
  const count = rec(live)['viewer_count']
  if (typeof count !== 'number') return { count: -1, detail: 'Kick returned no viewer count' }
  return { count }
}

/**
 * Reads a `videos.list(part=liveStreamingDetails)` response.
 *
 * `concurrentViewers` arrives as a string, and is absent entirely when the
 * broadcaster has hidden the count on the watch page - a setting, not an error,
 * so it is reported as such rather than as a broken key.
 */
export function readYouTubeCount(body: unknown): Sample {
  const items = rec(body)['items']
  const first = Array.isArray(items) ? items[0] : undefined
  if (!first) return { count: -1, detail: 'YouTube has no such live video' }
  const details = rec(rec(first)['liveStreamingDetails'])
  const raw = details['concurrentViewers']
  if (raw === undefined || raw === null) {
    return details['actualEndTime']
      ? { count: 0, detail: 'The YouTube broadcast has ended' }
      : { count: -1, detail: 'YouTube is not publishing a count for this broadcast' }
  }
  const count = Number(raw)
  return Number.isFinite(count) ? { count } : { count: -1, detail: 'YouTube returned no count' }
}

/** Reads a Helix `/streams` response. Empty `data` means Twitch sees no stream. */
export function readTwitchCount(body: unknown): Sample {
  const data = rec(body)['data']
  const first = Array.isArray(data) ? data[0] : undefined
  if (!first) return { count: 0, detail: 'Twitch has not registered the stream as live yet' }
  const count = rec(first)['viewer_count']
  if (typeof count !== 'number') return { count: -1, detail: 'Twitch returned no viewer count' }
  return { count }
}

/**
 * Everything about a platform that changes where its count comes from. A change
 * here restarts the poller; a bitrate nudge or a rename does not.
 */
export function viewerIdentity(p: Platform): string {
  return JSON.stringify([
    p.kind,
    p.chat.twitchChannel ?? '',
    p.chat.youtubeApiKey ?? '',
    p.chat.youtubeVideoId ?? '',
    p.chat.youtubeChannelId ?? '',
    p.chat.kickChannel ?? '',
    p.viewers?.twitchClientId ?? '',
    p.viewers?.twitchClientSecret ?? ''
  ])
}

/** Accepts a bare id, a watch URL, or a youtu.be short link. */
function extractVideoId(input: string): string {
  const match = input.match(/(?:v=|youtu\.be\/|live\/)([A-Za-z0-9_-]{11})/)
  return match ? match[1] : input
}

interface Poller {
  platform: Platform
  identity: string
  timer: NodeJS.Timeout | null
  /** Resolved once per live session so an ordinary poll is a single request. */
  youtubeVideoId: string
  /** Set while a request is in flight, so a slow reply cannot stack up. */
  busy: boolean
  /** Whether the last sample failed, so recovery is logged once, not per tick. */
  failing: boolean
}

export class ViewerCounter extends EventEmitter {
  private platforms = new Map<string, Platform>()
  private pollers = new Map<string, Poller>()
  private counts = new Map<string, ViewerCount>()
  /** Twitch app tokens, keyed by client id and shared by every platform on it. */
  private tokens = new Map<string, { token: string; expiresAt: number }>()
  /** Set once the auth stack exists; absent in tests. */
  private accountTokens: TokenProvider | null = null

  setTokenProvider(provider: TokenProvider): void {
    this.accountTokens = provider
  }

  private log(level: LogEntry['level'], message: string): void {
    this.emit('log', level, message)
  }

  syncPlatforms(platforms: Platform[]): void {
    this.platforms = new Map(platforms.map((p) => [p.id, p]))
    for (const id of [...this.pollers.keys()]) {
      const next = this.platforms.get(id)
      if (!next) {
        this.stopPolling(id)
        this.counts.delete(id)
        continue
      }
      const poller = this.pollers.get(id)!
      poller.platform = next
      // Re-resolve from scratch when the channel or the credentials moved.
      if (poller.identity !== viewerIdentity(next)) {
        this.stopPolling(id)
        this.startPolling(next)
      }
    }
  }

  /**
   * Reconciles the polling set against the destinations that are live right
   * now. Called every tick, so doing nothing is the common case.
   */
  setLive(liveIds: Set<string>): void {
    for (const id of [...this.counts.keys()]) {
      if (liveIds.has(id)) continue
      this.stopPolling(id)
      this.counts.delete(id)
    }
    for (const id of liveIds) {
      if (this.counts.has(id)) continue
      const platform = this.platforms.get(id)
      if (!platform) continue
      if (supportsViewerCount(platform.kind)) {
        this.counts.set(id, { platformId: id, count: -1, updatedAt: 0 })
        this.startPolling(platform)
      } else {
        this.counts.set(id, {
          platformId: id,
          count: -1,
          updatedAt: 0,
          detail: `${platform.name} does not publish a viewer count without an account login`
        })
      }
    }
  }

  getCounts(): Record<string, ViewerCount> {
    return Object.fromEntries(this.counts)
  }

  private startPolling(platform: Platform): void {
    const poller: Poller = {
      platform,
      identity: viewerIdentity(platform),
      timer: null,
      youtubeVideoId: '',
      busy: false,
      failing: false
    }
    this.pollers.set(platform.id, poller)
    void this.poll(platform.id)
    const every = POLL_MS[platform.kind] ?? 30_000
    poller.timer = setInterval(() => void this.poll(platform.id), every)
  }

  private stopPolling(id: string): void {
    const poller = this.pollers.get(id)
    if (!poller) return
    if (poller.timer) clearInterval(poller.timer)
    this.pollers.delete(id)
  }

  private async poll(id: string): Promise<void> {
    const poller = this.pollers.get(id)
    if (!poller || poller.busy) return
    poller.busy = true
    try {
      const sample = await this.sample(poller)
      // The relay may have stopped while the request was in flight; a count for
      // a destination that is no longer live would linger on the card.
      if (!this.pollers.has(id)) return
      this.counts.set(id, {
        platformId: id,
        count: sample.count,
        updatedAt: Date.now(),
        detail: sample.detail
      })
      if (poller.failing) {
        poller.failing = false
        this.log('info', `${poller.platform.name}: viewer count recovered`)
      }
    } catch (err) {
      if (!this.pollers.has(id)) return
      const detail = (err as Error).message
      const previous = this.counts.get(id)
      // Hold the last good number briefly, then admit that it is unknown.
      const fresh =
        !!previous && previous.updatedAt > 0 && Date.now() - previous.updatedAt < STALE_MS
      this.counts.set(id, {
        platformId: id,
        count: fresh ? previous!.count : -1,
        updatedAt: previous?.updatedAt ?? 0,
        detail
      })
      if (!poller.failing) {
        poller.failing = true
        this.log('warn', `${poller.platform.name}: viewer count unavailable - ${detail}`)
      }
    } finally {
      poller.busy = false
    }
  }

  private sample(poller: Poller): Promise<Sample> {
    switch (poller.platform.kind) {
      case 'twitch':
        return this.sampleTwitch(poller.platform)
      case 'youtube':
        return this.sampleYouTube(poller)
      default:
        return this.sampleKick(poller.platform)
    }
  }

  /** Reads a JSON body, turning a non-2xx into the API's own error message. */
  private async fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const res = await browserFetch(url, { headers: BROWSER_HEADERS, ...init })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // Kick's Cloudflare interstitial is HTML, and so is most of what a proxy
      // injects; saying so beats "Unexpected token < in JSON".
      throw new Error(res.ok ? 'Response was not JSON' : `HTTP ${res.status}`)
    }
    if (!res.ok) throw new Error(apiError(body, res.status))
    return body
  }

  private async sampleKick(platform: Platform): Promise<Sample> {
    // A connected account gets the official endpoint; everyone else falls back
    // to the undocumented one, which is all an anonymous client has.
    const account = this.accountTokens ? await this.accountTokens(platform.id) : null
    if (account) {
      return readKickAuthedCount(
        await this.fetchJson(KICK_AUTHED_API, {
          headers: { ...BROWSER_HEADERS, authorization: `Bearer ${account.token}` }
        })
      )
    }

    const slug = (platform.chat.kickChannel || '')
      .trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, '')
      .replace(/[/?#].*$/, '')
      .toLowerCase()
    if (!slug) throw new Error('No Kick channel set in Settings > Chat & viewers')
    return readKickCount(await this.fetchJson(`${KICK_CHANNEL_API}/${encodeURIComponent(slug)}`))
  }

  private async sampleYouTube(poller: Poller): Promise<Sample> {
    const key = (poller.platform.chat.youtubeApiKey || '').trim()
    if (!key) throw new Error('No YouTube API key set in Settings > Chat & viewers')

    if (!poller.youtubeVideoId) {
      poller.youtubeVideoId = await this.resolveYouTubeVideo(poller.platform, key)
    }
    const url =
      `${YOUTUBE_API}/videos?part=liveStreamingDetails` +
      `&id=${encodeURIComponent(poller.youtubeVideoId)}&key=${key}`
    const sample = readYouTubeCount(await this.fetchJson(url))
    // A finished broadcast means the id is spent; look it up again next time in
    // case the user started a new one mid-session.
    if (sample.count === 0) poller.youtubeVideoId = ''
    return sample
  }

  private async resolveYouTubeVideo(platform: Platform, key: string): Promise<string> {
    const direct = (platform.chat.youtubeVideoId || '').trim()
    if (direct) return extractVideoId(direct)

    const channelId = (platform.chat.youtubeChannelId || '').trim()
    if (!channelId) throw new Error('No YouTube video or channel id set')

    const url =
      `${YOUTUBE_API}/search?part=id&channelId=${encodeURIComponent(channelId)}` +
      `&eventType=live&type=video&key=${key}`
    const body = rec(await this.fetchJson(url))
    const items = body['items']
    const id = Array.isArray(items) ? rec(rec(items[0])['id'])['videoId'] : undefined
    if (typeof id !== 'string' || !id) throw new Error('No active YouTube broadcast found')
    return id
  }

  private async sampleTwitch(platform: Platform): Promise<Sample> {
    // A connected account is the better path by far: it needs no credential
    // from the user, and querying by user id sidesteps a renamed channel.
    const account = this.accountTokens ? await this.accountTokens(platform.id) : null
    if (account) {
      return readTwitchCount(
        await this.fetchJson(
          `${TWITCH_STREAMS_URL}?user_id=${encodeURIComponent(account.userId)}`,
          {
            headers: {
              ...BROWSER_HEADERS,
              'client-id': account.clientId,
              authorization: `Bearer ${account.token}`
            }
          }
        )
      )
    }

    const login = (platform.chat.twitchChannel || '').trim().replace(/^#/, '').toLowerCase()
    if (!login) throw new Error('No Twitch channel set in Settings > Chat & viewers')

    const clientId = (platform.viewers?.twitchClientId || '').trim()
    const secret = (platform.viewers?.twitchClientSecret || '').trim()
    if (!clientId || !secret) {
      throw new Error('Connect your Twitch account in Settings > Chat & viewers to show viewers')
    }

    const url = `${TWITCH_STREAMS_URL}?user_login=${encodeURIComponent(login)}`
    const withToken = async (token: string): Promise<unknown> =>
      this.fetchJson(url, {
        headers: { ...BROWSER_HEADERS, 'client-id': clientId, authorization: `Bearer ${token}` }
      })

    try {
      return readTwitchCount(await withToken(await this.twitchToken(clientId, secret)))
    } catch (err) {
      // A revoked or expired token is the one failure worth an instant retry.
      if (!/401|unauthorized|invalid/i.test((err as Error).message)) throw err
      this.tokens.delete(clientId)
      return readTwitchCount(await withToken(await this.twitchToken(clientId, secret)))
    }
  }

  /**
   * Client-credentials app token. It authenticates the application, not the
   * user: it can read public stream data and nothing about anyone's account,
   * which is why this is the one credential Hydracast is willing to ask for.
   */
  private async twitchToken(clientId: string, secret: string): Promise<string> {
    const cached = this.tokens.get(clientId)
    if (cached && cached.expiresAt > Date.now()) return cached.token

    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      grant_type: 'client_credentials'
    })
    const res = rec(
      await this.fetchJson(TWITCH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      })
    )
    const token = res['access_token']
    if (typeof token !== 'string' || !token) throw new Error('Twitch refused the app credentials')
    const ttl = Number(res['expires_in']) || 3600
    this.tokens.set(clientId, {
      token,
      expiresAt: Date.now() + Math.max(0, ttl * 1000 - TOKEN_SKEW_MS)
    })
    return token
  }

  dispose(): void {
    for (const id of [...this.pollers.keys()]) this.stopPolling(id)
    this.counts.clear()
    this.tokens.clear()
  }
}

/**
 * Pulls the human-readable reason out of an error body. Twitch, YouTube and
 * Kick each nest it somewhere different, and the status code alone tells the
 * user nothing they can act on.
 */
export function apiError(body: unknown, status: number): string {
  const top = rec(body)
  const nested = rec(top['error'])
  const message = top['message'] ?? nested['message'] ?? top['error_description']
  return typeof message === 'string' && message ? message : `HTTP ${status}`
}
