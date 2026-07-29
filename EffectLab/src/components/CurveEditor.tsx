import { useRef, useState } from 'react'
import type { CurvePoint } from '../types'

const W = 240
const H = 84
const PAD = 8

function toScreen(p: CurvePoint) {
  return {
    x: PAD + p.t * (W - PAD * 2),
    y: PAD + (1 - p.v) * (H - PAD * 2),
  }
}

/** 生命曲线编辑器：拖点改值，双击空白加点，右键删点。 */
export function CurveEditor({
  label,
  points,
  color,
  onChange,
}: {
  label: string
  points: CurvePoint[]
  color: string
  onChange: (pts: CurvePoint[]) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<number | null>(null)

  const sorted = [...points].sort((a, b) => a.t - b.t)

  const fromEvent = (e: React.PointerEvent | React.MouseEvent): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const y = ((e.clientY - rect.top) / rect.height) * H
    return {
      t: clamp01((x - PAD) / (W - PAD * 2)),
      v: clamp01(1 - (y - PAD) / (H - PAD * 2)),
    }
  }

  const path = sorted.map((p) => toScreen(p)).map((s, i) => `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(' ')
  const area = sorted.length
    ? `M${PAD},${H - PAD} ` +
      sorted.map((p) => { const s = toScreen(p); return `L${s.x.toFixed(1)},${s.y.toFixed(1)}` }).join(' ') +
      ` L${W - PAD},${H - PAD} Z`
    : ''

  return (
    <div className="curve">
      <div className="curve-head">
        <span>{label}</span>
        <span className="curve-hint">拖动改点 · 双击加点 · 右键删点</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="curve-svg"
        onDoubleClick={(e) => {
          const p = fromEvent(e)
          onChange([...sorted, p].sort((a, b) => a.t - b.t))
        }}
        onPointerMove={(e) => {
          if (drag === null) return
          const p = fromEvent(e)
          const next = [...sorted]
          next[drag] = p
          onChange(next)
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        <rect x="0" y="0" width={W} height={H} className="curve-bg" />
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={PAD} x2={W - PAD} y1={PAD + g * (H - PAD * 2)} y2={PAD + g * (H - PAD * 2)} className="curve-grid" />
        ))}
        {area && <path d={area} fill={color} opacity={0.14} />}
        <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
        {sorted.map((p, i) => {
          const s = toScreen(p)
          return (
            <circle
              key={i}
              cx={s.x}
              cy={s.y}
              r={4.5}
              className={`curve-pt ${drag === i ? 'active' : ''}`}
              stroke={color}
              onPointerDown={(e) => {
                e.stopPropagation()
                ;(e.target as Element).releasePointerCapture?.(e.pointerId)
                setDrag(i)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                if (sorted.length > 2) onChange(sorted.filter((_, k) => k !== i))
              }}
            />
          )
        })}
      </svg>
    </div>
  )
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
