import dns from 'dns'
import net from 'net'
import tls from 'tls'
import type { CheckResult, Platform } from '@shared/types'
import { PLATFORM_PRESETS } from '@shared/types'
import { parseEndpoint } from './latency'

const ok = (label: string, detail: string): CheckResult => ({ label, level: 'ok', detail })
const warn = (label: string, detail: string): CheckResult => ({ label, level: 'warn', detail })
const bad = (label: string, detail: string): CheckResult => ({ label, level: 'error', detail })

/**
 * The URL a relay should actually publish to.
 *
 * Kick's dashboard does not always show the whole ingest URL, and Amazon IVS
 * only accepts the `app` application, so a pasted bare host silently fails the
 * RTMP handshake. Rather than making the user retype something different from
 * what their dashboard gave them, the missing pieces are filled in here - at
 * the point of use, so the value they entered is never rewritten on disk.
 *
 * A URL that already carries a path is left exactly as typed: that is a
 * deliberate choice by the user, and guessing over it is how a working setup
 * gets broken.
 */
export function normalizeIngestUrl(platform: Platform): string {
  const url = platform.url.trim()
  const preset = PLATFORM_PRESETS.find((p) => p.kind === platform.kind)
  if (!preset?.urlHostSuffix || !preset.urlPath) return url

  const endpoint = parseEndpoint(url)
  if (!endpoint || !endpoint.host.endsWith(preset.urlHostSuffix)) return url

  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '')
  if (path) return url

  const scheme = endpoint.secure ? 'rtmps' : 'rtmp'
  return `${scheme}://${endpoint.host}:${endpoint.port}${preset.urlPath}`
}

/** True when any check came back as a hard error. */
export function hasErrors(checks: CheckResult[]): boolean {
  return checks.some((c) => c.level === 'error')
}

/** Joins the failing checks into one line suitable for a status badge. */
export function summarise(checks: CheckResult[]): string {
  const problems = checks.filter((c) => c.level !== 'ok')
  if (!problems.length) return ''
  return problems.map((c) => c.detail).join(' | ')
}

/**
 * Config-level checks. These are instant and run before every relay start, so a
 * misconfigured destination fails with a specific reason instead of an ffmpeg
 * handshake error nobody reads.
 */
export function validateDestination(platform: Platform): CheckResult[] {
  const checks: CheckResult[] = []
  const preset = PLATFORM_PRESETS.find((p) => p.kind === platform.kind)
  const url = platform.url.trim()
  const key = platform.streamKey.trim()

  if (!url) {
    checks.push(
      bad(
        'Ingest URL',
        preset?.perChannelIngest
          ? `No ingest URL. ${preset.name} gives every channel its own - copy yours from the dashboard.`
          : 'No ingest URL configured.'
      )
    )
    return checks
  }

  const endpoint = parseEndpoint(url)
  if (!endpoint) {
    checks.push(bad('Ingest URL', `"${url}" is not a valid URL.`))
    return checks
  }

  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  if (scheme !== 'rtmp' && scheme !== 'rtmps') {
    checks.push(bad('Ingest URL', `Scheme "${scheme}" is not rtmp or rtmps.`))
  } else {
    checks.push(ok('Ingest URL', `${scheme}://${endpoint.host}:${endpoint.port}`))
  }

  // Only the shape of the host is checked, never its value. Which channel an
  // ingest host belongs to is not knowable from here, and guessing wrong would
  // reject a URL that is perfectly correct.
  if (preset?.urlHostSuffix && !endpoint.host.endsWith(preset.urlHostSuffix)) {
    checks.push(
      bad(
        'Ingest host',
        `${preset.name} ingest hosts end with ${preset.urlHostSuffix}; got "${endpoint.host}".`
      )
    )
  }

  if (preset?.urlHostSuffix && preset.urlPath && endpoint.host.endsWith(preset.urlHostSuffix)) {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '')
    if (!path) {
      // Completed rather than rejected - the dashboard often shows only the host.
      checks.push(ok('Ingest URL', `Publishing to ${normalizeIngestUrl(platform)}`))
    } else if (path !== preset.urlPath) {
      checks.push(
        warn(
          'Ingest URL',
          `${preset.name} normally ingests on the ${preset.urlPath} path; "${path}" may be refused. Left as you entered it.`
        )
      )
    }
  }

  if (!key) {
    checks.push(bad('Stream key', 'No stream key configured.'))
    return checks
  }

  if (key.includes('://')) {
    checks.push(bad('Stream key', 'The key field contains a URL - the URL and key go in separate fields.'))
  } else if (/\s/.test(key)) {
    checks.push(warn('Stream key', 'The key contains whitespace, which is usually a copy/paste artefact.'))
  } else if (url.endsWith(`/${key}`)) {
    checks.push(bad('Stream key', 'The key is already appended to the URL, so it would be sent twice.'))
  } else {
    checks.push(ok('Stream key', `${key.length} characters`))
  }

  // Shape hints. These are warnings, never hard errors - platforms change key
  // formats and a wrong guess here must not block a working setup.
  if (platform.kind === 'kick' && key && !key.startsWith('sk_')) {
    checks.push(warn('Stream key', 'Kick keys normally start with "sk_" - check you copied the whole value.'))
  }
  if (platform.kind === 'twitch' && key && !key.startsWith('live_')) {
    checks.push(warn('Stream key', 'Twitch keys normally start with "live_".'))
  }

  checks.push(...ivsChecks(platform))
  return checks
}

