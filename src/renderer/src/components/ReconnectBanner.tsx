import { motion } from 'framer-motion'
import type { AuthStatus, Platform } from '@shared/types'
import { AlertIcon, CloseIcon, PlatformIcon } from '../icons'

interface Props {
  /** Destinations whose stored login stopped working. */
  stale: Platform[]
  auth: Record<string, AuthStatus>
  busy: string | null
  onReconnect: (platformId: string) => void
  onDismiss: () => void
}

/**
 * Tells the user a login lapsed while the app was closed.
 *
 * Only a session that used to work raises this - `needsReconnect` is set when a
 * refresh fails, never when a connect attempt is abandoned. Twitch logins do
 * not lapse on a timer (a Confidential client's refresh token has no deadline;
 * only a password change or a revoked authorisation ends it), but Kick returns
 * a `refresh_expires_in`, so its logins do.
 *
 * Without this the failure is silent until something needs the token - which in
 * practice means discovering it while going live, since that is when the stream
 * key and viewer count are first read.
 */
export default function ReconnectBanner({ stale, auth, busy, onReconnect, onDismiss }: Props) {
  if (!stale.length) return null

  return (
    <motion.div
      className="reconnect-banner"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
    >
      <span className="reconnect-icon">
        <AlertIcon size={15} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="reconnect-title">
          {stale.length === 1
            ? `Your ${stale[0].name} login has expired`
            : `${stale.length} logins have expired`}
        </div>
        <div className="reconnect-sub">
          Reconnect to restore the stream key, viewer count and chat sending.
        </div>
      </div>

      {stale.map((platform) => (
        <button
          key={platform.id}
          className="btn sm primary"
          onClick={() => onReconnect(platform.id)}
          disabled={busy === platform.id || auth[platform.id]?.state === 'pending'}
        >
          <PlatformIcon kind={platform.kind} size={13} />
          {auth[platform.id]?.state === 'pending' ? 'Waiting…' : `Reconnect ${platform.name}`}
        </button>
      ))}

      <button className="icon-btn" onClick={onDismiss} title="Dismiss">
        <CloseIcon size={14} />
      </button>
    </motion.div>
  )
}
