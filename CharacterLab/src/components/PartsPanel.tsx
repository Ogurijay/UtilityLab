import { useEffect, useState } from 'react'
import type { BodyRegion } from '../types'
import { useEditor } from '../store/editor'
import { useLibrary } from '../store/library'
import { REGION_LABELS } from '../core/mesh/cut'
import {
  addPartFromAsset, clearParts, cutCharacterByPlane, cutCharacterByRegions, mergeParts,
  removePart, selectPart, setCutPlanePreset, setCutPlaneVisible, splitCharacterSubmeshes,
  updatePart,
} from '../app/controller'
import { DragNumber, Section, Vec3Row } from './common'
import { Icon } from './Icons'

/** 单区域 + 常用组合 */
const REGION_PRESETS: { label: string; regions: BodyRegion[] }[] = [
  { label: '头部', regions: ['head'] },
  { label: '躯干', regions: ['torso'] },
  { label: '左臂', regions: ['armL'] },
  { label: '右臂', regions: ['armR'] },
  { label: '左腿', regions: ['legL'] },
  { label: '右腿', regions: ['legR'] },
  { label: '双臂', regions: ['armL', 'armR'] },
  { label: '双腿', regions: ['legL', 'legR'] },
  { label: '上半身', regions: ['head', 'torso', 'armL', 'armR'] },
]

