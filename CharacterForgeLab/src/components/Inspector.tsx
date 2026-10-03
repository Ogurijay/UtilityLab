import type { InspectorTab } from '../types'
import { useEditor } from '../store/editor'
import { useLibrary } from '../store/library'
import { SLOT_GROUPS, SLOT_LABELS, SOCKET_PRESETS } from '../core/skeletons/standard'
import {
  beginBaselineRigFit, cancelBaselineRigFit, commitBaselineRigFit, conformSkeletonToUE, groundCharacter, mountAsset, normalizeHeight,
  playClip, reAutoMap, removeAttachment, removeClip, replaceHeadWithAsset, resetPose,
  resetBaselineRigFit, resetModelPlacement, resetSelectedBone, resetTransform, select, selectBone, setReferencePose,
  setSelectedBoneKeyframe, setSelectedBoneTransform, submitBlenderAutoRig,
  setCharacterTransform, setInPlace, setLoop, setMaterialProp, setMeshVisible, setMorph,
  setSlotBone, setUniformScale, setWireframe, updateAttachment,
} from '../app/controller'
import { PartsPanel } from './PartsPanel'
import { DragNumber, Section, SliderRow, Vec3Row } from './common'
import { Icon } from './Icons'
import { useMemo, useState } from 'react'

const TABS: { id: InspectorTab; icon: string; label: string }[] = [
  { id: 'model', icon: 'person', label: '模型' },
  { id: 'head', icon: 'person', label: '换头' },
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
        ) : tab === 'head' ? (
          <HeadPanel />
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

/* ---------------------------------------------------------------- 静态头雕替换 */
function HeadPanel() {
  const [assetId, setAssetId] = useState('')
  const systemAssets = useLibrary((s) => s.systemAssets)
  const userAssets = useLibrary((s) => s.assets)
  const assets = useMemo(
    () => [...systemAssets, ...userAssets],
    [systemAssets, userAssets],
  )
  const attachments = useEditor((s) => s.attachments)
  const head = attachments.find((item) => item.role === 'head_component')
  const selection = useEditor((s) => s.selection)
  const staticAssets = assets.filter((asset) => asset.kind === 'model' || asset.kind === 'prop')

  return (
    <>
      <Section title="静态头雕替换">
        <div className="hint">
          选择一个<b>不含骨骼和动画</b>的头雕。编辑器会从 Manny / UEFN 身体派生隐藏原头，
          再把头雕作为独立组件挂到 head（头部）骨骼；源资产不会被改写。
        </div>
        <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
          <option value="">选择静态头雕…</option>
          {staticAssets.map((asset) => (
            <option key={asset.id} value={asset.id}>{asset.name}</option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!assetId}
          onClick={() => void replaceHeadWithAsset(assetId)}
        >
          替换头部并创建独立组件
        </button>
      </Section>

      <Section title="当前头部组件">
        {!head ? (
          <div className="hint">还没有替换头部。</div>
        ) : (
          <div className="att-card">
            <div
              className="head"
              style={{ cursor: 'pointer' }}
              onClick={() => select({ kind: 'attachment', id: head.id })}
            >
              <Icon name="link" size={13} />
              <span className="name">{head.name}</span>
              {selection?.kind === 'attachment' && selection.id === head.id && <span className="meta">已选中</span>}
            </div>
            <Vec3Row
              label="位置 cm"
              x={head.px} y={head.py} z={head.pz}
              step={0.2} digits={1}
              sliderMin={-40} sliderMax={40}
              onChange={(axis, value) => updateAttachment(
                head.id,
                axis === 'x' ? { px: value } : axis === 'y' ? { py: value } : { pz: value },
              )}
            />
            <Vec3Row
              label="旋转 °"
              x={head.rx} y={head.ry} z={head.rz}
              step={0.5} digits={1}
              sliderMin={-180} sliderMax={180}
              onChange={(axis, value) => updateAttachment(
                head.id,
                axis === 'x' ? { rx: value } : axis === 'y' ? { ry: value } : { rz: value },
              )}
            />
            <SliderRow
              label="缩放"
              value={head.scale}
              min={0.01}
              max={5}
              step={0.01}
              onChange={(value) => updateAttachment(head.id, { scale: value })}
            />
          </div>
        )}
      </Section>
    </>
  )
}

/* ---------------------------------------------------------------- 模型 */
function ModelPanel() {
  const transform = useEditor((s) => s.transform)
  const meshes = useEditor((s) => s.meshes)
  const materials = useEditor((s) => s.materials)
  const morphs = useEditor((s) => s.morphs)
  const wireframe = useEditor((s) => s.wireframe)
  const uniformScale = useEditor((s) => s.uniformScale)

  return (
    <>
      <Section
        title="变换"
        right={(
          <button
            className={`btn small transform-lock ${uniformScale ? 'active' : ''}`}
            title={uniformScale ? '已锁定长宽高比例' : '长宽高可以独立缩放'}
            onClick={() => setUniformScale(!uniformScale)}
          >
            <Icon name={uniformScale ? 'lock' : 'unlock'} size={12} />
            {uniformScale ? '缩放已锁定' : '缩放未锁定'}
          </button>
        )}
      >
        <Vec3Row
          label="位置 m"
          x={transform.px} y={transform.py} z={transform.pz}
          step={0.01} digits={3}
          sliderMin={-5} sliderMax={5}
          onChange={(axis, value) => setCharacterTransform({
            [axis === 'x' ? 'px' : axis === 'y' ? 'py' : 'pz']: value,
          })}
        />
        <Vec3Row
          label="旋转 °"
          x={transform.rx} y={transform.ry} z={transform.rz}
          step={0.5} digits={1}
          min={-360} max={360}
          sliderMin={-180} sliderMax={180}
          onChange={(axis, value) => setCharacterTransform({
            [axis === 'x' ? 'rx' : axis === 'y' ? 'ry' : 'rz']: value,
          })}
        />
        <Vec3Row
          label="缩放"
          x={transform.sx} y={transform.sy} z={transform.sz}
          step={0.01} digits={3}
          min={0.01}
          sliderMin={0.01} sliderMax={5}
          onChange={(axis, value) => setCharacterTransform({
            [axis === 'x' ? 'sx' : axis === 'y' ? 'sy' : 'sz']: value,
          })}
        />
        <div className="row wrap">
          <button className="btn small" onClick={() => groundCharacter()}>
            <Icon name="ground" size={13} />落地
          </button>
          <button className="btn small" onClick={normalizeHeight}>
            <Icon name="ruler" size={13} />身高 1.8m
          </button>
          <button
            className="btn small"
            title="修正文件内部原点：模型水平居中、脚底落地，骨架与蒙皮会一起移动"
            onClick={resetModelPlacement}
          >
            模型归位
          </button>
          <button className="btn small" onClick={resetTransform}>重置变换</button>
          <button className="btn small" onClick={resetPose}>重置姿势</button>
        </div>
        <div className="hint">
          每个轴都可拖动滑条或直接输入数值；锁定时调整任意缩放轴都会保持长宽高比例。
        </div>
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
  const profileId = useEditor((s) => s.referencePoseProfileId)
  const referencePose = useEditor((s) => s.referencePose)
  const selection = useEditor((s) => s.selection)
  const boneTransform = useEditor((s) => s.boneTransform)
  const activeClipId = useEditor((s) => s.playback.clipId)
  const animationEditTracks = useEditor((s) => s.animationEditTracks)
  const rigFitActive = useEditor((s) => s.rigFitActive)

  if (rigFitActive) {
    return (
      <Section title="绑定前骨架适配">
        <BaselineRigControls />
      </Section>
    )
  }

  if (bones.length === 0) {
    return (
      <Section title="用 Manny / UEFN 骨骼覆盖">
        <div className="hint">
          当前模型没有骨骼。选择系统基准与模型当前姿势后，会把真实的完整骨架按体型放入模型并计算基础四权重蒙皮。
        </div>
        <BaselineRigControls />
      </Section>
    )
  }

  const sortedBones = [...bones].sort((a, b) => a.localeCompare(b))
  const selectedBone = selection?.kind === 'bone' ? selection.id || '' : ''
  const movableBone = selectedBone === boneMap.root || selectedBone === boneMap.hips

  return (
    <>
      <Section title="标准姿势">
        <div className="pose-buttons">
          <button className={`btn small ${referencePose === 'source' ? 'active' : ''}`} onClick={() => void setReferencePose('source')}>
            原始绑定姿势
          </button>
          <button
            className={`btn small ${referencePose === 't' ? 'active' : ''}`}
            disabled={!profileId}
            title={profileId ? '使用签名校验过的基准 T Pose' : '第三方骨架不自动推算 T Pose'}
            onClick={() => void setReferencePose('t')}
          >
            T Pose
          </button>
          <button
            className={`btn small ${referencePose === 'a' ? 'active' : ''}`}
            disabled={!profileId}
            title={profileId ? '使用签名校验过的基准 A Pose' : '第三方骨架不自动推算 A Pose'}
            onClick={() => void setReferencePose('a')}
          >
            A Pose
          </button>
        </div>
        <div className="hint">
          {profileId
            ? `当前参考骨架：${profileId}。T/A Pose 会先校验骨骼数量和父子层级，不再临时推算。`
            : '当前模型没有已验证的 Manny / UEFN 配置，只允许准确恢复原始绑定姿势。'}
        </div>
      </Section>

      <Section title="单骨骼姿势与关键帧">
        <div className="hint">打开骨骼后，可直接点击视口中的低亮度骨骼点；也可从下拉框选择。</div>
        <select value={selectedBone} onChange={(event) => selectBone(event.target.value)}>
          <option value="">选择骨骼…</option>
          {sortedBones.map((bone) => <option key={bone} value={bone}>{bone}</option>)}
        </select>
        {selectedBone && (
          <>
            {movableBone && (
              <Vec3Row
                label="位置"
                x={boneTransform.px} y={boneTransform.py} z={boneTransform.pz}
                step={0.005} digits={3}
                sliderMin={-2} sliderMax={2}
                onChange={(axis, value) => setSelectedBoneTransform({
                  [axis === 'x' ? 'px' : axis === 'y' ? 'py' : 'pz']: value,
                })}
              />
            )}
            <Vec3Row
              label="旋转 °"
              x={boneTransform.rx} y={boneTransform.ry} z={boneTransform.rz}
              step={0.5} digits={1}
              sliderMin={-180} sliderMax={180}
              onChange={(axis, value) => setSelectedBoneTransform({
                [axis === 'x' ? 'rx' : axis === 'y' ? 'ry' : 'rz']: value,
              })}
            />
            <div className="row wrap">
              <button className="btn small" onClick={resetSelectedBone}>恢复该骨骼</button>
              <button className="btn primary small" disabled={!activeClipId} onClick={setSelectedBoneKeyframe}>
                在当前时间记录关键帧
              </button>
            </div>
            <div className="hint">
              普通骨骼只允许旋转；root / pelvis（根骨骼 / 骨盆）额外允许位置。已写入 {animationEditTracks} 条覆盖轨道。
            </div>
          </>
        )}
      </Section>

      <Section title="用 Manny / UEFN 骨骼覆盖">
        <div className="hint">
          <b>整套替换</b>当前骨架：把角色烘成当前姿势的派生网格，再用真实 Manny / UEFN 完整骨架重新计算基础蒙皮。
          原角色不会被覆盖，并且可以撤销。
        </div>
        <BaselineRigControls />
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

function BaselineRigControls() {
  const [profile, setProfile] = useState<'ue5-mannequin-simple' | 'uefn-mannequin'>('ue5-mannequin-simple')
  const [sourcePose, setSourcePose] = useState<'t' | 'a'>('t')
  const [busy, setBusy] = useState(false)
  const rigJob = useEditor((state) => state.rigJob)
  const fitting = useEditor((state) => state.rigFitActive)
  const fitProfile = useEditor((state) => state.rigFitProfileId)
  const fitSourcePose = useEditor((state) => state.rigFitSourcePose)
  const fitBones = useEditor((state) => state.rigFitBones)
  const adjustedCount = useEditor((state) => state.rigFitAdjustedCount)
  const selection = useEditor((state) => state.selection)
  const boneTransform = useEditor((state) => state.boneTransform)
  const selectedBone = selection?.kind === 'bone' ? selection.id || '' : ''
  const currentProfile = fitting && fitProfile ? fitProfile : profile
  const currentPose = fitting ? fitSourcePose : sourcePose

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="row">
        <span className="hint" style={{ width: 72 }}>基准骨架</span>
        <select
          className="grow"
          value={currentProfile}
          disabled={busy || fitting}
          onChange={(event) => setProfile(event.target.value as typeof profile)}
        >
          <option value="ue5-mannequin-simple">UE5 Manny Simple（89 骨）</option>
          <option value="uefn-mannequin">UEFN Mannequin（88 骨）</option>
        </select>
      </div>
      <div className="row">
        <span className="hint" style={{ width: 72 }}>模型姿势</span>
        <select
          className="grow"
          value={currentPose}
          disabled={busy || fitting}
          onChange={(event) => setSourcePose(event.target.value as typeof sourcePose)}
        >
          <option value="t">T Pose（双臂水平）</option>
          <option value="a">A Pose（双臂斜下）</option>
        </select>
      </div>

      {!fitting ? (
        <>
          <button
            className="btn"
            disabled={busy}
            title="把文件内部的模型中心归到 X/Z=0，并让脚底落到 Y=0"
            onClick={resetModelPlacement}
          >
            模型居中并落地
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void run(() => beginBaselineRigFit(profile, sourcePose))}
          >
            <Icon name="bone" />
            {busy ? '正在准备骨架预览…' : '开始匹配骨架'}
          </button>
          <div className="hint">
            系统先按模型身高自动摆放 Manny / UEFN 骨架，随后进入可视化适配。此时还不会修改网格或生成蒙皮。
          </div>
          <button
            className="btn"
            disabled={busy || Boolean(rigJob && !['completed', 'failed', 'cancelled', 'blocked'].includes(rigJob.status))}
            onClick={() => void submitBlenderAutoRig(profile, sourcePose)}
          >
            提交 Blender 自动权重精修
          </button>
        </>
      ) : (
        <>
          <div className="hint">
            在视口点击骨骼点，再拖动三轴箭头，使关节点贴合模型。建议依次检查肩、肘、手腕、髋、膝、脚踝；移动父节点会连同下级骨骼一起移动。
          </div>
          <div className="row">
            <span className="hint" style={{ width: 72 }}>当前关节</span>
            <select className="grow" value={selectedBone} onChange={(event) => selectBone(event.target.value)}>
              <option value="">选择关节点…</option>
              {fitBones.map((bone) => <option key={bone} value={bone}>{bone}</option>)}
            </select>
          </div>
          {selectedBone && (
            <Vec3Row
              label="关节点位置"
              x={boneTransform.px} y={boneTransform.py} z={boneTransform.pz}
              step={0.002} digits={3}
              sliderMin={-2} sliderMax={2}
              onChange={(axis, value) => setSelectedBoneTransform({
                [axis === 'x' ? 'px' : axis === 'y' ? 'py' : 'pz']: value,
              })}
            />
          )}
          <div className="row wrap">
            <button className="btn small" disabled={busy} onClick={resetBaselineRigFit}>恢复自动匹配</button>
            <button className="btn small" disabled={busy} onClick={cancelBaselineRigFit}>取消适配</button>
          </div>
          <div className="hint">已手动调整 {adjustedCount} 个关节点；Ctrl+Z / Ctrl+Y 可撤销或恢复单次拖动。</div>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void run(commitBaselineRigFit)}
          >
            <Icon name="bone" />
            {busy ? '正在计算基础蒙皮…' : '按当前骨架生成蒙皮'}
          </button>
        </>
      )}

      {rigJob && (
        <div className="job-progress">
          <span>{rigJob.id}</span>
          <b>{rigJob.status} · {rigJob.progress}%</b>
        </div>
      )}
    </>
  )
}
/* ---------------------------------------------------------------- 挂载 */
function MountPanel() {
  const attachments = useEditor((s) => s.attachments).filter((item) => item.role !== 'head_component')
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
