import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 检查器分区卡片 */
export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <div className="sec-head">
        <span>{title}</span>
        {right}
      </div>
      <div className="sec-body">{children}</div>
    </div>
  )
}

/** 滑杆 + 数值（用于 0~1 类参数） */
export function SliderRow(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  digits?: number
  onChange: (v: number) => void
}) {
  const { label, value, min, max, step = 0.01, digits = 2, onChange } = props
  return (
    <div className="slider-row">
      <span className="lbl" title={label}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <input
        className="num"
        type="number"
        step={step}
        value={Number.isFinite(value) ? parseFloat(value.toFixed(digits)) : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </div>
  )
}

/**
 * 可拖拽刻度的数值框：按住标签左右拖即可调值（编辑器常用交互），
 * 也可以直接键入数字。
 */
export function DragNumber(props: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  digits?: number
  className?: string
}) {
  const { label, value, onChange, step = 0.01, min = -Infinity, max = Infinity, digits = 2 } = props
  const start = useRef({ x: 0, v: 0 })

  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, v: value }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.current.x
      const factor = ev.shiftKey ? 10 : 1
      onChange(clamp(start.current.v + dx * step * factor))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className={`dragnum ${props.className ?? ''}`}>
      <span className="dn-label" title="按住左右拖动调整" onPointerDown={onPointerDown}>
        {label}
      </span>
      <input
        className="dn-input"
        type="number"
        step={step}
        value={Number.isFinite(value) ? parseFloat(value.toFixed(digits)) : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(clamp(v))
        }}
      />
    </div>
  )
}

/** XYZ 三轴数值行 */
export function Vec3Row(props: {
  label: string
  x: number
  y: number
  z: number
  step?: number
  digits?: number
  onChange: (axis: 'x' | 'y' | 'z', v: number) => void
}) {
  const { label, x, y, z, step = 0.01, digits = 2, onChange } = props
  return (
    <div className="vec3">
      <span className="vec3-label">{label}</span>
      <DragNumber className="axis-x" label="X" value={x} step={step} digits={digits} onChange={(v) => onChange('x', v)} />
      <DragNumber className="axis-y" label="Y" value={y} step={step} digits={digits} onChange={(v) => onChange('y', v)} />
      <DragNumber className="axis-z" label="Z" value={z} step={step} digits={digits} onChange={(v) => onChange('z', v)} />
    </div>
  )
}

/** 通用弹窗 */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={props.width ? { width: props.width } : undefined}>
        <div className="m-head">
          <span>{props.title}</span>
          <button className="btn ghost small" onClick={props.onClose}>✕</button>
        </div>
        <div className="m-body">{props.children}</div>
        {props.footer && <div className="m-foot">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  danger?: boolean
  onClick?: () => void
  /** 点击后切换到子菜单（items） */
  children?: MenuItem[]
  title?: boolean
}

/** 固定定位的弹出菜单，支持一层子菜单（切换视图式） */
export function PopMenu(props: { anchor: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const [stack, setStack] = useState<MenuItem[][]>([props.items])
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(props.anchor)

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [props])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let { x, y } = props.anchor
    if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8
    if (y + r.height > window.innerHeight - 8) y = window.innerHeight - r.height - 8
    setPos({ x, y })
  }, [props.anchor, stack])

  const items = stack[stack.length - 1]

  return createPortal(
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {stack.length > 1 && <button onClick={() => setStack(stack.slice(0, -1))}>← 返回</button>}
      {items.map((it, i) =>
        it.title ? (
          <div key={i} className="menu-title">{it.label}</div>
        ) : (
          <button
            key={i}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              if (it.children) {
                setStack([...stack, it.children])
              } else {
                it.onClick?.()
                props.onClose()
              }
            }}
          >
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.children && <span style={{ color: 'var(--faint)' }}>▸</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
