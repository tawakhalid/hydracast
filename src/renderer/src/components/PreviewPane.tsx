import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import mpegts from 'mpegts.js'
import type { IngestState } from '@shared/types'
import { SignalIcon } from '../icons'

interface Props {
  ingest: IngestState
  broadcasting: boolean
  ingestUrl: string
  streamKey: string
  destinationCount: number
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

/**
 * Low-latency preview of the incoming Streamlabs feed, played straight from the
 * local ingest server's HTTP-FLV endpoint.
 */
export default function PreviewPane({
  ingest,
  broadcasting,
  ingestUrl,
  streamKey,
  destinationCount
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<mpegts.Player | null>(null)
  const [playerError, setPlayerError] = useState<string | null>(null)

  useEffect(() => {
    // Tear the player down whenever the encoder disconnects so a reconnect
    // starts from a clean buffer instead of replaying a stale one.
    if (!ingest.publishing || !ingest.previewUrl || !videoRef.current) {
      playerRef.current?.destroy()
      playerRef.current = null
      return
    }
    if (playerRef.current) return
    if (!mpegts.getFeatureList().mseLivePlayback) {
      setPlayerError('This build of Chromium cannot play FLV live streams')
      return
    }

    const player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: ingest.previewUrl },
      {
        enableWorker: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.6,
        liveBufferLatencyMinRemain: 0.4,
        lazyLoad: false,
        stashInitialSize: 128
      }
    )
    player.attachMediaElement(videoRef.current)
    player.on(mpegts.Events.ERROR, (_type: string, detail: string) => setPlayerError(detail))
    player.load()
    void Promise.resolve(player.play()).catch(() => {
      /* autoplay can be blocked until the element is muted, which it is */
    })
    playerRef.current = player
    setPlayerError(null)

    return () => {
      player.destroy()
      playerRef.current = null
    }
  }, [ingest.publishing, ingest.previewUrl])

  const resolution = ingest.width ? `${ingest.width}x${ingest.height}` : '--'

  return (
    <div className="preview">
      <video ref={videoRef} muted playsInline autoPlay />

      <AnimatePresence>
        {!ingest.publishing && (
          <motion.div
            className="preview-idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.02 }}
            transition={{ duration: 0.35 }}
          >
            <div className="scanline" />
            <div className="waiting-ring" />
            <h3>Waiting for Streamlabs</h3>
            <p>
              In Streamlabs choose <strong>Settings &rarr; Stream &rarr; Custom RTMP</strong> and
              point it here:
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <span className="pill mono">{ingestUrl}</span>
              <span className="pill mono">key: {streamKey}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="preview-overlay">
        <div className="preview-top">
          <AnimatePresence>
            {broadcasting && (
              <motion.div
                className="live-badge"
                initial={{ opacity: 0, y: -8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 420, damping: 26 }}
              >
                <span className="ring" />
                LIVE
              </motion.div>
            )}
          </AnimatePresence>

          {ingest.publishing && (
            <motion.span
              className="pill"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{ background: 'rgba(0,0,0,0.45)' }}
            >
              <span className="dot ok" />
              {fmtDuration(ingest.uptimeSec)}
            </motion.span>
          )}

          <div className="spacer" />

          {broadcasting && (
            <span className="pill" style={{ background: 'rgba(0,0,0,0.45)' }}>
              <SignalIcon />
              {destinationCount} destination{destinationCount === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="preview-bottom">
          {ingest.publishing && (
            <>
              <span className="pill mono" style={{ background: 'rgba(0,0,0,0.5)' }}>
                {resolution}
              </span>
              <span className="pill mono" style={{ background: 'rgba(0,0,0,0.5)' }}>
                {ingest.fps || '--'} fps
              </span>
              <span className="pill mono" style={{ background: 'rgba(0,0,0,0.5)' }}>
                {ingest.bitrateKbps.toLocaleString()} kbps
              </span>
              <span className="pill mono" style={{ background: 'rgba(0,0,0,0.5)' }}>
                {ingest.videoCodec || 'h264'} / {ingest.audioCodec || 'aac'}
              </span>
            </>
          )}
        </div>
      </div>

      {playerError && ingest.publishing && (
        <div
          style={{
            position: 'absolute',
            bottom: 52,
            left: 14,
            fontSize: 11.5,
            color: 'var(--warn)',
            fontFamily: 'var(--mono)'
          }}
        >
          preview: {playerError}
        </div>
      )}
    </div>
  )
}
