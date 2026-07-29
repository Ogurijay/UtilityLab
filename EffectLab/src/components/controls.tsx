import { useState, type ReactNode } from 'react'
import type { Vec3 } from '../types'

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`section ${open ? 'open' : ''}`}>
      <button className="section-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  hint?: string
}) {
  const [text, setText] = useState<string | null>(null)
  const commit = (raw: string) => {
    const n = Number(raw)
    if (Number.isFinite(n)) onChange(n)
    setText(null)
  }
  return (
    <label className="ctrl" title={hint}>
      <span className="ctrl-label">{label}</span>
      <input
        className="ctrl-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className="ctrl-num"
        type="text"
        value={text ?? formatNum(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function formatNum(v: number) {
  if (!Number.isFinite(v)) return '0'
  if (Math.abs(v) >= 100) return v.toFixed(0)
  if (Math.abs(v) >= 10) return v.toFixed(1)
  return v.toFixed(3).replace(/\.?0+$/, '') || '0'
}

export function Vec3Field({
  label,
  value,
  step = 0.05,
  onChange,
}: {
  label: string
  value: Vec3
  step?: number
  onChange: (v: Vec3) => void
}) {
  return (
    <div className="ctrl vec3">
      <span className="ctrl-label">{label}</span>
      <div className="vec3-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <input
            key={axis}
            type="number"
            step={step}
            value={value[i]}
            onChange={(e) => {
              const next = [...value] as Vec3
              next[i] = Number(e.target.value)
              onChange(next)
            }}
          />
        ))}
      </div>
    </div>
  )
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <label className="ctrl">
      <span className="ctrl-label">{label}</span>
      <select className="ctrl-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="ctrl toggle">
      <span className="ctrl-label">{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function IntField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  hint?: string
}) {
  return (
    <label className="ctrl" title={hint}>
      <span className="ctrl-label">{label}</span>
      <input
        className="ctrl-num wide"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value))
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
      />
    </label>
  )
}
