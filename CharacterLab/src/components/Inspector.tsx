import type { InspectorTab } from '../types'
import { useEditor } from '../store/editor'
import { useLibrary } from '../store/library'
import { SLOT_GROUPS, SLOT_LABELS, SOCKET_PRESETS } from '../core/skeletons/standard'
import {
  conformSkeletonToUE, groundCharacter, mountAsset, normalizeHeight, overrideSkeletonWithManny,
  playClip, reAutoMap, removeAttachment, removeClip, resetPose, resetTransform, select,
  setCharacterTransform, setInPlace, setLoop, setMaterialProp, setMeshVisible, setMorph,
  setSlotBone, setWireframe, updateAttachment,
} from '../app/controller'
import { PartsPanel } from './PartsPanel'
import { DragNumber, Section, SliderRow, Vec3Row } from './common'
import { Icon } from './Icons'
import { useState } from 'react'

const TABS: { id: InspectorTab; icon: string; label: string }[] = [
  { id: 'model', icon: 'person', label: '模型' },
  { id: 'anim', icon: 'film', label: '动画' },
  { id: 'skeleton', icon: 'bone', label: '骨骼' },
  { id: 'mount', icon: 'link', label: '挂载' },
  { id: 'parts', icon: 'scissors', label: '部件' },
]

export function Inspector() {
  const tab = useEditor((s) => s.tab)
  const set = useEditor((s) => s.set)
  const hasCharacter = useEditor((s) => s.hasCharacter)

  return (
    <aside className="insp">
      <div className="insp-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`insp-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => set({ tab: t.id })}
          >
            <Icon name={t.icon} size={13} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {!hasCharacter && tab !== 'parts' ? (
          <div className="empty-panel">
            还没有角色。
            <br />
            从左侧资源库导入模型，
            <br />
            然后点「设为角色」。
          </div>
        ) : tab === 'model' ? (
          <ModelPanel />
        ) : tab === 'anim' ? (
          <AnimPanel />
        ) : tab === 'skeleton' ? (
          <SkeletonPanel />
        ) : tab === 'parts' ? (
          <PartsPanel />
        ) : (
          <MountPanel />
        )}
      </div>
    </aside>
  )
}

