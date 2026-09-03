import { EventEmitter } from 'events'
import type { ActivityEvent, ActivityKind, ChatMessage, Platform } from '@shared/types'

const API = 'https://www.googleapis.com/youtube/v3'

/**
 * Super chats, stickers and memberships arrive on the same polled call as
 * ordinary messages, distinguished only by `snippet.type`. No extra scope or
 * credential is needed beyond the API key already configured.
 */
const SNIPPET_KINDS: Record<string, ActivityKind> = {
  superChatEvent: 'donation',
  superStickerEvent: 'donation',
  newSponsorEvent: 'subscription',
  memberMilestoneChatEvent: 'subscription',
  membershipGiftingEvent: 'gift',
  giftMembershipReceivedEvent: 'gift'
}

interface LiveChatItem {
  id: string
  snippet?: {
    type?: string
    displayMessage?: string
    publishedAt?: string
    superChatDetails?: { amountDisplayString?: string; userComment?: string; amountMicros?: string }
    superStickerDetails?: { amountDisplayString?: string; amountMicros?: string }
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean }
    memberMilestoneChatDetails?: {
      memberLevelName?: string
      memberMonth?: number
      userComment?: string
    }
    membershipGiftingDetails?: { giftMembershipsCount?: number; giftMembershipsLevelName?: string }
  }
  authorDetails?: {
    displayName?: string
    isChatOwner?: boolean
    isChatModerator?: boolean
    isChatSponsor?: boolean
  }
}

/**
 * YouTube live chat via the Data API v3. Needs an API key; the video id can be
 * given directly, or discovered from a channel id when a broadcast is active.
 */
export class YouTubeChat extends EventEmitter {
  private platform: Platform
  private timer: NodeJS.Timeout | null = null
  private nextPageToken: string | undefined
  private liveChatId: string | null = null
  private stopped = false
  private seen = new Set<string>()

  constructor(platform: Platform) {
    super()
    this.platform = platform
  }

  private get apiKey(): string {
    return (this.platform.chat.youtubeApiKey || '').trim()
  }

  async connect(): Promise<void> {
    this.stopped = false
    if (!this.apiKey) {
      this.emit('status', 'error', 'No YouTube API key set')
      return
    }
    this.emit('status', 'connecting')
    try {
      const videoId = await this.resolveVideoId()
      if (!videoId) {
        this.emit('status', 'error', 'No active live broadcast found')
        return
      }
      this.liveChatId = await this.resolveLiveChatId(videoId)
      if (!this.liveChatId) {
        this.emit('status', 'error', 'Broadcast has no active live chat')
        return
      }
      this.emit('status', 'connected', videoId)
      void this.poll()
    } catch (err) {
      this.emit('status', 'error', (err as Error).message)
    }
  }

