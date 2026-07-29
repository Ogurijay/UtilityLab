import { useRef, useState } from 'react'
import type { GradientStop } from '../types'
import { evalGradient, gradientToCss, rgbToHex } from '../core/material/ramp'

/** 生命颜色渐变编辑器：拖手柄改位置，双击色条加停靠点，右键删除。 */
export function GradientEditor({
  stops,
  onChange,
}: {
  stops: GradientStop[]
  onChange: (stops: GradientStop[]) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)

  const sorted = [...stops].sort((a, b) => a.t - b.t)
  const active = sorted[Math.min(selected, sorted.length - 1)]

  const tFromEvent = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = barRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  }

  return (
    <div className="gradient">
      <div className="curve-head">
        <span>颜色（随生命）</span>
        <span className="curve-hint">双击色条加点 · 右键删点</span>
      </div>
      <div
        ref={barRef}
        className="gradient-bar"
        style={{ background: gradientToCss(sorted) }}
        onDoubleClick={(e) => {
          const t = tFromEvent(e)
          const color = rgbToHex(evalGradient(sorted, t))
          const next = [...sorted, { t, color }].sort((a, b) => a.t - b.t)
          onChange(next)
          setSelected(next.findIndex((s) => s.t === t))
        }}
        onPointerMove={(e) => {
          if (drag === null) return
          const next = [...sorted]
          next[drag] = { ...next[drag], t: tFromEvent(e) }
          onChange(next)
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {sorted.map((s, i) => (
          <span
            key={i}
            className={`gradient-stop ${i === selected ? 'active' : ''}`}
            style={{ left: `${s.t * 100}%`, background: s.color }}
            onPointerDown={(e) => {
              e.stopPropagation()
              setSelected(i)
              setDrag(i)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              if (sorted.length > 2) {
                onChange(sorted.filter((_, k) => k !== i))
                setSelected(0)
              }
            }}
          />
        ))}
      </div>
      {active && (
        <div className="gradient-edit">
          <input
            type="color"
            value={active.color}
            onChange={(e) => {
              const next = [...sorted]
              next[Math.min(selected, next.length - 1)] = { ...active, color: e.target.value }
              onChange(next)
            }}
          />
          <span className="mono">{active.color}</span>
          <span className="mono dim">t = {active.t.toFixed(2)}</span>
        </div>
      )}
    </div>
  )
}