/* ---------------------------------------------------------------- 模型 */
function ModelPanel() {
  const transform = useEditor((s) => s.transform)
  const meshes = useEditor((s) => s.meshes)
  const materials = useEditor((s) => s.materials)
  const morphs = useEditor((s) => s.morphs)
  const wireframe = useEditor((s) => s.wireframe)

  return (
    <>
      <Section title="变换">
        <div className="row">
          <span className="vec3-label">位置 m</span>
          <DragNumber className="axis-x" label="X" value={transform.x} step={0.01} onChange={(v) => setCharacterTransform({ x: v })} />
          <DragNumber className="axis-z" label="Z" value={transform.z} step={0.01} onChange={(v) => setCharacterTransform({ z: v })} />
        </div>
        <div className="row">
          <span className="vec3-label">朝向 °</span>
          <DragNumber label="Y" value={transform.rotY} step={1} digits={0} min={-360} max={360} onChange={(v) => setCharacterTransform({ rotY: v })} />
          <span className="vec3-label" style={{ width: 34, textAlign: 'right' }}>缩放</span>
          <DragNumber label="∷" value={transform.scale} step={0.01} min={0.01} onChange={(v) => setCharacterTransform({ scale: v })} />
        </div>
        <div className="row wrap">
          <button className="btn small" onClick={() => groundCharacter()}>
            <Icon name="ground" size={13} />落地
          </button>
          <button className="btn small" onClick={normalizeHeight}>
            <Icon name="ruler" size={13} />身高 1.8m
          </button>
          <button className="btn small" onClick={resetTransform}>重置变换</button>
          <button className="btn small" onClick={resetPose}>重置姿势</button>
        </div>
        <div className="hint">也可以在视口里点击角色，用操纵器直接拖动。</div>
      </Section>

      {meshes.length > 0 && (
        <Section title={`部件显隐（${meshes.length}）`}>
          {meshes.slice(0, 40).map((m) => (
            <label className="row" key={m.id} style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={m.visible}
                onChange={(e) => setMeshVisible(m.id, e.target.checked)}
              />
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.name}
              </span>
            </label>
          ))}
          {meshes.length > 40 && <div className="hint">仅显示前 40 个网格</div>}
        </Section>
      )}

      {materials.length > 0 && (
        <Section
          title={`材质（${materials.length}）`}
          right={
            <label className="row" style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--dim)', gap: 5 }}>
              <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
              线框
            </label>
          }
        >
          {materials.slice(0, 24).map((m) => (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div className="row">
                <input
                  type="color"
                  value={m.color}
                  onChange={(e) => setMaterialProp(m.id, { color: e.target.value })}
                />
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name}
                </span>
              </div>
              {m.metalness !== null && (
                <SliderRow label="金属度" value={m.metalness} min={0} max={1} onChange={(v) => setMaterialProp(m.id, { metalness: v })} />
              )}
              {m.roughness !== null && (
                <SliderRow label="粗糙度" value={m.roughness} min={0} max={1} onChange={(v) => setMaterialProp(m.id, { roughness: v })} />
              )}
            </div>
          ))}
        </Section>
      )}

      {morphs.length > 0 && (
        <Section title={`形态目标（${morphs.length}）`}>
          {morphs.map((m) => (
            <SliderRow key={m.key} label={m.label} value={m.value} min={0} max={1} onChange={(v) => setMorph(m.key, v)} />
          ))}
        </Section>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- 动画 */
function AnimPanel() {
  const clips = useEditor((s) => s.clips)
  // 只订阅不随帧变化的字段，避免播放中 30 次/秒重渲染整个列表
  const loop = useEditor((s) => s.playback.loop)
  const inPlace = useEditor((s) => s.playback.inPlace)
  const activeClipId = useEditor((s) => s.playback.clipId)

  return (
    <>
      <Section title="播放设置">
        <div className="row">
          <label className="row" style={{ gap: 5 }}>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            循环
          </label>
          <label className="row" style={{ gap: 5 }} title="去掉髋部水平位移，角色原地表演">
            <input type="checkbox" checked={inPlace} onChange={(e) => setInPlace(e.target.checked)} />
            原地播放
          </label>
        </div>
        <div className="hint">
          底部时间轴可变速、逐帧、拖 <b>黄色手柄</b> 裁剪帧区间另存新片段。
        </div>
      </Section>

      <Section title={`动画列表（${clips.length}）`}>
        {clips.length === 0 ? (
          <div className="hint">
            还没有动画。左侧资源库里：
            <br />· <b>内置</b>分类有 3 段示例动画
            <br />· 导入 Mixamo 等 FBX / GLB 动画后点「绑定动画」，
            骨架不同会<b>自动重定向</b>
          </div>
        ) : (
          clips.map((c) => (
            <div key={c.id} className={`list-row ${activeClipId === c.id ? 'active' : ''}`} onClick={() => playClip(c.id)}>
              <Icon name="play" size={12} />
              <div className="title">
                {c.name}
                <div className="meta">{c.source}</div>
              </div>
              <span className="meta">{c.duration.toFixed(2)}s · {c.frames}帧</span>
              <button
                className="icon-btn"
                style={{ width: 22, height: 22 }}
                title="删除该动画"
                onClick={(e) => {
                  e.stopPropagation()
                  removeClip(c.id)
                }}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))
        )}
      </Section>
    </>
  )
}

/* ---------------------------------------------------------------- 骨骼 */
function SkeletonPanel() {
  const bones = useEditor((s) => s.bones)
  const boneMap = useEditor((s) => s.boneMap)
  const skeletonGuess = useEditor((s) => s.skeletonGuess)

  if (bones.length === 0) {
    return (
      <Section title="用 Manny / UEFN 骨骼覆盖">
        <div className="hint">
          当前模型没有骨骼（静态模型或拼装结果）。点击下面的按钮会
          <b>自动蒙皮</b>：把标准 Manny 骨架按体型放进模型并计算权重，
          之后就能绑定动画、挂载武器了。
        </div>
        <button className="btn primary" onClick={overrideSkeletonWithManny}>
          <Icon name="bone" />
          自动蒙皮，绑上 Manny 骨骼
        </button>
        <div className="hint">适合人形、姿态接近 T / A-pose 的模型。</div>
      </Section>
    )
  }

  const sortedBones = [...bones].sort((a, b) => a.localeCompare(b))

  return (
    <>
      <Section title="用 Manny / UEFN 骨骼覆盖">
        <div className="hint">
          <b>整套替换</b>当前骨架：标准 Manny 骨架按模型比例适配关节位置，
          蒙皮权重自动转移（骨骼移植）。覆盖后命名、层级与 UEFN / Manny
          完全一致，内置动画直接可播，导出即标准骨骼。
        </div>
        <button className="btn primary" onClick={overrideSkeletonWithManny}>
          <Icon name="bone" />
          用 Manny 骨骼覆盖当前角色
        </button>
        <div className="hint">覆盖前先确认下方映射表基本正确；原动画与挂载会被清空（可撤销）。</div>
      </Section>

      <Section title="骨架信息">
        <div className="row">
          <span className="hint" style={{ flex: 1 }}>骨骼数量</span>
          <b>{bones.length}</b>
        </div>
        <div className="row">
          <span className="hint" style={{ flex: 1 }}>识别结果</span>
          <b>{skeletonGuess}</b>
        </div>
        <div className="row wrap">
          <button className="btn small" onClick={reAutoMap}>
            <Icon name="rotate" size={13} />
            重新自动匹配
          </button>
          <button className="btn small" title="保守方案：不换骨架，只把骨骼改成标准名（动画轨道同步）" onClick={conformSkeletonToUE}>
            仅重命名对齐
          </button>
        </div>
      </Section>

      <Section title="骨骼映射表">
        <div className="hint">
          自动识别的结果可以手动修正；映射越全，重定向与骨骼覆盖效果越好。带 ⚠ 的是空槽位。
        </div>
        {SLOT_GROUPS.map((g) => (
          <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="group-label">{g.label}</div>
            {g.slots.map((slot) => {
              const mapped = boneMap[slot] ?? ''
              return (
                <div key={slot} className={`map-row ${mapped ? '' : 'unmapped'}`}>
                  <span className="lbl">
                    {mapped ? '' : '⚠ '}
                    {SLOT_LABELS[slot]}
                  </span>
                  <select value={mapped} onChange={(e) => setSlotBone(slot, e.target.value)}>
                    <option value="">— 未映射 —</option>
                    {sortedBones.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>
        ))}
      </Section>
    </>
  )
}

/* ---------------------------------------------------------------- 挂载 */
function MountPanel() {
  const attachments = useEditor((s) => s.attachments)
  const bones = useEditor((s) => s.bones)
  const selection = useEditor((s) => s.selection)
  const libAssets = useLibrary((s) => s.assets)
  const [assetId, setAssetId] = useState('')
  const [target, setTarget] = useState('handR')
  const [customBone, setCustomBone] = useState('')

  const mountable = libAssets.filter((a) => a.kind === 'prop' || a.kind === 'model')
  const sortedBones = [...bones].sort((a, b) => a.localeCompare(b))

  return (
    <>
      <Section title="快速挂载">
        {mountable.length === 0 ? (
          <div className="hint">资源库里还没有可挂载的道具 / 模型；先导入武器等模型文件。</div>
        ) : (
          <>
            <div className="row">
              <span className="hint" style={{ width: 44 }}>物品</span>
              <select className="grow" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">选择物品…</option>
                {mountable.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="row">
              <span className="hint" style={{ width: 44 }}>部位</span>
              <select className="grow" value={target} onChange={(e) => setTarget(e.target.value)}>
                {SOCKET_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                <option value="__custom__">自定义骨骼…</option>
              </select>
            </div>
            {target === '__custom__' && (
              <div className="row">
                <span className="hint" style={{ width: 44 }}>骨骼</span>
                <select className="grow" value={customBone} onChange={(e) => setCustomBone(e.target.value)}>
                  <option value="">选择骨骼…</option>
                  {sortedBones.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            )}
            <button
              className="btn primary small"
              disabled={!assetId || (target === '__custom__' && !customBone)}
              onClick={() => {
                if (target === '__custom__') mountAsset(assetId, { boneName: customBone })
                else mountAsset(assetId, { presetId: target })
              }}
            >
              <Icon name="plus" size={13} />
              挂载
            </button>
            <div className="hint">挂上后在视口点击它，用操纵器微调位置角度。</div>
          </>
        )}
      </Section>

      <Section title={`已挂载（${attachments.length}）`}>
        {attachments.length === 0 ? (
          <div className="hint">还没有挂载物。</div>
        ) : (
          attachments.map((a) => {
            const isSel = selection?.kind === 'attachment' && selection.id === a.id
            return (
              <div key={a.id} className="att-card" style={isSel ? { borderColor: 'rgba(103,212,168,.55)' } : undefined}>
                <div className="head" onClick={() => select({ kind: 'attachment', id: a.id })} style={{ cursor: 'pointer' }}>
                  <Icon name="link" size={13} />
                  <span className="name">{a.name}</span>
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    title="移除挂载"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeAttachment(a.id)
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                <div className="row">
                  <span className="hint" style={{ width: 44 }}>骨骼</span>
                  <select className="grow" value={a.bone} onChange={(e) => updateAttachment(a.id, { bone: e.target.value })}>
                    {sortedBones.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
                <Vec3Row
                  label="偏移 cm"
                  x={a.px} y={a.py} z={a.pz}
                  step={0.5} digits={1}
                  onChange={(axis, v) =>
                    updateAttachment(a.id, axis === 'x' ? { px: v } : axis === 'y' ? { py: v } : { pz: v })
                  }
                />
                <Vec3Row
                  label="旋转 °"
                  x={a.rx} y={a.ry} z={a.rz}
                  step={1} digits={0}
                  onChange={(axis, v) =>
                    updateAttachment(a.id, axis === 'x' ? { rx: v } : axis === 'y' ? { ry: v } : { rz: v })
                  }
                />
                <div className="row">
                  <span className="vec3-label">缩放</span>
                  <DragNumber label="∷" value={a.scale} step={0.01} min={0.01} onChange={(v) => updateAttachment(a.id, { scale: v })} />
                </div>
              </div>
            )
          })
        )}
      </Section>
    </>
  )
}