  private async fetchJson(url: string): Promise<any> {
    const res = await fetch(url)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const reason = body?.error?.message || `HTTP ${res.status}`
      throw new Error(reason)
    }
    return body
  }

  private async resolveVideoId(): Promise<string | null> {
    const direct = (this.platform.chat.youtubeVideoId || '').trim()
    if (direct) return this.extractVideoId(direct)

    const channelId = (this.platform.chat.youtubeChannelId || '').trim()
    if (!channelId) return null

    const url =
      `${API}/search?part=id&channelId=${encodeURIComponent(channelId)}` +
      `&eventType=live&type=video&key=${this.apiKey}`
    const data = await this.fetchJson(url)
    return data.items?.[0]?.id?.videoId ?? null
  }

  /** Accepts a bare id, a watch URL, or a youtu.be short link. */
  private extractVideoId(input: string): string {
    const match = input.match(/(?:v=|youtu\.be\/|live\/)([A-Za-z0-9_-]{11})/)
    return match ? match[1] : input
  }

  private async resolveLiveChatId(videoId: string): Promise<string | null> {
    const url = `${API}/videos?part=liveStreamingDetails&id=${videoId}&key=${this.apiKey}`
    const data = await this.fetchJson(url)
    return data.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.liveChatId) return
    try {
      const page = this.nextPageToken ? `&pageToken=${this.nextPageToken}` : ''
      const url =
        `${API}/liveChat/messages?liveChatId=${this.liveChatId}` +
        `&part=snippet,authorDetails&maxResults=200${page}&key=${this.apiKey}`
      const data = await this.fetchJson(url)

      this.nextPageToken = data.nextPageToken
      for (const item of (data.items ?? []) as LiveChatItem[]) {
        if (this.seen.has(item.id)) continue
        this.seen.add(item.id)
        this.emitActivity(item)

        const text = item.snippet?.displayMessage
        if (!text) continue
        const message: ChatMessage = {
          id: item.id,
          platformId: this.platform.id,
          platformKind: 'youtube',
          timestamp: item.snippet?.publishedAt
            ? new Date(item.snippet.publishedAt).getTime()
            : Date.now(),
          author: item.authorDetails?.displayName || 'Viewer',
          message: text,
          badges: [
            item.authorDetails?.isChatOwner ? 'owner' : '',
            item.authorDetails?.isChatModerator ? 'moderator' : '',
            item.authorDetails?.isChatSponsor ? 'member' : ''
          ].filter(Boolean),
          isModerator: !!item.authorDetails?.isChatModerator,
          isSubscriber: !!item.authorDetails?.isChatSponsor,
          isOwner: !!item.authorDetails?.isChatOwner
        }
        this.emit('message', message)
      }

      // The API tells us how long to wait; respect it to protect the quota.
      const wait = Math.max(2000, Number(data.pollingIntervalMillis) || 5000)
      this.timer = setTimeout(() => void this.poll(), wait)
    } catch (err) {
      this.emit('status', 'error', (err as Error).message)
      // Back off and retry - transient quota/network errors are common.
      this.timer = setTimeout(() => void this.poll(), 15000)
    }
  }

  /** Emits an activity event when a polled item is more than plain chat. */
  private emitActivity(item: LiveChatItem): void {
    const type = item.snippet?.type || ''
    const kind = SNIPPET_KINDS[type]
    if (!kind) return

    const actor = item.authorDetails?.displayName || 'Viewer'
    const s = item.snippet ?? {}
    let detail = type
    let amountLabel: string | undefined
    let message: string | undefined

    if (type === 'superChatEvent') {
      amountLabel = s.superChatDetails?.amountDisplayString
      detail = `sent a Super Chat${amountLabel ? ` of ${amountLabel}` : ''}`
      message = s.superChatDetails?.userComment || undefined
    } else if (type === 'superStickerEvent') {
      amountLabel = s.superStickerDetails?.amountDisplayString
      detail = `sent a Super Sticker${amountLabel ? ` of ${amountLabel}` : ''}`
    } else if (type === 'newSponsorEvent') {
      const level = s.newSponsorDetails?.memberLevelName
      detail = s.newSponsorDetails?.isUpgrade
        ? `upgraded their membership${level ? ` to ${level}` : ''}`
        : `became a member${level ? ` at ${level}` : ''}`
    } else if (type === 'memberMilestoneChatEvent') {
      const months = s.memberMilestoneChatDetails?.memberMonth
      detail = `has been a member for ${months ?? '?'} month${months === 1 ? '' : 's'}`
      if (months) amountLabel = `${months} month${months === 1 ? '' : 's'}`
      message = s.memberMilestoneChatDetails?.userComment || undefined
    } else {
      const count = s.membershipGiftingDetails?.giftMembershipsCount
      detail = `gifted ${count ?? ''} membership${count === 1 ? '' : 's'}`.replace('  ', ' ')
      if (count) amountLabel = `${count} gift${count === 1 ? '' : 's'}`
    }

    this.emit('activity', {
      id: item.id,
      platformId: this.platform.id,
      platformKind: 'youtube',
      timestamp: s.publishedAt ? new Date(s.publishedAt).getTime() : Date.now(),
      kind,
      actor,
      detail,
      amountLabel,
      message
    } satisfies ActivityEvent)
  }

  disconnect(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.liveChatId = null
    this.nextPageToken = undefined
    this.seen.clear()
    this.emit('status', 'disconnected')
  }
}
