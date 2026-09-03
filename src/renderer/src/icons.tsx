import type { PlatformKind } from '@shared/types'

interface IconProps {
  size?: number
  className?: string
}

/* ---------------- Platform marks (simplified official glyphs) ---------------- */

export function TwitchIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.3 2 3 5.4v13.2h4.5V21h2.5l2.4-2.4h3.7L21 14V2H4.3zm15 11.2-2.6 2.6h-4.1l-2.3 2.3v-2.3H6.9V3.5h12.4v9.7z" />
      <path d="M15.6 6.6h1.6v4.8h-1.6zM11.2 6.6h1.6v4.8h-1.6z" />
    </svg>
  )
}

export function YouTubeIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M23 12s0-3.6-.46-5.33a2.78 2.78 0 0 0-1.94-1.96C18.88 4.25 12 4.25 12 4.25s-6.88 0-8.6.46A2.78 2.78 0 0 0 1.46 6.67 29.3 29.3 0 0 0 1 12a29.3 29.3 0 0 0 .46 5.33 2.78 2.78 0 0 0 1.94 1.96c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-1.96C23 15.6 23 12 23 12zM9.75 15.27V8.73L15.5 12l-5.75 3.27z" />
    </svg>
  )
}

export function KickIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 3h5v5.5h2.5V6h2.5V3.5h5v5h-2.5V11h-2.5v2h2.5v2.5H21v5h-5V18h-2.5v-2.5H11V21H3V3z" />
    </svg>
  )
}

export function FacebookIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0 0 22 12z" />
    </svg>
  )
}

export function TrovoIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.6 6.4 3.2-6.4 3.2-6.4-3.2L12 4.6zM5.5 9.6l5.4 2.7v6.2l-5.4-2.7V9.6zm7.6 8.9v-6.2l5.4-2.7v6.2l-5.4 2.7z" />
    </svg>
  )
}

export function TikTokIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.1v12.4a2.59 2.59 0 0 1-2.6 2.5 2.6 2.6 0 1 1 .74-5.09v-3.1a5.7 5.7 0 1 0 4.96 5.64V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.29 4.29 0 0 1-3.24-1.48z" />
    </svg>
  )
}

export function CustomIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  )
}

export function PlatformIcon({ kind, size = 20 }: { kind: PlatformKind; size?: number }) {
  switch (kind) {
    case 'twitch':
      return <TwitchIcon size={size} />
    case 'youtube':
      return <YouTubeIcon size={size} />
    case 'kick':
      return <KickIcon size={size} />
    case 'facebook':
      return <FacebookIcon size={size} />
    case 'trovo':
      return <TrovoIcon size={size} />
    case 'tiktok':
      return <TikTokIcon size={size} />
    default:
      return <CustomIcon size={size} />
  }
}

export const PLATFORM_COLORS: Record<PlatformKind, string> = {
  twitch: '#9146ff',
  youtube: '#ff0033',
  kick: '#53fc18',
  facebook: '#0866ff',
  trovo: '#21b459',
  tiktok: '#25f4ee',
  custom: '#8b93ad'
}

/* ---------------- UI icons ---------------- */

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
}

export const BroadcastIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="2.5" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" />
  </svg>
)

export const ChatIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.3-.6L3 21l1.7-5A8.2 8.2 0 0 1 3.9 11a8.4 8.4 0 0 1 8.5-8.4 8.4 8.4 0 0 1 8.6 8.4z" />
  </svg>
)

export const LogsIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 5h16M4 10h10M4 15h16M4 20h7" />
  </svg>
)

export const PenIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

export const BellIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)

export const SettingsIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
)

export const PlayIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />
  </svg>
)

export const StopIcon = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="3" />
  </svg>
)

export const CopyIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

export const EyeIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const EyeOffIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c7 0 10.5 6.5 10.5 6.5a17 17 0 0 1-3.4 4.3M6.6 6.6A17 17 0 0 0 1.5 12S5 18.5 12 18.5a9.7 9.7 0 0 0 4.1-.9M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
)

export const PlusIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const TrashIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
)

export const CloseIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const MinimizeIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M5 12h14" />
  </svg>
)

export const MaximizeIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
)

export const RestoreIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="7" y="7" width="13" height="13" rx="2" />
    <path d="M4 16V5a1 1 0 0 1 1-1h11" />
  </svg>
)

export const ChevronIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const RefreshIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
  </svg>
)

export const SignalIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20v-4M9.5 20V12M15 20V8M20.5 20V4" />
  </svg>
)

export const LinkIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
)

export const CheckIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.6}>
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
)

export const AlertIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
)
