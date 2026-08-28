import { EventEmitter } from 'events'
import type { AppSettings, IngestState } from '@shared/types'

// node-media-server ships CommonJS with no bundled types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeMediaServer = require('node-media-server')

interface NmsSession {
  bitrate: number
  videoWidth: number
  videoHeight: number
  videoFps: number
  videoCodecName: string
  audioCodecName: string
  publishStreamPath: string
  reject: () => void
}

/**
 * Local RTMP ingest. Streamlabs publishes to rtmp://localhost:<rtmpPort>/<app>/<key>
 * and this server re-serves the same stream over HTTP-FLV for the in-app preview
 * and to every relay ffmpeg process.
 */
export class IngestServer extends EventEmitter {
  private nms: any = null
  private settings: AppSettings
  private sessionId: string | null = null
  private publishStartedAt = 0
  private state: IngestState

  constructor(settings: AppSettings) {
    super()
    this.settings = settings
    this.state = this.blankState()
  }

  private blankState(): IngestState {
    return {
      listening: false,
      publishing: false,
      bitrateKbps: 0,
      width: 0,
      height: 0,
      fps: 0,
      videoCodec: '',
      audioCodec: '',
      uptimeSec: 0,
      previewUrl: ''
    }
  }

  /** rtmp://127.0.0.1:1935/live/streamlabs — what the relays pull from. */
  get localSourceUrl(): string {
    const { rtmpPort, ingestApp, ingestKey } = this.settings
    return `rtmp://127.0.0.1:${rtmpPort}/${ingestApp}/${ingestKey}`
  }

  /** The address the user pastes into Streamlabs. */
  get publicIngestUrl(): string {
    return `rtmp://localhost:${this.settings.rtmpPort}/${this.settings.ingestApp}`
  }

  get previewUrl(): string {
    const { httpPort, ingestApp, ingestKey } = this.settings
    return `http://127.0.0.1:${httpPort}/${ingestApp}/${ingestKey}.flv`
  }

  getState(): IngestState {
    return {
      ...this.state,
      previewUrl: this.previewUrl,
      uptimeSec: this.state.publishing
        ? Math.floor((Date.now() - this.publishStartedAt) / 1000)
        : 0
    }
  }

  async start(settings?: AppSettings): Promise<void> {
    if (settings) this.settings = settings
    await this.stop()

    this.nms = new NodeMediaServer({
      logType: 0,
      rtmp: {
        port: this.settings.rtmpPort,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
      },
      http: {
        port: this.settings.httpPort,
        allow_origin: '*',
        mediaroot: undefined
      }
    })

    this.nms.on('prePublish', (id: string, streamPath: string) => {
      const expected = `/${this.settings.ingestApp}/${this.settings.ingestKey}`
      if (streamPath !== expected) {
        // Wrong key: reject so a stray encoder can never hijack the relay.
        const session = this.nms.getSession(id) as NmsSession
        this.emit('log', 'warn', `Rejected publish on ${streamPath} (expected ${expected})`)
        session?.reject()
        return
      }
      this.sessionId = id
      this.publishStartedAt = Date.now()
      this.state.publishing = true
      this.emit('log', 'success', `Encoder connected on ${streamPath}`)
      this.emit('publish-start')
    })

    this.nms.on('donePublish', (id: string) => {
      if (id !== this.sessionId) return
      this.sessionId = null
      this.state = { ...this.blankState(), listening: true }
      this.emit('log', 'warn', 'Encoder disconnected')
      this.emit('publish-stop')
    })

    this.nms.run()
    this.state.listening = true
    this.emit(
      'log',
      'info',
      `RTMP ingest listening on ${this.publicIngestUrl} (preview :${this.settings.httpPort})`
    )
  }

  /** Pulls live media info off the publishing session. Called on every tick. */
  poll(): void {
    if (!this.nms || !this.sessionId) return
    const session = this.nms.getSession(this.sessionId) as NmsSession | undefined
    if (!session) return
    // NMS computes bitrate as bits-per-millisecond, which is already kbps.
    this.state.bitrateKbps = Math.round(session.bitrate || 0)
    this.state.width = session.videoWidth || 0
    this.state.height = session.videoHeight || 0
    this.state.fps = session.videoFps || 0
    this.state.videoCodec = session.videoCodecName || ''
    this.state.audioCodec = session.audioCodecName || ''
  }

  async stop(): Promise<void> {
    if (!this.nms) return
    try {
      this.nms.stop()
    } catch {
      /* already down */
    }
    this.nms = null
    this.sessionId = null
    this.state = this.blankState()
    // NMS closes its listeners asynchronously; give the ports a moment to free
    // up so an immediate restart on a new port pair does not race.
    await new Promise((r) => setTimeout(r, 350))
  }
}
