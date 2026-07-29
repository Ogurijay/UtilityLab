import { useRef } from 'react'
import { useEditor } from '../store/editor'
import { getEngine } from '../app/engineHandle'
import { normalizeSpec } from '../presets'

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function TopBar() {
  const spec = useEditor((s) => s.spec)
  const update = useEditor((s) => s.update)
  const loadSpec = useEditor((s) => s.loadSpec)
  const playing = useEditor((s) => s.playing)
  const setPlaying = useEditor((s) => s.setPlaying)
  const showHelpers = useEditor((s) => s.showHelpers)
  const toggleHelpers = useEditor((s) => s.toggleHelpers)
  const stats = useEditor((s) => s.stats)
  const notify = useEditor((s) => s.notify)
  const fileRef = useRef<HTMLInputElement>(null)

  const restart = () => getEngine()?.restart()

  return (
    <header className="topbar">
      <div className="brand">
        <span className="dot" />
        EffectLab
        <span className="dim">· 特效工坊</span>
      </div>

      <input
        className="name-input"
        value={spec.name}
        onChange={(e) => update((s) => void (s.name = e.target.value))}
        spellCheck={false}
      />

      <div className="transport">
        <button onClick={() => setPlaying(!playing)} title="播放 / 暂停">
          {playing ? '⏸' : '⏵'}
        </button>
        <button onClick={() => getEngine()?.stepOnce()} title="单步（暂停时用）" disabled={playing}>
          ⏭
        </button>
        <button onClick={restart} title="从 t=0 重跑">
          ⟲
        </button>
      </div>

      <label className="helper-toggle">
        <input type="checkbox" checked={showHelpers} onChange={toggleHelpers} />
        辅助显示
      </label>

      <div className="spacer" />

      <div className="stats mono">
        <span>{stats.fps.toFixed(0)} fps</span>
        <span>t {stats.simTime.toFixed(2)}s</span>
        <span>#{stats.frame}</span>
        <span>{stats.capacity.toLocaleString()} 粒子</span>
      </div>

      <div className="actions">
        <button
          onClick={() => {
            const safe = spec.name.replace(/[^\w一-龥-]+/g, '_') || 'effect'
            download(`${safe}.effect.json`, JSON.stringify(spec, null, 2))
            notify('已导出特效参数 JSON')
          }}
        >
          导出 JSON
        </button>
        <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            try {
              loadSpec(normalizeSpec(JSON.parse(await file.text())))
              restart()
              notify('已载入特效参数')
            } catch (err) {
              notify(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
            }
          }}
        />
      </div>
    </header>
  )
}