/**
 * Kick runs on Amazon IVS, which is far stricter than Twitch about what it will
 * accept and simply terminates a session that breaks the rules - which surfaces
 * as an endless reconnect loop rather than a rejection. These checks name the
 * usual causes up front.
 */
function ivsChecks(platform: Platform): CheckResult[] {
  if (platform.kind !== 'kick') return []
  const v = platform.video
  const checks: CheckResult[] = []

  if (v.mode === 'copy') {
    checks.push(
      warn(
        'IVS limits',
        'Passthrough forwards the Streamlabs GOP untouched. IVS drops any stream whose keyframe interval is over 2 s - set Streamlabs to 2 s, or switch this destination to re-encode.'
      )
    )
  } else {
    if (v.keyframeInterval > 2) {
      checks.push(
        bad(
          'IVS limits',
          `Keyframe interval is ${v.keyframeInterval} s. IVS terminates streams above 2 s.`
        )
      )
    }
    if (v.videoBitrate > 8500) {
      checks.push(
        warn(
          'IVS limits',
          `${v.videoBitrate} kbps is above the 8500 kbps IVS standard-channel ceiling; the session will be cut.`
        )
      )
    }
  }

  return checks
}

function resolveHost(host: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(warn('DNS', `Lookup of ${host} timed out.`)), timeoutMs)
    dns.lookup(host, (err, address) => {
      clearTimeout(timer)
      if (err) {
        resolve(
          bad(
            'DNS',
            err.code === 'ENOTFOUND'
              ? `${host} does not exist. Check the ingest URL against your dashboard.`
              : `Lookup of ${host} failed (${err.code ?? err.message}).`
          )
        )
        return
      }
      resolve(ok('DNS', `${host} resolves to ${address}`))
    })
  })
}

function tcpCheck(host: string, port: number, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    const done = (result: CheckResult): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(ok('TCP', `Connected to ${host}:${port} in ${Date.now() - started} ms`)))
    socket.once('timeout', () => done(bad('TCP', `${host}:${port} did not answer within ${timeoutMs} ms.`)))
    socket.once('error', (err) =>
      done(bad('TCP', `${host}:${port} refused the connection (${(err as NodeJS.ErrnoException).code ?? err.message}).`))
    )
    socket.connect(port, host)
  })
}

function tlsCheck(host: string, port: number, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: CheckResult): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      done(
        socket.authorized
          ? ok('TLS', `Handshake with ${host} succeeded`)
          : warn('TLS', `Certificate not trusted (${socket.authorizationError}).`)
      )
    })
    socket.once('timeout', () => done(bad('TLS', `Handshake with ${host} timed out.`)))
    socket.once('error', (err) => done(bad('TLS', `Handshake with ${host} failed (${err.message}).`)))
  })
}

/**
 * Network-level checks against the destination edge. Kept out of the hot start
 * path - the relay runs these only when a start fails, and the settings screen
 * runs them on demand.
 */
export async function probeDestination(platform: Platform, timeoutMs = 4000): Promise<CheckResult[]> {
  const endpoint = parseEndpoint(platform.url)
  if (!endpoint) return []

  const dnsResult = await resolveHost(endpoint.host, timeoutMs)
  if (dnsResult.level === 'error') return [dnsResult]

  const tcpResult = await tcpCheck(endpoint.host, endpoint.port, timeoutMs)
  if (tcpResult.level === 'error' || !endpoint.secure) return [dnsResult, tcpResult]

  return [dnsResult, tcpResult, await tlsCheck(endpoint.host, endpoint.port, timeoutMs)]
}

/** Full report: configuration first, then the network path. */
export async function checkDestination(platform: Platform): Promise<CheckResult[]> {
  const config = validateDestination(platform)
  if (hasErrors(config)) return config
  return [...config, ...(await probeDestination(platform))]
}
