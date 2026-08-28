/**
 * End-to-end check of the Hydracast backend without Electron:
 *  1. Boot the real IngestServer.
 *  2. Publish a synthetic 6000k feed into it (stands in for Streamlabs).
 *  3. Stand up an independent ffmpeg RTMP listener as "a platform".
 *  4. Relay to it in passthrough mode, then re-encode at 1500k, and confirm
 *     the bitrate the platform actually receives changes accordingly.
 *
 * The fake platform must be its own process: node-media-server v2 keeps a
 * single global session context, so two instances in one process cross-wire.
 */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import net from 'net'
import { measureLatency, parseEndpoint } from '../src/main/latency'
import { IngestServer } from '../src/main/ingest'
import { RelayManager, buildArgs } from '../src/main/relay'
import type { AppSettings, Platform } from '../src/shared/types'
import { DEFAULT_SETTINGS, DEFAULT_VIDEO } from '../src/shared/types'

const RTMP = 11935
const HTTP = 18787
const FAKE = 11936

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  rtmpPort: RTMP,
  httpPort: HTTP,
  ingestKey: 'streamlabs',
  autoReconnect: false
}

const platform: Platform = {
  id: 'p1',
  kind: 'custom',
  name: 'FakePlatform',
  url: `rtmp://127.0.0.1:${FAKE}/app`,
  streamKey: 'testkey',
  enabled: true,
  video: { ...DEFAULT_VIDEO },
  chat: { enabled: false }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

/** A standalone RTMP server standing in for a platform, in its own process. */
function startFakePlatform(port: number): {
  proc: ChildProcessWithoutNullStreams
  rate: () => number
  size: () => string
} {
  const proc = spawn('node', ['test/fake-platform.cjs', String(port)], { windowsHide: true })
  let kbps = 0
  let dims = ''
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split(String.fromCharCode(10))) {
      const m = line.match(/^bitrate (\d+) (\S+)$/)
      if (m) {
        kbps = Number(m[1])
        dims = m[2]
      } else if (line.trim()) {
        console.log(`      [platform:${port}] ${line.trim()}`)
      }
    }
  })
  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', (d: string) => {
    const t = d.trim()
    if (t) console.log(`      [platform:${port}] ${t}`)
  })
  return { proc, rate: () => kbps, size: () => dims }
}

async function main() {
  // ---- 1. argument builder ----
  const copyArgs = buildArgs(platform, 'rtmp://src/live/k', 30).join(' ')
  check('passthrough uses -c:v copy', copyArgs.includes('-c:v copy'))

  const reArgs = buildArgs(
    { ...platform, video: { ...platform.video, mode: 'reencode', videoBitrate: 1500, encoder: 'x264' } },
    'rtmp://src/live/k',
    30
  ).join(' ')
  check(
    're-encode carries the per-platform bitrate',
    reArgs.includes('-b:v 1500k') && reArgs.includes('-maxrate 1500k') && reArgs.includes('libx264')
  )
  check('keyframe interval derived from source fps', reArgs.includes('-g 60'))

  const scaled = buildArgs(
    { ...platform, video: { ...platform.video, mode: 'reencode', scale: '1280x720', fps: 30 } },
    'rtmp://src/live/k',
    60
  ).join(' ')
  check('scale and fps become a filter chain', scaled.includes('-vf scale=1280:720,fps=30'))

  // ---- 2. our ingest ----
  const ingest = new IngestServer(settings)
  ingest.on('log', (_l: string, m: string) => console.log(`      [ingest] ${m}`))
  await ingest.start(settings)
  await sleep(500)
  check('ingest server listening', ingest.getState().listening)

  // ---- 3. synthetic Streamlabs feed ----
  const source = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-re',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-b:v', '6000k', '-minrate', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-g', '60', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'flv', `rtmp://127.0.0.1:${RTMP}/live/streamlabs`
    ],
    { windowsHide: true }
  )
  source.stderr.on('data', (d) => console.log(`      [source] ${d.toString().trim()}`))

  await sleep(7000)
  ingest.poll()
  const st = ingest.getState()
  check('encoder publish detected', st.publishing)
  check('resolution read from stream', st.width === 1280 && st.height === 720, `${st.width}x${st.height}`)
  check('incoming bitrate measured', st.bitrateKbps > 3000, `${st.bitrateKbps} kbps`)
  check('codecs read from stream', !!st.videoCodec && !!st.audioCodec, `${st.videoCodec}/${st.audioCodec}`)

  // ---- 4. passthrough relay ----
  const relays = new RelayManager(settings)
  relays.on('log', (_l: string, m: string) => console.log(`      [relay] ${m}`))
  relays.setSource(ingest.localSourceUrl, st.fps)
  relays.syncPlatforms([platform])

  let fake = startFakePlatform(11936)
  await sleep(1800)
  await relays.start(platform.id)
  await sleep(12000)

  let stats = relays.getStats()[platform.id]
  check('passthrough relay reached live', stats.status === 'live', `${stats.status} ${stats.error ?? ''}`)
  const copyRate = fake.rate()
  check('platform received full-rate passthrough', copyRate > 3000, `${copyRate} kbps`)
  const probe = net.createServer().listen(11937, '127.0.0.1')
  await sleep(200)
  const ep = parseEndpoint('rtmp://127.0.0.1:11937/app')
  const rtt = ep ? await measureLatency(ep) : -1
  check('latency probe measures a real endpoint', !!ep && rtt >= 0, `${rtt} ms`)
  const dead = await measureLatency({ host: '127.0.0.1', port: 11999, secure: false }, 1500)
  check('latency probe reports -1 for an unreachable edge', dead === -1)
  probe.close()
  check('health score computed', stats.health > 0, `${stats.health}/100`)

  await relays.stop(platform.id)
  fake.proc.kill('SIGKILL')
  await sleep(2000)

  // ---- 5. re-encode relay at 1500k ----
  const throttled: Platform = {
    ...platform,
    url: `rtmp://127.0.0.1:11938/app`,
    video: { ...platform.video, mode: 'reencode', videoBitrate: 1500, encoder: 'x264', audioBitrate: 128 }
  }
  relays.syncPlatforms([throttled])
  fake = startFakePlatform(11938)
  await sleep(1800)
  await relays.start(throttled.id)
  await sleep(16000)

  stats = relays.getStats()[throttled.id]
  check('re-encode relay reached live', stats.status === 'live', `${stats.status} ${stats.error ?? ''}`)
  const encRate = fake.rate()
  check('platform received throttled ~1500k feed', encRate > 700 && encRate < 3200, `${encRate} kbps`)
  check(
    'per-platform bitrate actually differs from source',
    encRate > 0 && copyRate / encRate > 1.8,
    `${copyRate} kbps passthrough vs ${encRate} kbps re-encoded`
  )
  check('ffmpeg progress parsed', stats.bitrateKbps > 0, `${stats.bitrateKbps} kbps, speed ${stats.speed}x`)

  // ---- 6. teardown ----
  await relays.stop(throttled.id)
  check('relay returns to idle after stop', relays.getStats()[throttled.id].status === 'idle')
  relays.dispose()
  fake.proc.kill('SIGKILL')
  source.kill('SIGKILL')
  await ingest.stop()

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('harness crashed:', e)
  process.exit(1)
})
