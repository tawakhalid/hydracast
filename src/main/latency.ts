import net from 'net'
import { URL } from 'url'

export interface Endpoint {
  host: string
  port: number
  secure: boolean
}

/** Parses an rtmp:// or rtmps:// ingest URL into a connectable endpoint. */
export function parseEndpoint(rtmpUrl: string): Endpoint | null {
  try {
    const trimmed = rtmpUrl.trim()
    if (!trimmed) return null
    const u = new URL(trimmed)
    const secure = u.protocol === 'rtmps:'
    const port = u.port ? Number(u.port) : secure ? 443 : 1935
    if (!u.hostname) return null
    return { host: u.hostname, port, secure }
  } catch {
    return null
  }
}

/**
 * Measures the TCP handshake time to a destination's ingest edge. This is the
 * round trip that actually matters for RTMP delivery, and it is what the cards
 * display as "latency".
 */
export function measureLatency(endpoint: Endpoint, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const socket = new net.Socket()
    let settled = false

    const done = (value: number): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6
      done(Math.round(elapsed))
    })
    socket.once('timeout', () => done(-1))
    socket.once('error', () => done(-1))

    try {
      socket.connect(endpoint.port, endpoint.host)
    } catch {
      done(-1)
    }
  })
}
