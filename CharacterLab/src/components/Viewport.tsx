import { useEffect, useRef } from 'react'
import { useEditor } from '../store/editor'
import {
  frameCharacter, initEngine, isGizmoDragging, pickAtCanvas, resetPose, setGizmoMode,
  setUniformScale, toggleGrid, toggleSkeleton,
} from '../app/controller'
import { Icon } from './Icons'
import type { GizmoMode } from '../types'

const GIZMO_MODES: { id: GizmoMode; icon: string; label: string; key: string }[] = [
  { id: 'translate', icon: 'move', label: '移动', key: 'W' },
  { id: 'rotate', icon: 'rotate', label: '旋转', key: 'E' },
  { id: 'scale', icon: 'resize', label: '缩放', key: 'R' },
]

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const downPos = useRef<{ x: number; y: number } | null>(null)
  const hasCharacter = useEditor((s) => s.hasCharacter)
  const parts = useEditor((s) => s.parts)
  const selection = useEditor((s) => s.selection)
  const showGrid = useEditor((s) => s.showGrid)
  const showSkeleton = useEditor((s) => s.showSkeleton)
  const gizmoMode = useEditor((s) => s.gizmoMode)
  const uniformScale = useEditor((s) => s.uniformScale)

  useEffect(() => {
    if (canvasRef.current) initEngine(canvasRef.current)
  }, [])

  return (
    <main className="vp">
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          // TransformControls 的原生监听先于 React 委托执行：
          // 按在操纵器手柄上时 dragging 已为 true，此时不记录起点，松开时自然跳过拾取
          if (e.button !== 0 || isGizmoDragging()) return
          downPos.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerUp={(e) => {
          const down = downPos.current
          downPos.current = null
          if (!down || e.button !== 0 || isGizmoDragging()) return
          const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y)
          if (dist < 5) pickAtCanvas(e.clientX, e.clientY)
        }}
      />

      <div className="vp-toolbar">
        <div className="seg" title="操纵器模式（W / E / R）">
          {GIZMO_MODES.map((m) => (
            <button
              key={m.id}
              className={gizmoMode === m.id ? 'on' : ''}
              title={`${m.label}（${m.key}）`}
              onClick={() => setGizmoMode(m.id)}
            >
              <Icon name={m.icon} size={14} />
            </button>
          ))}
        </div>
        <button
          className={`icon-btn ${uniformScale ? 'active' : ''}`}
          title={uniformScale ? '等比缩放锁：开（拖任意轴都整体缩放，防止拉伸变形）' : '等比缩放锁：关（可按单轴拉伸）'}
          onClick={() => setUniformScale(!uniformScale)}
        >
          <Icon name={uniformScale ? 'lock' : 'unlock'} size={14} />
        </button>
        <div className="top-divider" />
        <button className="icon-btn" title="视角对准选中对象 / 角色" onClick={frameCharacter}>
          <Icon name="frame" />
        </button>
        <button className={`icon-btn ${showGrid ? 'active' : ''}`} title="显示 / 隐藏网格" onClick={toggleGrid}>
          <Icon name="grid" />
        </button>
        <button
          className={`icon-btn ${showSkeleton ? 'active' : ''}`}
          title="显示 / 隐藏骨骼"
          onClick={toggleSkeleton}
        >
          <Icon name="bone" />
        </button>
        <button className="icon-btn" title="回到默认姿势（停止动画）" onClick={resetPose}>
          <Icon name="person" />
        </button>
      </div>

      {!hasCharacter && parts.length === 0 ? (
        <div className="vp-hint">从左侧资源库导入模型开始 · 点击对象可选中并用操纵器调整</div>
      ) : !selection ? (
        <div className="vp-hint">点击部件 / 角色 / 挂载物选中 · W 移动 E 旋转 R 缩放 · Delete 删除选中</div>
      ) : null}
    </main>
  )
}
