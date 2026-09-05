import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import type { AuthStatus, Platform } from '@shared/types'
import { AlertIcon, CheckIcon, CopyIcon, LinkIcon, PlatformIcon, PLATFORM_COLORS } from '../icons'

interface Props {
  platform: Platform
  status?: AuthStatus
  onCancel: () => void
  onCopied: (text: string) => void
}

/** mm:ss left before the code stops working. */
function countdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000))
  return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
}

/**
 * The approval step of a login.
 *
 * Both platforms hand the account picker to the user's own browser rather than
 * embedding it, which is the point: Hydracast never sees the password, and the
 * user approves it somewhere they can check the address bar.
 *
 * The two differ in how they get there. Twitch prints a code to type at
 * twitch.tv/activate; Kick opens a consent page directly and redirects back to
 * a loopback listener, so there is no code to show and nothing to copy - which
 * is why the code block below is conditional rather than always rendered.
 */
export default function ConnectModal({ platform, status, onCancel, onCopied }: Props) {
  const [now, setNow] = useState(Date.now())
  const verification = status?.verification
  const color = PLATFORM_COLORS[platform.kind]

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const expired = !!verification && now > verification.expiresAt
  const failed = status?.state === 'error'
  // Kick sends the user straight to a consent page, so there is no code.
  const hasCode = !!verification?.userCode

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <motion.div
        className="modal connect-modal"
        style={{ ['--pc' as string]: color }}
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      >
        <div className="connect-head">
          <div className="pcard-icon" style={{ width: 42, height: 42 }}>
            <PlatformIcon kind={platform.kind} size={22} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>Connect {platform.name}</h2>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
              {hasCode ? 'Approve this code in your browser' : 'Approve the login in your browser'}
            </div>
          </div>
        </div>

        {failed ? (
          <div className="connect-error">
            <AlertIcon size={16} />
            <span>{status?.detail ?? 'The login did not complete'}</span>
          </div>
        ) : !verification ? (
          <div className="connect-wait">
            <div className="waiting-ring" />
            <div>Asking {platform.name} to start the login&hellip;</div>
          </div>
        ) : (
          <>
            {hasCode && (
              <div className="connect-code" onClick={() => onCopied(verification.userCode)}>
                {verification.userCode}
                <span className="connect-copy" title="Copy code">
                  <CopyIcon size={14} />
                </span>
              </div>
            )}

            <ol className="connect-steps">
              <li>
                {hasCode ? 'Open' : 'Approve it on'}{' '}
                <button
                  className="linkish"
                  onClick={() => void window.hydracast.openExternal(verification.url)}
                >
                  {hasCode
                    ? verification.url.replace(/^https?:\/\//, '')
                    : 'the page that just opened'}
                  <LinkIcon size={12} />
                </button>
              </li>
              <li>
                {hasCode
                  ? 'Enter the code above and approve the permissions'
                  : 'Choose your account and approve the permissions'}
              </li>
              <li>This window closes itself once you do</li>
            </ol>

            <div className="connect-foot">
              <span className={`dot ${expired ? 'err' : 'warn'}`} />
              {expired ? (
                <span>The code expired &mdash; close this and try again</span>
              ) : (
                <span>
                  Waiting for approval &middot; times out in{' '}
                  <strong style={{ fontFamily: 'var(--mono)' }}>
                    {countdown(verification.expiresAt, now)}
                  </strong>
                </span>
              )}
            </div>
          </>
        )}

        <div className="connect-actions">
          <div className="hint" style={{ flex: 1, margin: 0 }}>
            Hydracast never sees your password. It asks only to read your stream key, set your title
            and category, and send chat as you.
          </div>
          <button className="btn" onClick={onCancel}>
            {failed || expired ? 'Close' : 'Cancel'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** Compact connected-account row used inside Settings. */
export function AccountRow({
  status,
  onDisconnect,
  onRefreshKey,
  busy
}: {
  status: AuthStatus
  onDisconnect: () => void
  onRefreshKey: () => void
  busy: boolean
}) {
  const account = status.account
  if (!account) return null
  return (
    <div className="account-row">
      {account.avatarUrl ? (
        <img className="account-avatar" src={account.avatarUrl} alt="" />
      ) : (
        <div className="account-avatar placeholder" />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="account-name">
          {account.displayName}
          <span className="account-ok" title="Connected">
            <CheckIcon size={11} />
          </span>
        </div>
        <div className="account-login">@{account.login}</div>
      </div>
      <button className="btn sm ghost" onClick={onRefreshKey} disabled={busy}>
        {busy ? 'Working…' : 'Refresh stream key'}
      </button>
      <button className="btn sm danger" onClick={onDisconnect} disabled={busy}>
        Disconnect
      </button>
    </div>
  )
}
