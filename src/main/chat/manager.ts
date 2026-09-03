import { EventEmitter } from 'events'
import type { ActivityEvent, ChatMessage, ChatStatus, Platform } from '@shared/types'
import { supportsChat } from '@shared/types'
import { KickChat } from './kick'
import { TwitchChat } from './twitch'
import { YouTubeChat } from './youtube'

type Connector = TwitchChat | YouTubeChat | KickChat

/**
 * Owns one chat connector per platform and merges every message into a single
 * timestamped feed for the renderer.
 */
export class ChatManager extends EventEmitter {
  private connectors = new Map<string, Connector>()
  private status = new Map<string, ChatStatus>()
  private buffer: ChatMessage[] = []
  private activity: ActivityEvent[] = []
  private bufferSize: number

  constructor(bufferSize = 500) {
    super()
    this.bufferSize = bufferSize
  }

  setBufferSize(size: number): void {
    this.bufferSize = Math.max(50, size)
  }

  getStatus(): Record<string, ChatStatus> {
    return Object.fromEntries(this.status)
  }

  getHistory(): ChatMessage[] {
    return this.buffer
  }

  clearHistory(): void {
    this.buffer = []
  }

  getActivity(): ActivityEvent[] {
    return this.activity
  }

  clearActivity(): void {
    this.activity = []
  }

  /** Twitch, YouTube and Kick all have a read path that needs no OAuth login. */
  private supports(platform: Platform): boolean {
    return supportsChat(platform.kind)
  }

  private createConnector(platform: Platform): Connector | null {
    switch (platform.kind) {
      case 'twitch':
        return new TwitchChat(platform)
      case 'youtube':
        return new YouTubeChat(platform)
      case 'kick':
        return new KickChat(platform)
      default:
        return null
    }
  }

  connect(platform: Platform): void {
    this.disconnect(platform.id)
    if (!platform.chat.enabled || !this.supports(platform)) return

    const connector = this.createConnector(platform)
    if (!connector) return

    connector.on('message', (message: ChatMessage) => {
      this.buffer.push(message)
      if (this.buffer.length > this.bufferSize) {
        this.buffer.splice(0, this.buffer.length - this.bufferSize)
      }
      this.emit('message', message)
    })

    connector.on('activity', (event: ActivityEvent) => {
      this.activity.push(event)
      if (this.activity.length > this.bufferSize) {
        this.activity.splice(0, this.activity.length - this.bufferSize)
      }
      this.emit('activity', event)
    })

    // Kick's non-chat events are undocumented; surface anything unmapped so the
    // mapping can be corrected from evidence instead of guesswork.
    connector.on('unknown-event', (name: string) => {
      this.emit('unknown-event', platform.name, name)
    })

    connector.on('status', (state: ChatStatus['state'], detail?: string) => {
      this.status.set(platform.id, { platformId: platform.id, state, detail })
      this.emit('status', platform.id, state, detail)
    })

    this.connectors.set(platform.id, connector)
    this.status.set(platform.id, { platformId: platform.id, state: 'connecting' })
    void connector.connect()
  }

  disconnect(platformId: string): void {
    const connector = this.connectors.get(platformId)
    if (!connector) return
    connector.removeAllListeners()
    connector.disconnect()
    this.connectors.delete(platformId)
    this.status.set(platformId, { platformId, state: 'disconnected' })
  }

  /** Reconnects everything that should be connected, drops everything else. */
  sync(platforms: Platform[]): void {
    for (const id of [...this.connectors.keys()]) {
      if (!platforms.some((p) => p.id === id)) this.disconnect(id)
    }
    for (const platform of platforms) {
      const shouldConnect = platform.chat.enabled && this.supports(platform)
      const isConnected = this.connectors.has(platform.id)
      if (shouldConnect && !isConnected) this.connect(platform)
      if (!shouldConnect && isConnected) this.disconnect(platform.id)
    }
  }

  reconnect(platform: Platform): void {
    this.connect(platform)
  }

  dispose(): void {
    for (const id of [...this.connectors.keys()]) this.disconnect(id)
    this.buffer = []
    this.activity = []
  }
}
