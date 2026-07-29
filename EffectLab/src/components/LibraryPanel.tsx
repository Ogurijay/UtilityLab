import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../store/editor'
import { getEngine } from '../app/engineHandle'
import { BUILTIN_PRESETS, normalizeSpec } from '../presets'
import { deletePreset, deleteTexture, listPresets, listTextures, putPreset, putTexture } from '../db/textureDb'
import type { EffectSpec, TextureEntry } from '../types'

export function LibraryPanel() {
  const spec = useEditor((s) => s.spec)
  const loadSpec = useEditor((s) => s.loadSpec)
  const textures = useEditor((s) => s.textures)
  const setTextures = useEditor((s) => s.setTextures)
  const notify = useEditor((s) => s.notify)
  const [saved, setSaved] = useState<{ id: string; spec: EffectSpec }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshPresets = async () => {
    const rows = await listPresets()
    setSaved(
      rows.map((r) => {
        try {
          return { id: r.id, spec: normalizeSpec(JSON.parse(r.json)) }
        } catch {
          return { id: r.id, spec: normalizeSpec(null) }
        }
      })
    )
  }
  const refreshTextures = async () => setTextures(await listTextures())

  useEffect(() => {
    void refreshPresets()
    void refreshTextures()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = (s: EffectSpec) => {
    loadSpec(s)
    getEngine()?.restart()
  }

  const importTextures = async (files: FileList) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        notify(`跳过非图片文件：${file.name}`)
        continue
      }
      const bitmap = await createImageBitmap(file)
      const entry: TextureEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        width: bitmap.width,
        height: bitmap.height,
        createdAt: Date.now(),
      }
      bitmap.close()
      await putTexture(entry, file)
    }
    await refreshTextures()
  }

  return (
    <aside className="library">
      <div className="panel">
        <div className="panel-head">
          <span>预设</span>
          <button
            className="mini"
            onClick={async () => {
              await putPreset(spec.name || '未命名', JSON.stringify(spec))
              await refreshPresets()
              notify(`已保存预设「${spec.name}」到本地`)
            }}
          >
            保存当前
          </button>
        </div>
        <div className="panel-body">
          <div className="group-label">内置</div>
          {BUILTIN_PRESETS.map((p) => (
            <button key={p.name} className="list-item" onClick={() => apply(p)}>
              {p.name}
            </button>
          ))}
          {saved.length > 0 && <div className="group-label">本地保存</div>}
          {saved.map((p) => (
            <div key={p.id} className="list-row">
              <button className="list-item" onClick={() => apply(p.spec)}>
                {p.id}
              </button>
              <button
                className="mini danger"
                title="删除"
                onClick={async () => {
                  await deletePreset(p.id)
                  await refreshPresets()
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>贴图库</span>
          <button className="mini" onClick={() => fileRef.current?.click()}>
            导入图片
          </button>
        </div>
        <div className="panel-body">
          {textures.length === 0 && (
            <p className="empty">
              还没有导入贴图。内置精灵与噪声都是运行时程序化生成的，
              仓库里不存放任何图片资产。
            </p>
          )}
          {textures.map((t) => (
            <div key={t.id} className="list-row">
              <span className="list-item static" title={`${t.width}×${t.height}`}>
                {t.name}
                <span className="dim mono"> {t.width}×{t.height}</span>
              </span>
              <button
                className="mini danger"
                title="删除"
                onClick={async () => {
                  await deleteTexture(t.id)
                  getEngine()?.removeUserTexture(t.id)
                  await refreshTextures()
                }}
              >
                ×
              </button>
            </div>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={async (e) => {
              const files = e.target.files
              e.target.value = ''
              if (files?.length) await importTextures(files)
            }}
          />
        </div>
      </div>
    </aside>
  )
}
