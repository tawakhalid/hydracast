import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { ActivityEvent, ActivityKind, ChatMessage, Platform } from '@shared/types'

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'

/**
 * Twitch delivers subs, gifts and raids as USERNOTICE on the same anonymous
 * connection as chat, so the whole set is readable with no token. Follows are
 * the one thing missing - they exist only in EventSub, which requires OAuth.
 */
const NOTICE_KINDS: Record<string, ActivityKind> = {
  sub: 'subscription',
  resub: 'subscription',
  subgift: 'gift',
  submysterygift: 'gift',
  anonsubgift: 'gift',
  anonsubmysterygift: 'gift',
  giftpaidupgrade: 'subscription',
  anongiftpaidupgrade: 'subscription',
  primepaidupgrade: 'subscription',
  raid: 'raid',
  announcement: 'announcement'
}

/** Parses the IRCv3 tag blob that precedes a Twitch PRIVMSG. */
function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    const key = pair.slice(0, idx)
    const value = pair
      .slice(idx + 1)
      .replace(/\\s/g, ' ')
      .replace(/\\:/g, ';')
      .replace(/\\\\/g, '\\')
    tags[key] = value
  }
  return tags
}

/**
 * Read-only Twitch chat via anonymous IRC (the `justinfan` login), so no OAuth
 * token or account linking is required to display an audience feed.
 */
export class TwitchChat extends EventEmitter {
  private ws: WebSocket | null = null
  private platform: Platform
  private channel: string
  private reconnectTimer: NodeJS.Timeout | null = null
  private closedByUs = false

  constructor(platform: Platform) {
    super()
    this.platform = platform
    this.channel = (platform.chat.twitchChannel || '').trim().replace(/^#/, '').toLowerCase()
  }

  connect(): void {
    if (!this.channel) {
      this.emit('status', 'error', 'No Twitch channel set')
      return
    }
    this.closedByUs = false
    this.emit('status', 'connecting')

    const ws = new WebSocket(IRC_URL)
    this.ws = ws

    ws.on('open', () => {
      const nick = `justinfan${Math.floor(Math.random() * 80000 + 1000)}`
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      ws.send(`NICK ${nick}`)
      ws.send(`JOIN #${this.channel}`)
      this.emit('status', 'connected', `#${this.channel}`)
    })

    ws.on('message', (data) => this.handle(data.toString()))

    ws.on('error', (err) => {
      this.emit('status', 'error', err.message)
    })

    ws.on('close', () => {
      this.ws = null
      if (this.closedByUs) {
        this.emit('status', 'disconnected')
        return
      }
      this.emit('status', 'error', 'Disconnected - retrying')
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
    })
  }

  private handle(raw: string): void {
    for (const line of raw.split('\r\n')) {
      if (!line) continue

      if (line.startsWith('PING')) {
        this.ws?.send('PONG :tmi.twitch.tv')
        continue
      }

      // @tags :tmi.twitch.tv USERNOTICE #channel [:message]
      const notice = line.match(/^(@[^ ]+ )?:tmi\.twitch\.tv USERNOTICE #([^ ]+)(?: :(.*))?$/)
      if (notice) {
        this.handleNotice(notice[1] ? parseTags(notice[1].slice(1).trim()) : {}, notice[3])
        continue
      }

      // @tags :nick!user@host PRIVMSG #channel :message
      const match = line.match(/^(@[^ ]+ )?:([^!]+)![^ ]+ PRIVMSG #([^ ]+) :(.*)$/)
      if (!match) continue

      const tags = match[1] ? parseTags(match[1].slice(1).trim()) : {}
      const login = match[2]
      const text = match[4]
      const badges = (tags['badges'] || '')
        .split(',')
        .filter(Boolean)
        .map((b) => b.split('/')[0])

      const message: ChatMessage = {
        id: tags['id'] || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        platformId: this.platform.id,
        platformKind: 'twitch',
        // Twitch stamps the message server-side; prefer it over arrival time.
        timestamp: tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now(),
        author: tags['display-name'] || login,
        authorColor: tags['color'] || undefined,
        message: text,
        badges,
        isModerator: tags['mod'] === '1' || badges.includes('moderator'),
        isSubscriber: tags['subscriber'] === '1' || badges.includes('subscriber'),
        isOwner: badges.includes('broadcaster')
      }
      this.emit('message', message)

      // Cheers ride along on an ordinary message rather than a USERNOTICE.
      const bits = Number(tags['bits'])
      if (bits > 0) {
        this.emit('activity', {
          id: `${message.id}-bits`,
          platformId: this.platform.id,
          platformKind: 'twitch',
          timestamp: message.timestamp,
          kind: 'cheer',
          actor: message.author,
          detail: `cheered ${bits} bits`,
          amount: bits,
          amountLabel: `${bits} bits`,
          message: text
        } satisfies ActivityEvent)
      }
    }
  }

  /** Turns a USERNOTICE into an activity event. */
  private handleNotice(tags: Record<string, string>, userMessage?: string): void {
    const msgId = tags['msg-id'] || ''
    const kind = NOTICE_KINDS[msgId]
    if (!kind) return

    const actor = tags['display-name'] || tags['login'] || 'someone'
    // Twitch ships a ready-made human sentence; prefer it over rebuilding one.
    const detail = (tags['system-msg'] || msgId).trim()

    let amount: number | undefined
    let amountLabel: string | undefined
    if (kind === 'raid') {
      amount = Number(tags['msg-param-viewerCount']) || undefined
      if (amount) amountLabel = `${amount} viewer${amount === 1 ? '' : 's'}`
    } else if (msgId === 'submysterygift' || msgId === 'anonsubmysterygift') {
      amount = Number(tags['msg-param-mass-gift-count']) || undefined
      if (amount) amountLabel = `${amount} sub${amount === 1 ? '' : 's'}`
    } else {
      const months = Number(tags['msg-param-cumulative-months'])
      if (months > 0) {
        amount = months
        amountLabel = `${months} month${months === 1 ? '' : 's'}`
      }
    }

    this.emit('activity', {
      id: tags['id'] || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platformId: this.platform.id,
      platformKind: 'twitch',
      timestamp: tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now(),
      kind,
      actor,
      detail,
      amount,
      amountLabel,
      message: userMessage || undefined
    } satisfies ActivityEvent)
  }

  disconnect(): void {
    this.closedByUs = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    this.ws = null
    this.emit('status', 'disconnected')
  }
}