export function PartsPanel() {
  const hasCharacter = useEditor((s) => s.hasCharacter)
  const bones = useEditor((s) => s.bones)
  const meshes = useEditor((s) => s.meshes)
  const parts = useEditor((s) => s.parts)
  const selection = useEditor((s) => s.selection)
  const libAssets = useLibrary((s) => s.assets)

  const planeOn = useEditor((s) => s.cutPlaneOn)
  const [busy, setBusy] = useState(false)
  const [keep, setKeep] = useState<'both' | 'front' | 'back'>('both')
  const [toStage, setToStage] = useState(true)
  const [addId, setAddId] = useState('')

  // 离开面板时收起切割平面
  useEffect(() => {
    return () => setCutPlaneVisible(false)
  }, [])

  const addable = libAssets.filter((a) => a.kind === 'model' || a.kind === 'prop')

  // 选中的资源被删除后自动复位，避免按钮可点但静默无效
  useEffect(() => {
    if (addId && !addable.some((a) => a.id === addId)) setAddId('')
  }, [libAssets]) // eslint-disable-line react-hooks/exhaustive-deps
  const selectedPart = selection?.kind === 'part' ? parts.find((p) => p.id === selection.id) : undefined

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section title="切割当前角色">
        {!hasCharacter ? (
          <div className="hint">先加载一个角色，就可以把它切成部件。</div>
        ) : (
          <>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={toStage} onChange={(e) => setToStage(e.target.checked)} />
              切割结果直接加入拼装台
              <span className="hint" style={{ marginLeft: 'auto' }}>始终会存入资源库</span>
            </label>

            {bones.length > 0 && (
              <>
                <div className="group-label">按身体部位（依据蒙皮权重，切口沿身体分界）</div>
                <div className="chips">
                  {REGION_PRESETS.map((r) => (
                    <button
                      key={r.label}
                      className="chip"
                      disabled={busy}
                      title={r.regions.map((x) => REGION_LABELS[x]).join(' + ')}
                      onClick={() => run(() => cutCharacterByRegions(r.regions, r.label, toStage))}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="group-label">按切割平面（可用操纵器自由移动、旋转）</div>
            <div className="row">
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={planeOn}
                  onChange={(e) => setCutPlaneVisible(e.target.checked)}
                />
                切割平面
              </label>
              {planeOn && (
                <span className="row" style={{ gap: 4, marginLeft: 'auto' }}>
                  <button className="btn small ghost" onClick={() => setCutPlanePreset('y')}>水平</button>
                  <button className="btn small ghost" onClick={() => setCutPlanePreset('x')}>竖直·左右</button>
                  <button className="btn small ghost" onClick={() => setCutPlanePreset('z')}>竖直·前后</button>
                </span>
              )}
            </div>
            {planeOn && (
              <>
                <div className="row">
                  <span className="hint" style={{ width: 56 }}>保留</span>
                  <select className="grow" value={keep} onChange={(e) => setKeep(e.target.value as typeof keep)}>
                    <option value="both">两侧都保留（两件）</option>
                    <option value="front">只保留法线正侧</option>
                    <option value="back">只保留法线负侧</option>
                  </select>
                </div>
                <button className="btn primary small" disabled={busy} onClick={() => run(() => cutCharacterByPlane(keep, toStage))}>
                  <Icon name="scissors" />
                  沿平面切割
                </button>
                <div className="hint">提示：切口是敞开的，不会自动补面。</div>
              </>
            )}

            {meshes.length > 1 && (
              <button className="btn small" disabled={busy} onClick={() => run(() => splitCharacterSubmeshes(toStage))}>
                <Icon name="layers" />
                按子网格拆分（{meshes.length} 个）
              </button>
            )}
            {busy && <div className="importing-bar">正在切割 / 保存部件…</div>}
          </>
        )}
      </Section>

      <Section
        title={`拼装台（${parts.length}）`}
        right={
          parts.length > 0 ? (
            <button className="btn ghost small" disabled={busy} onClick={clearParts}>清空</button>
          ) : undefined
        }
      >
        <div className="row">
          <select className="grow" value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">从资源库添加部件…</option>
            {addable.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            className="btn small"
            disabled={!addId || busy}
            onClick={() => run(() => addPartFromAsset(addId))}
          >
            <Icon name="plus" size={13} />
            添加
          </button>
        </div>

        {parts.length === 0 ? (
          <div className="hint">
            切割出的部件或库里的模型都能加进来；在<b>视口里点击部件</b>即可选中，
            用操纵器（W 移动 / E 旋转 / R 缩放）自由拼接。
          </div>
        ) : (
          <>
            {parts.map((p) => (
              <div
                key={p.id}
                className={`list-row ${selectedPart?.id === p.id ? 'selected' : ''}`}
                onClick={() => selectPart(p.id)}
              >
                <Icon name="cube" size={13} />
                <span className="title">{p.name}</span>
                {p.mirror && <span className="meta">镜像</span>}
                <button
                  className="icon-btn"
                  style={{ width: 22, height: 22 }}
                  title="移除部件"
                  onClick={(e) => {
                    e.stopPropagation()
                    removePart(p.id)
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}

            {selectedPart && (
              <div className="part-detail">
                <div className="row" style={{ fontWeight: 600 }}>
                  <Icon name="cube" size={13} />
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedPart.name}
                  </span>
                  <label className="row" style={{ gap: 4, fontWeight: 400, fontSize: 11.5 }} title="沿 X 轴镜像（左件变右件）">
                    <input
                      type="checkbox"
                      checked={selectedPart.mirror}
                      onChange={(e) => updatePart(selectedPart.id, { mirror: e.target.checked })}
                    />
                    <Icon name="mirror" size={12} />
                  </label>
                </div>
                <Vec3Row
                  label="位置 m"
                  x={selectedPart.x} y={selectedPart.y} z={selectedPart.z}
                  step={0.005} digits={3}
                  onChange={(axis, v) => updatePart(selectedPart.id, { [axis]: v })}
                />
                <Vec3Row
                  label="旋转 °"
                  x={selectedPart.rx} y={selectedPart.ry} z={selectedPart.rz}
                  step={1} digits={0}
                  onChange={(axis, v) =>
                    updatePart(selectedPart.id, axis === 'x' ? { rx: v } : axis === 'y' ? { ry: v } : { rz: v })
                  }
                />
                <div className="row">
                  <span className="vec3-label">缩放</span>
                  <DragNumber
                    label="∷"
                    value={selectedPart.sx}
                    step={0.01}
                    min={0.01}
                    onChange={(v) => updatePart(selectedPart.id, { sx: v, sy: v, sz: v })}
                  />
                </div>
              </div>
            )}

            <button className="btn primary" disabled={busy} onClick={() => run(() => mergeParts('character'))}>
              <Icon name="link" />
              合并并设为当前角色
            </button>
            <button className="btn small" disabled={busy} onClick={() => run(() => mergeParts('library'))}>
              <Icon name="save" />
              仅合并保存到库
            </button>
            <div className="hint">合并后到「骨骼」页盖上 Manny 骨骼，即可绑定动画。</div>
          </>
        )}
      </Section>
    </>
  )
}
