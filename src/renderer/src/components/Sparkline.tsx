import { useId } from 'react'

interface Props {
  data: number[]
  color: string
  height?: number
  /** Draw a soft gradient under the line. */
  filled?: boolean
}

/**
 * Tiny inline chart used for per-platform latency and bitrate history.
 * Renders nothing but an SVG path so it stays cheap at 1 Hz updates.
 */
export default function Sparkline({ data, color, height = 30, filled = true }: Props) {
  const gradientId = useId()
  const width = 100

  if (data.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={color}
          strokeOpacity="0.25"
          strokeWidth="1.2"
          strokeDasharray="3 3"
        />
      </svg>
    )
  }

  const max = Math.max(...data)
  const min = Math.min(...data)
  const span = max - min || 1
  const pad = 3

  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - pad - ((value - min) / span) * (height - pad * 2)
    return [x, y] as const
  })

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  const last = points[points.length - 1]

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {filled && <path d={area} fill={`url(#${gradientId})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r="1.8" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
