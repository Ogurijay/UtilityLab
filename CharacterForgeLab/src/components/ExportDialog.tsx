import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../store/editor'
import { exportCharacterGlb } from '../app/controller'
import { Modal } from './common'

export function ExportDialog() {
  const characterName = useEditor((s) => s.characterName)
  const clips = useEditor((s) => s.clips)
  const attachments = useEditor((s) => s.attachments)
  const set = useEditor((s) => s.set)

  const [fileName, setFileName] = useState(characterName || 'character')
  const [withAttachments, setWithAttachments] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set(clips.map((c) => c.id)))
  const [busy, setBusy] = useState(false)

  // 对话框打开期间动画列表可能变化（撤销等）：剔除失效 id，只有真正新出现的片段默认勾选
  const seenClipIds = useRef(new Set(clips.map((c) => c.id)))
  useEffect(() => {
    setSelected((prev) => {
      const kept = new Set([...prev].filter((id) => clips.some((c) => c.id === id)))
      for (const c of clips) {
        if (!seenClipIds.current.has(c.id)) {
          kept.add(c.id)
          seenClipIds.current.add(c.id)
        }
      }
      return kept
    })
  }, [clips])

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <Modal
      title="导出 GLB"
      onClose={() => set({ exportOpen: false })}
      footer={
        <>
          <button className="btn" onClick={() => set({ exportOpen: false })}>取消</button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await exportCharacterGlb({
                fileName: fileName.trim() || 'character',
                clipIds: clips.filter((c) => selected.has(c.id)).map((c) => c.id),
                includeAttachments: withAttachments,
              })
              setBusy(false)
              set({ exportOpen: false })
            }}
          >
            {busy ? '导出中…' : '导出 .glb'}
          </button>
        </>
      }
    >
      <div className="row">
        <span style={{ width: 72, color: 'var(--dim)' }}>文件名</span>
        <input
          className="grow"
          type="text"
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
        />
        <span style={{ color: 'var(--faint)' }}>.glb</span>
      </div>

      <label className="row" style={{ gap: 6 }}>
        <input
          type="checkbox"
          checked={withAttachments}
          onChange={(e) => setWithAttachments(e.target.checked)}
        />
        包含挂载物（{attachments.length} 件）
      </label>

      <div>
        <div style={{ color: 'var(--dim)', marginBottom: 6 }}>包含的动画（{selected.size}/{clips.length}）</div>
        {clips.length === 0 ? (
          <div className="hint">当前角色没有绑定动画；仍可导出模型本体。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 200, overflowY: 'auto' }}>
            {clips.map((c) => (
              <label key={c.id} className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </span>
                <span style={{ color: 'var(--faint)', fontSize: 11 }}>{c.duration.toFixed(2)}s</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="hint">
        导出为标准 glTF 二进制（.glb），可直接导入 Blender、Unreal / UEFN、Unity、Godot 等。
        隐藏中的部件不会被导出。若已执行「重命名为 UEFN 标准骨骼名」，导出的骨骼即为 Manny 命名。
      </div>
    </Modal>
  )
}
