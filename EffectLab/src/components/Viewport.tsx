import { useEffect, useRef, useState } from 'react'
import { Engine } from '../core/engine'
import { setEngine } from '../app/engineHandle'
import { useEditor } from '../store/editor'
import { getTextureBlob } from '../db/textureDb'
import { textureFromBlob } from '../core/material/procedural'

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const lastStatsAt = useRef(0)
  const [error, setError] = useState<string | null>(null)

  const spec = useEditor((s) => s.spec)
  const playing = useEditor((s) => s.playing)
  const showHelpers = useEditor((s) => s.showHelpers)
  const textures = useEditor((s) => s.textures)
  const setStats = useEditor((s) => s.setStats)

  useEffect(() => {
    if (!hostRef.current) return
    let engine: Engine
    try {
      engine = new Engine(hostRef.current, useEditor.getState().spec)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    engine.onStats = (s) => {
      const now = performance.now()
      if (now - lastStatsAt.current < 250) return
      lastStatsAt.current = now
      setStats(s)
    }
    engineRef.current = engine
    setEngine(engine)
    // 开发期把引擎挂到 window，方便在控制台单步调试与像素级自检
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__effectlab = engine
    return () => {
      setEngine(null)
      engineRef.current = null
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__effectlab
      engine.dispose()
    }
  }, [setStats])

  useEffect(() => {
    engineRef.current?.applySpec(spec)
  }, [spec])

  useEffect(() => {
    if (engineRef.current) engineRef.current.playing = playing
  }, [playing])

  useEffect(() => {
    engineRef.current?.setHelpersVisible(showHelpers)
  }, [showHelpers])

  // 贴图库变化时把用户贴图送进引擎
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const entry of textures) {
        const blob = await getTextureBlob(entry.id)
        if (!blob || cancelled) continue
        const tex = await textureFromBlob(blob, true)
        if (cancelled) {
          tex.dispose()
          return
        }
        engineRef.current?.setUserTexture(entry.id, tex)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [textures])

  return (
    <div className="viewport" ref={hostRef}>
      {error && (
        <div className="viewport-error">
          <strong>无法启动渲染器</strong>
          <p>{error}</p>
          <p className="dim">EffectLab 需要支持 WebGL2 与浮点渲染目标的浏览器。</p>
        </div>
      )}
    </div>
  )
}
