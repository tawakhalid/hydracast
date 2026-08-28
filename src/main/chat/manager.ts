import { EventEmitter } from 'events'
import type { ChatMessage, ChatStatus, Platform } from '@shared/types'
import { TwitchChat } from './twitch'
import { YouTubeChat } from './youtube'

type Connector = TwitchChat | YouTubeChat

/**
 * Owns one chat connector per platform and merges every message into a single
 * timestamped feed for the renderer.
 */
export class ChatManager extends EventEmitter {
  private connectors = new Map<string, Connector>()
  private status = new Map<string, ChatStatus>()
  private buffer: ChatMessage[] = []
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

  /** Only Twitch and YouTube have a public read path we can use without OAuth. */
  private supports(platform: Platform): boolean {
    return platform.kind === 'twitch' || platform.kind === 'youtube'
  }

  connect(platform: Platform): void {
    this.disconnect(platform.id)
    if (!platform.chat.enabled || !this.supports(platform)) return

    const connector: Connector =
      platform.kind === 'twitch' ? new TwitchChat(platform) : new YouTubeChat(platform)

    connector.on('message', (message: ChatMessage) => {
      this.buffer.push(message)
      if (this.buffer.length > this.bufferSize) {
        this.buffer.splice(0, this.buffer.length - this.bufferSize)
      }
      this.emit('message', message)
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
  }
}
