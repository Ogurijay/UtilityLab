import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { Engine } from '../core/engine'
import { Character, uid, type Attachment, type OwnedClip } from '../core/character'
import { buildRig } from '../core/rig'
import { autoMapBones, buildRetargetNameMap, missingRequiredSlots } from '../core/skeletons/autoMap'
import { bakeRetargetedClip, directBindScore } from '../core/skeletons/retarget'
import { SLOT_LABELS, SOCKET_PRESETS } from '../core/skeletons/standard'
import { transplantToStandard } from '../core/skeletons/transplant'
import { autoSkinToStandard } from '../core/skeletons/autoSkin'
import { BUILTIN_ASSETS, createBuiltinAnim, isBuiltinId } from '../core/builtins'
import { disposeObject, downloadBlob, downloadDataUrl, parseAssetFile } from '../core/loaders'
import { exportGlbBlob } from '../core/exporter'
import { bakeMeshesStatic, piecesToGroup, type BakedPiece } from '../core/mesh/bake'
import { cutByPlane, cutByRegion } from '../core/mesh/cut'
import { renderThumbnail } from '../core/thumbs'
import { getAssetBlob } from '../db/assetDb'
import { DEFAULT_PLAYBACK, toast, useEditor } from '../store/editor'
import { useLibrary } from '../store/library'
import { pushCommand, clearHistory, undoLast as historyUndo, redoLast as historyRedo } from './history'
import type {
  AssetMeta, AttachmentInfo, BodyRegion, BoneSlot, GizmoMode, MaterialInfo, MeshInfo,
  MorphInfo, PartInfo, Selection,
} from '../types'

/**
 * 应用编排层：持有 Engine 与 Character 实例，
 * 把 UI 操作翻译成三维世界的变更，并把结果镜像回 zustand。
 * 所有可逆操作都会向撤销栈（history）登记命令。
 */
let engine: Engine | null = null
let character: Character | null = null
let skeletonHelper: THREE.SkeletonHelper | null = null
let transformControls: TransformControls | null = null
let planePreview: THREE.Mesh | null = null
let lastPushedTime = -1

// ---------------------------------------------------------------- 引擎生命周期

export function initEngine(canvas: HTMLCanvasElement): void {
  if (engine) return
  engine = new Engine(canvas)
  engine.onTick(onTick)

  transformControls = new TransformControls(engine.camera, canvas)
  transformControls.setSize(0.85)
  engine.scene.add(transformControls.getHelper())
  transformControls.addEventListener('dragging-changed', (e) => {
    if (engine) engine.controls.enabled = !(e as unknown as { value: boolean }).value
    if ((e as unknown as { value: boolean }).value) beginGizmoDrag()
    else endGizmoDrag()
  })
  transformControls.addEventListener('objectChange', () => syncFromGizmo())
}

function onTick(dt: number): void {
  if (!character) return
  const pb = useEditor.getState().playback
  const action = character.currentAction

  if (action && pb.playing) {
    character.mixer.update(dt)
    const duration = Math.max(action.getClip().duration, 0.0001)
    const trimIn = Math.min(pb.trimIn, duration)
    const trimOut = pb.trimOut > 0 ? Math.min(pb.trimOut, duration) : duration

    if (action.time > trimOut - 1e-4) {
      if (pb.loop) {
        action.time = trimIn + ((action.time - trimIn) % Math.max(trimOut - trimIn, 0.0001))
      } else {
        action.time = trimOut
        action.paused = true
        useEditor.setState({ playback: { ...useEditor.getState().playback, playing: false, time: trimOut } })
      }
    } else if (action.time < trimIn - 1e-4) {
      action.time = trimIn
    }

    const t = action.time
    if (Math.abs(t - lastPushedTime) > 0.03) {
      lastPushedTime = t
      useEditor.setState({ playback: { ...useEditor.getState().playback, time: t } })
    }
  }
}

// ---------------------------------------------------------------- 选中与操纵器

interface StagedPart {
  info: PartInfo
  object: THREE.Object3D
}

let stagingGroup: THREE.Group | null = null
const stagedParts: StagedPart[] = []

function selectedObject(sel: Selection | null): THREE.Object3D | null {
  if (!sel) return null
  if (sel.kind === 'part') return stagedParts.find((p) => p.info.id === sel.id)?.object ?? null
  if (sel.kind === 'character') return character?.root ?? null
  if (sel.kind === 'attachment') return character?.attachments.find((a) => a.id === sel.id)?.object ?? null
  if (sel.kind === 'plane') return planePreview?.visible ? planePreview : null
  return null
}

const SELECT_COLORS: Record<Selection['kind'], string> = {
  part: '#f5c065',
  character: '#6d9eff',
  attachment: '#67d4a8',
  plane: '#6d9eff',
}

function refreshSelectionVisuals(): void {
  if (!engine || !transformControls) return
  const sel = useEditor.getState().selection
  const obj = selectedObject(sel)
  if (!obj || !sel) {
    engine.setOutline([])
    transformControls.detach()
    if (sel) useEditor.setState({ selection: null })
    return
  }
  // 轮廓描边（蒙皮动画下同样贴合模型轮廓）
  engine.setOutline([obj], SELECT_COLORS[sel.kind])
  transformControls.setMode(useEditor.getState().gizmoMode)
  transformControls.attach(obj)
}

export function select(sel: Selection | null): void {
  useEditor.setState({ selection: sel })
  refreshSelectionVisuals()
}

export function setGizmoMode(mode: GizmoMode): void {
  useEditor.setState({ gizmoMode: mode })
  transformControls?.setMode(mode)
}

export function isGizmoDragging(): boolean {
  return Boolean(transformControls?.dragging)
}

export function setUniformScale(on: boolean): void {
  useEditor.setState({ uniformScale: on })
}

const raycaster = new THREE.Raycaster()

/** 视口点击拾取：部件 / 切割平面 / 挂载物 / 角色 */
export function pickAtCanvas(clientX: number, clientY: number): void {
  if (!engine || transformControls?.dragging) return
  const rect = engine.renderer.domElement.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(ndc, engine.camera)

  const targets: THREE.Object3D[] = []
  for (const p of stagedParts) targets.push(p.object)
  if (planePreview?.visible) targets.push(planePreview)
  if (character) targets.push(character.root)
  // 拾取前刷新矩阵，避免命中尚未渲染的旧位置
  engine.scene.updateMatrixWorld(true)
  // 过滤隐藏对象（Raycaster 不检查 visible，需沿祖先链确认）
  const hits = raycaster.intersectObjects(targets, true).filter((h) => {
    let o: THREE.Object3D | null = h.object
    while (o) {
      if (!o.visible) return false
      o = o.parent
    }
    return true
  })
  if (hits.length === 0) {
    select(null)
    return
  }

  // 沿父链定位命中对象的归属
  let cur: THREE.Object3D | null = hits[0].object
  while (cur) {
    const part = stagedParts.find((p) => p.object === cur)
    if (part) {
      select({ kind: 'part', id: part.info.id })
      return
    }
    if (cur === planePreview) {
      select({ kind: 'plane' })
      return
    }
    const att = character?.attachments.find((a) => a.socket === cur)
    if (att) {
      select({ kind: 'attachment', id: att.id })
      return
    }
    if (character && cur === character.root) {
      select({ kind: 'character' })
      return
    }
    cur = cur.parent
  }
  select(null)
}

export function deleteSelection(): void {
  const sel = useEditor.getState().selection
  if (!sel) return
  if (sel.kind === 'part' && sel.id) removePart(sel.id)
  else if (sel.kind === 'attachment' && sel.id) removeAttachment(sel.id)
  else if (sel.kind === 'plane') setCutPlaneVisible(false)
}

// ---- 操纵器拖拽 ⇄ 状态镜像 / 撤销

type DragSnapshot =
  | { kind: 'part'; id: string; info: PartInfo }
  | { kind: 'character'; pos: number[]; quat: number[]; scale: number[] }
  | { kind: 'attachment'; id: string; info: AttachmentInfo }
  | null

let dragBefore: DragSnapshot = null

function captureSelection(): DragSnapshot {
  const sel = useEditor.getState().selection
  if (!sel) return null
  if (sel.kind === 'part' && sel.id) {
    const p = stagedParts.find((x) => x.info.id === sel.id)
    return p ? { kind: 'part', id: p.info.id, info: { ...p.info } } : null
  }
  if (sel.kind === 'character' && character) {
    return {
      kind: 'character',
      pos: character.root.position.toArray(),
      quat: character.root.quaternion.toArray() as number[],
      scale: character.root.scale.toArray(),
    }
  }
  if (sel.kind === 'attachment' && sel.id && character) {
    const a = character.attachments.find((x) => x.id === sel.id)
    return a ? { kind: 'attachment', id: a.id, info: { ...a.info } } : null
  }
  return null
}

function applySnapshot(snap: DragSnapshot): void {
  if (!snap) return
  if (snap.kind === 'part') {
    applyPartInfo(snap.id, snap.info)
  } else if (snap.kind === 'character' && character) {
    character.root.position.fromArray(snap.pos)
    character.root.quaternion.fromArray(snap.quat)
    character.root.scale.fromArray(snap.scale)
    syncTransformMirror()
  } else if (snap.kind === 'attachment' && character) {
    const a = character.attachments.find((x) => x.id === snap.id)
    if (a) {
      a.info = { ...snap.info }
      character.applyAttachmentOffset(a)
      syncAttachments()
    }
  }
  refreshSelectionVisuals()
}

function beginGizmoDrag(): void {
  dragBefore = captureSelection()
}

function endGizmoDrag(): void {
  const before = dragBefore
  dragBefore = null
  if (!before) return
  lastGizmoSync = 0 // 绕过节流，确保拖拽的最终状态完整回写
  syncFromGizmo()
  const after = captureSelection()
  if (!after || JSON.stringify(before) === JSON.stringify(after)) return
  pushCommand({
    label: '操纵器调整',
    undo: () => applySnapshot(before),
    redo: () => applySnapshot(after),
  })
}

let lastGizmoSync = 0

/** 操纵器拖拽中：把对象变换读回状态镜像 */
function syncFromGizmo(): void {
  const now = performance.now()
  if (now - lastGizmoSync < 50) return
  lastGizmoSync = now
  const sel = useEditor.getState().selection
  if (!sel) return
  if (sel.kind === 'part' && sel.id) {
    const p = stagedParts.find((x) => x.info.id === sel.id)
    if (!p) return
    const o = p.object
    p.info.x = o.position.x
    p.info.y = o.position.y
    p.info.z = o.position.z
    p.info.rx = THREE.MathUtils.radToDeg(o.rotation.x)
    p.info.ry = THREE.MathUtils.radToDeg(o.rotation.y)
    p.info.rz = THREE.MathUtils.radToDeg(o.rotation.z)
    p.info.mirror = o.scale.x < 0
    if (useEditor.getState().uniformScale) {
      // 等比锁：取偏差最大的轴作为整体缩放值，防止把模型拉扁
      const vals = [Math.abs(o.scale.x), o.scale.y, o.scale.z]
      const deltas = [
        Math.abs(vals[0] - p.info.sx),
        Math.abs(vals[1] - p.info.sy),
        Math.abs(vals[2] - p.info.sz),
      ]
      const s = Math.max(0.001, vals[deltas.indexOf(Math.max(...deltas))])
      p.info.sx = s
      p.info.sy = s
      p.info.sz = s
      o.scale.set(p.info.mirror ? -s : s, s, s)
    } else {
      p.info.sx = Math.abs(o.scale.x)
      p.info.sy = o.scale.y
      p.info.sz = o.scale.z
    }
    syncParts()
  } else if (sel.kind === 'character') {
    if (character) {
      // 角色只支持等比缩放（面板也是单一数值）
      const sc = character.root.scale
      const cur = useEditor.getState().transform.scale
      const vals = [sc.x, sc.y, sc.z]
      const deltas = vals.map((v) => Math.abs(v - cur))
      const s = Math.max(0.001, vals[deltas.indexOf(Math.max(...deltas))])
      sc.setScalar(s)
    }
    syncTransformMirror()
  } else if (sel.kind === 'attachment' && sel.id && character) {
    const a = character.attachments.find((x) => x.id === sel.id)
    if (!a) return
    a.info.px = a.object.position.x * 100
    a.info.py = a.object.position.y * 100
    a.info.pz = a.object.position.z * 100
    a.info.rx = THREE.MathUtils.radToDeg(a.object.rotation.x)
    a.info.ry = THREE.MathUtils.radToDeg(a.object.rotation.y)
    a.info.rz = THREE.MathUtils.radToDeg(a.object.rotation.z)
    // 挂载物只支持均匀缩放：取用户实际拖动的轴归一化回写，避免残留非均匀状态
    const s = a.object.scale
    const changed = [s.x, s.y, s.z].find((v) => Math.abs(v - a.info.scale) > 1e-6) ?? s.x
    a.info.scale = changed
    s.setScalar(changed)
    syncAttachments()
  }
}

// ---------------------------------------------------------------- 状态镜像

function collectMeshInfos(): MeshInfo[] {
  if (!character) return []
  const out: MeshInfo[] = []
  character.model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      out.push({ id: o.uuid, name: o.name || '未命名网格', visible: o.visible })
    }
  })
  return out
}

function collectMaterialInfos(): MaterialInfo[] {
  if (!character) return []
  const seen = new Map<string, MaterialInfo>()
  character.model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      if (!m || seen.has(m.uuid)) continue
      const std = m as THREE.MeshStandardMaterial
      seen.set(m.uuid, {
        id: m.uuid,
        name: m.name || `材质 ${seen.size + 1}`,
        color: std.color ? `#${std.color.getHexString()}` : '#ffffff',
        metalness: typeof std.metalness === 'number' ? std.metalness : null,
        roughness: typeof std.roughness === 'number' ? std.roughness : null,
      })
    }
  })
  return Array.from(seen.values())
}

function collectMorphInfos(): MorphInfo[] {
  if (!character) return []
  const out: MorphInfo[] = []
  character.model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return
    for (const [label, idx] of Object.entries(mesh.morphTargetDictionary)) {
      out.push({
        key: `${mesh.uuid}::${idx}`,
        label,
        value: mesh.morphTargetInfluences[idx] ?? 0,
      })
    }
  })
  return out.slice(0, 60)
}

function syncTransformMirror(): void {
  if (!character) return
  useEditor.setState({
    transform: {
      x: character.root.position.x,
      z: character.root.position.z,
      rotY: THREE.MathUtils.radToDeg(character.root.rotation.y),
      scale: character.root.scale.x,
    },
  })
}

function syncAttachments(): void {
  useEditor.setState({
    attachments: character ? character.attachments.map((a) => ({ ...a.info })) : [],
  })
}

function syncParts(): void {
  useEditor.setState({ parts: stagedParts.map((p) => ({ ...p.info })) })
}

function syncCharacter(): void {
  const store = useEditor.getState()
  if (!character) {
    store.set({
      hasCharacter: false, characterName: '', skeletonGuess: '', meshes: [], materials: [],
      morphs: [], bones: [], boneMap: {}, clips: [], attachments: [],
      transform: { x: 0, z: 0, rotY: 0, scale: 1 },
      playback: { ...DEFAULT_PLAYBACK },
    })
    refreshSelectionVisuals()
    return
  }
  store.set({
    hasCharacter: true,
    characterName: character.name,
    skeletonGuess: character.skeletonGuess,
    meshes: collectMeshInfos(),
    materials: collectMaterialInfos(),
    morphs: collectMorphInfos(),
    bones: character.boneNames,
    boneMap: { ...character.boneMap },
    clips: character.clipInfos(),
    attachments: character.attachments.map((a) => ({ ...a.info })),
    transform: {
      x: character.root.position.x,
      z: character.root.position.z,
      rotY: THREE.MathUtils.radToDeg(character.root.rotation.y),
      scale: character.root.scale.x,
    },
  })
  refreshSelectionVisuals()
}

// ---------------------------------------------------------------- 角色装载与替换

/** 把当前角色移出场景但不销毁（撤销栈持有） */
function swapOutCharacter(): Character | null {
  if (!character) return null
  const prev = character
  const sel = useEditor.getState().selection
  if (sel && (sel.kind === 'character' || sel.kind === 'attachment')) select(null)
  removeSkeletonHelper()
  prev.root.removeFromParent()
  character = null
  return prev
}

/** 恢复此前 swapOutCharacter 移出的角色 */
function reinstallCharacter(prev: Character | null): void {
  character = prev
  if (character && engine) {
    engine.scene.add(character.root)
    character.stop()
    if (useEditor.getState().showSkeleton) addSkeletonHelper()
  }
  syncCharacter()
  useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
}

/** 安装新角色并登记可撤销的替换命令 */
function installCharacterWithUndo(
  group: THREE.Object3D,
  name: string,
  opts: { autoFit?: boolean; keepTransform?: boolean },
  label: string,
): void {
  if (!engine) return
  const prevTransform = character
    ? { pos: character.root.position.clone(), rotY: character.root.rotation.y, scale: character.root.scale.x }
    : null
  let parked = swapOutCharacter()

  character = new Character(group, name)
  engine.scene.add(character.root)
  if (opts.keepTransform && prevTransform) {
    character.root.position.copy(prevTransform.pos)
    character.root.rotation.y = prevTransform.rotY
    character.root.scale.setScalar(prevTransform.scale)
  } else if (opts.autoFit) {
    const box = new THREE.Box3().setFromObject(character.root)
    const h = box.getSize(new THREE.Vector3()).y
    if (h > 0 && (h > 3.2 || h < 0.8)) {
      character.root.scale.setScalar(1.75 / h)
      toast('info', `已自动调整模型尺寸（原始高度 ${h.toFixed(2)}）`)
    }
  }
  groundCharacter(false)
  if (useEditor.getState().showSkeleton) addSkeletonHelper()
  syncCharacter()
  useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
  engine.frameObject(character.root)

  pushCommand({
    label,
    undo: () => {
      const cur = swapOutCharacter()
      reinstallCharacter(parked)
      parked = cur
    },
    redo: () => {
      const cur = swapOutCharacter()
      reinstallCharacter(parked)
      parked = cur
    },
    // 新旧角色可能共享材质，这里只释放几何体
    dispose: () => {
      if (parked && parked !== character) parked.dispose(true)
    },
  })
}

export async function useAssetAsCharacter(assetId: string): Promise<void> {
  if (!engine) return
  const lib = useLibrary.getState()
  const meta = lib.assets.find((a) => a.id === assetId)
  if (!meta) return

  try {
    const blob = await getAssetBlob(assetId)
    if (!blob) throw new Error('找不到资源文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)

    installCharacterWithUndo(parsed.object, meta.name, { autoFit: true }, `载入角色 ${meta.name}`)
    if (!character) return
    for (const clip of parsed.clips) character.addClip(clip, '随模型导入')
    syncCharacter()
    if (character.clips.length > 0) playClip(character.clips[0].id)

    if (!character.rig) {
      toast('warn', `「${meta.name}」没有骨骼；可在「骨骼」页自动蒙皮绑上 Manny 骨骼`)
    } else {
      const missing = missingRequiredSlots(character.boneMap)
      if (missing.length > 0) {
        toast('warn', `骨骼自动识别不完整（缺 ${missing.map((s) => SLOT_LABELS[s]).join('、')}），请到「骨骼」页手动映射`)
      } else {
        toast('ok', `已加载「${meta.name}」 · ${character.skeletonGuess}`)
      }
    }
  } catch (e) {
    console.error(e)
    toast('err', `加载失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

// ---------------------------------------------------------------- 动画绑定

/**
 * 直接绑定时按角色髋骨绑定高度缩放位移轨道：
 * 骨骼命名相同但体型 / 单位不同（骨骼覆盖后的角色配内置动画等）也能落对高度。
 */
function adjustClipHipHeight(clip: THREE.AnimationClip, char: Character): THREE.AnimationClip {
  const hipsName = char.boneMap.hips
  if (!hipsName || !char.rig) return clip
  const bone = char.rig.byName.get(hipsName)
  if (!bone) return clip
  const bindY = char.rig.bindLocal.get(bone)!.pos.y
  const idx = clip.tracks.findIndex((t) => {
    const parsed = THREE.PropertyBinding.parseTrackName(t.name)
    return parsed.nodeName === hipsName && parsed.propertyName === 'position'
  })
  if (idx < 0) return clip
  const firstY = clip.tracks[idx].values[1]
  if (!Number.isFinite(firstY) || Math.abs(firstY) < 1e-6) return clip
  const ratio = bindY / firstY
  if (Math.abs(ratio - 1) < 0.02) return clip
  const copy = clip.clone()
  const values = copy.tracks[idx].values
  for (let i = 0; i < values.length; i++) values[i] *= ratio
  return copy
}

export async function bindAnimAsset(assetId: string): Promise<void> {
  if (!character) {
    toast('warn', '先加载一个角色（左侧资源库 → 模型 → 设为当前角色）')
    return
  }
  if (!character.rig) {
    toast('err', '当前模型没有骨骼；先到「骨骼」页用 Manny 骨骼覆盖')
    return
  }
  const char = character
  const lib = useLibrary.getState()
  const meta = [...lib.assets, ...BUILTIN_ASSETS].find((a) => a.id === assetId)
  if (!meta) return

  try {
    let srcRoot: THREE.Object3D
    let clips: THREE.AnimationClip[]
    let srcMapKnown = null as ReturnType<typeof autoMapBones> | null
    let disposable: THREE.Object3D | null = null

    if (isBuiltinId(assetId)) {
      const builtin = createBuiltinAnim(assetId)
      if (!builtin) throw new Error('该内置资源不是动画')
      srcRoot = builtin.srcRoot
      clips = [builtin.clip]
      srcMapKnown = builtin.srcMap
    } else {
      const blob = await getAssetBlob(assetId)
      if (!blob) throw new Error('找不到资源文件内容')
      const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)
      if (parsed.clips.length === 0) throw new Error('文件里没有动画片段')
      srcRoot = parsed.object
      clips = parsed.clips
      disposable = parsed.object
    }

    // 解析期间角色可能已被替换（骨骼覆盖 / 载入新模型），不能写到被搁置的旧角色上
    if (char !== character) {
      if (disposable) disposeObject(disposable)
      toast('warn', '角色已更换，已取消本次动画绑定')
      return
    }

    const charBoneSet = new Set(char.boneNames)
    const added: OwnedClip[] = []
    let retargeted = 0

    for (const clip of clips) {
      const score = directBindScore(clip, charBoneSet)
      if (score >= 0.5) {
        added.push(char.addClip(adjustClipHipHeight(clip, char), '直接绑定'))
        continue
      }

      const srcRig = buildRig(srcRoot)
      if (!srcRig) throw new Error('动画文件里没有骨骼层级，无法重定向')
      const srcMap = srcMapKnown ?? autoMapBones(srcRig.bones)

      const missingChar = missingRequiredSlots(char.boneMap)
      if (missingChar.length > 0) {
        throw new Error(`角色骨骼映射不完整（缺 ${missingChar.map((s) => SLOT_LABELS[s]).join('、')}），请到「骨骼」页补全`)
      }
      const missingSrc = missingRequiredSlots(srcMap)
      if (missingSrc.length > 0) {
        throw new Error(`动画骨架无法自动识别（缺 ${missingSrc.map((s) => SLOT_LABELS[s]).join('、')}）`)
      }

      const nameMap = buildRetargetNameMap(char.boneMap, srcMap)
      const result = bakeRetargetedClip({
        clip,
        srcRig,
        tgtRig: char.rig!,
        nameMap,
        tgtHips: char.boneMap.hips,
        srcHips: srcMap.hips,
        outName: clip.name,
      })
      added.push(char.addClip(result.clip, `重定向（匹配 ${result.mappedCount} 根骨骼）`))
      retargeted++
    }

    if (disposable) disposeObject(disposable)
    syncCharacter()
    if (added.length > 0) {
      playClip(added[0].id)
      pushCommand({
        label: `绑定动画 ${meta.name}`,
        undo: () => {
          for (const owned of added) {
            if (char.currentClipId === owned.id) {
              char.stop()
              useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
            }
            char.removeClip(owned.id)
          }
          if (character === char) syncCharacter()
        },
        redo: () => {
          for (const owned of added) char.clips.push(owned)
          if (character === char) syncCharacter()
        },
      })
    }
    toast('ok', retargeted > 0 ? `已绑定 ${added.length} 条动画（其中 ${retargeted} 条自动重定向）` : `已绑定 ${added.length} 条动画`)
  } catch (e) {
    console.error(e)
    toast('err', `绑定动画失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

// ---------------------------------------------------------------- 播放控制

export function playClip(clipId: string): void {
  if (!character) return
  const pb = useEditor.getState().playback
  const owned = character.play(clipId, { speed: pb.speed, loop: pb.loop, inPlace: pb.inPlace })
  if (!owned) return
  lastPushedTime = -1
  useEditor.setState({
    playback: {
      ...pb, clipId, playing: true, time: 0,
      duration: owned.clip.duration, trimIn: 0, trimOut: 0,
    },
  })
}

export function togglePlay(): void {
  if (!character) return
  const pb = useEditor.getState().playback
  if (!pb.clipId) {
    if (character.clips.length > 0) playClip(character.clips[0].id)
    return
  }
  const action = character.currentAction
  if (action) {
    action.paused = false
    if (!pb.playing && pb.time >= (pb.trimOut > 0 ? pb.trimOut : pb.duration) - 1e-3) {
      action.time = pb.trimIn
    }
  }
  useEditor.setState({ playback: { ...pb, playing: !pb.playing } })
}

export function stopPlayback(): void {
  if (!character) return
  character.stop()
  const pb = useEditor.getState().playback
  useEditor.setState({ playback: { ...pb, playing: false, time: 0, clipId: null } })
}

export function seek(time: number): void {
  if (!character?.currentAction) return
  const pb = useEditor.getState().playback
  const t = Math.min(Math.max(time, 0), pb.duration)
  const action = character.currentAction
  action.paused = false
  action.time = t
  character.mixer.update(0)
  useEditor.setState({ playback: { ...pb, time: t } })
}

export function setSpeed(speed: number): void {
  const pb = useEditor.getState().playback
  if (character?.currentAction) character.currentAction.timeScale = speed
  useEditor.setState({ playback: { ...pb, speed } })
}

export function setLoop(loop: boolean): void {
  const pb = useEditor.getState().playback
  if (character?.currentAction) {
    character.currentAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    character.currentAction.clampWhenFinished = true
  }
  useEditor.setState({ playback: { ...pb, loop } })
}

export function setInPlace(inPlace: boolean): void {
  const pb = useEditor.getState().playback
  useEditor.setState({ playback: { ...pb, inPlace } })
  if (pb.clipId && character) {
    const keepTime = pb.time
    const owned = character.play(pb.clipId, { speed: pb.speed, loop: pb.loop, inPlace })
    if (owned && character.currentAction) {
      character.currentAction.time = Math.min(keepTime, owned.clip.duration)
      character.mixer.update(0)
    }
  }
}

export function setTrim(trimIn: number, trimOut: number): void {
  const pb = useEditor.getState().playback
  useEditor.setState({ playback: { ...pb, trimIn, trimOut } })
}

export function applyTrimAsNewClip(): void {
  if (!character) return
  const char = character
  const pb = useEditor.getState().playback
  if (!pb.clipId) return
  const owned = char.getClip(pb.clipId)
  if (!owned) return
  const fps = 30
  const from = Math.floor(pb.trimIn * fps)
  const to = Math.ceil((pb.trimOut > 0 ? pb.trimOut : pb.duration) * fps)
  if (to - from < 2) {
    toast('warn', '裁剪区间太短')
    return
  }
  const sub = THREE.AnimationUtils.subclip(owned.clip, `${owned.clip.name}·剪辑`, from, to, fps)
  const newOwned = char.addClip(sub, `裁剪自「${owned.clip.name}」`)
  syncCharacter()
  playClip(newOwned.id)
  pushCommand({
    label: '裁剪片段',
    undo: () => {
      if (char.currentClipId === newOwned.id) {
        char.stop()
        useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
      }
      char.removeClip(newOwned.id)
      if (character === char) syncCharacter()
    },
    redo: () => {
      char.clips.push(newOwned)
      if (character === char) syncCharacter()
    },
  })
  toast('ok', `已生成新片段「${sub.name}」（${sub.duration.toFixed(2)} 秒）`)
}

export function removeClip(clipId: string): void {
  if (!character) return
  const char = character
  const owned = char.getClip(clipId)
  if (!owned) return
  const index = char.clips.indexOf(owned)
  if (char.currentClipId === clipId) {
    char.stop()
    useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
  }
  char.removeClip(clipId)
  syncCharacter()
  pushCommand({
    label: `删除动画 ${owned.clip.name}`,
    undo: () => {
      char.clips.splice(Math.min(index, char.clips.length), 0, owned)
      if (character === char) syncCharacter()
    },
    redo: () => {
      if (char.currentClipId === clipId) {
        char.stop()
        useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
      }
      char.removeClip(clipId)
      if (character === char) syncCharacter()
    },
  })
}

// ---------------------------------------------------------------- 变换与外观

/** 记录角色 root 完整变换（撤销用） */
function rootSnapshot(): { pos: number[]; quat: number[]; scale: number[] } | null {
  if (!character) return null
  return {
    pos: character.root.position.toArray(),
    quat: character.root.quaternion.toArray() as number[],
    scale: character.root.scale.toArray(),
  }
}

function applyRootSnapshot(s: { pos: number[]; quat: number[]; scale: number[] } | null): void {
  if (!s || !character) return
  character.root.position.fromArray(s.pos)
  character.root.quaternion.fromArray(s.quat)
  character.root.scale.fromArray(s.scale)
  syncTransformMirror()
  refreshSelectionVisuals()
}

function pushRootCmd(label: string, before: ReturnType<typeof rootSnapshot>, key?: string): void {
  const after = rootSnapshot()
  if (!before || !after) return
  pushCommand({
    label, key,
    undo: () => applyRootSnapshot(before),
    redo: () => applyRootSnapshot(after),
  })
}

export function setCharacterTransform(patch: Partial<{ x: number; z: number; rotY: number; scale: number }>): void {
  if (!character) return
  const before = rootSnapshot()
  const t = useEditor.getState().transform
  const next = { ...t, ...patch }
  character.root.position.x = next.x
  character.root.position.z = next.z
  character.root.rotation.y = THREE.MathUtils.degToRad(next.rotY)
  if (patch.scale !== undefined && patch.scale > 0) character.root.scale.setScalar(patch.scale)
  useEditor.setState({ transform: next })
  refreshSelectionVisuals()
  pushRootCmd('调整角色变换', before, 'char:tf')
}

export function groundCharacter(withUndo = true): void {
  if (!character) return
  const before = withUndo ? rootSnapshot() : null
  const box = new THREE.Box3().setFromObject(character.root)
  if (!box.isEmpty()) character.root.position.y -= box.min.y
  syncTransformMirror()
  if (withUndo) pushRootCmd('落到地面', before)
}

export function normalizeHeight(): void {
  if (!character) return
  const before = rootSnapshot()
  const box = new THREE.Box3().setFromObject(character.root)
  const h = box.getSize(new THREE.Vector3()).y
  if (h > 0.001) {
    character.root.scale.multiplyScalar(1.8 / h)
    groundCharacter(false)
  }
  syncTransformMirror()
  pushRootCmd('身高标准化', before)
  toast('ok', '已把角色高度调整为 1.8 米')
}

export function resetTransform(): void {
  if (!character) return
  const before = rootSnapshot()
  character.root.position.set(0, 0, 0)
  character.root.rotation.set(0, 0, 0)
  character.root.scale.setScalar(1)
  groundCharacter(false)
  syncTransformMirror()
  pushRootCmd('重置变换', before)
}

export function resetPose(): void {
  if (!character) return
  stopPlayback()
  character.resetPose()
}

export function setMeshVisible(meshId: string, visible: boolean): void {
  if (!character) return
  const char = character
  const apply = (v: boolean) => {
    char.model.traverse((o) => {
      if (o.uuid === meshId) o.visible = v
    })
    if (character === char) {
      useEditor.setState({
        meshes: useEditor.getState().meshes.map((m) => (m.id === meshId ? { ...m, visible: v } : m)),
      })
    }
  }
  apply(visible)
  pushCommand({
    label: visible ? '显示部件' : '隐藏部件',
    undo: () => apply(!visible),
    redo: () => apply(visible),
  })
}

export function setMaterialProp(materialId: string, patch: Partial<{ color: string; metalness: number; roughness: number }>): void {
  if (!character) return
  const char = character
  const before = useEditor.getState().materials.find((m) => m.id === materialId)
  const apply = (p: Partial<{ color: string; metalness: number; roughness: number }>) => {
    char.model.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (!m || m.uuid !== materialId) continue
        const std = m as THREE.MeshStandardMaterial
        if (p.color && std.color) std.color.set(p.color)
        if (p.metalness !== undefined && typeof std.metalness === 'number') std.metalness = p.metalness
        if (p.roughness !== undefined && typeof std.roughness === 'number') std.roughness = p.roughness
      }
    })
    if (character === char) {
      useEditor.setState({
        materials: useEditor.getState().materials.map((m) => (m.id === materialId ? { ...m, ...p } : m)),
      })
    }
  }
  apply(patch)
  if (before) {
    const beforePatch = {
      color: before.color,
      metalness: before.metalness ?? undefined,
      roughness: before.roughness ?? undefined,
    }
    // redo 必须是全量终态：key 合并只保留最新 redo，增量 patch 会丢先前属性
    const after = useEditor.getState().materials.find((m) => m.id === materialId)
    const afterPatch = after
      ? { color: after.color, metalness: after.metalness ?? undefined, roughness: after.roughness ?? undefined }
      : patch
    pushCommand({
      label: '调整材质',
      key: `mat:${materialId}`,
      undo: () => apply(beforePatch),
      redo: () => apply(afterPatch),
    })
  }
}

export function setWireframe(on: boolean): void {
  if (character) {
    character.model.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (m && 'wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = on
      }
    })
  }
  useEditor.setState({ wireframe: on })
}

export function setMorph(key: string, value: number): void {
  if (!character) return
  const char = character
  const before = useEditor.getState().morphs.find((m) => m.key === key)?.value ?? 0
  const apply = (v: number) => {
    const [uuid, idxStr] = key.split('::')
    const idx = parseInt(idxStr, 10)
    char.model.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.uuid === uuid && mesh.morphTargetInfluences) mesh.morphTargetInfluences[idx] = v
    })
    if (character === char) {
      useEditor.setState({
        morphs: useEditor.getState().morphs.map((m) => (m.key === key ? { ...m, value: v } : m)),
      })
    }
  }
  apply(value)
  pushCommand({
    label: '调整形态',
    key: `morph:${key}`,
    undo: () => apply(before),
    redo: () => apply(value),
  })
}

// ---------------------------------------------------------------- 骨骼

export function setSlotBone(slot: BoneSlot, boneName: string): void {
  if (!character) return
  const char = character
  const before = char.boneMap[slot] ?? ''
  const apply = (name: string) => {
    if (name) char.boneMap[slot] = name
    else delete char.boneMap[slot]
    if (character === char) useEditor.setState({ boneMap: { ...char.boneMap } })
  }
  apply(boneName)
  pushCommand({
    label: `映射 ${SLOT_LABELS[slot]}`,
    undo: () => apply(before),
    redo: () => apply(boneName),
  })
}

export function reAutoMap(): void {
  if (!character?.rig) return
  const char = character
  const before = { ...char.boneMap }
  char.boneMap = autoMapBones(char.rig!.bones)
  const after = { ...char.boneMap }
  useEditor.setState({ boneMap: after })
  pushCommand({
    label: '自动匹配骨骼',
    undo: () => {
      char.boneMap = { ...before }
      if (character === char) useEditor.setState({ boneMap: { ...before } })
    },
    redo: () => {
      char.boneMap = { ...after }
      if (character === char) useEditor.setState({ boneMap: { ...after } })
    },
  })
  const missing = missingRequiredSlots(char.boneMap)
  if (missing.length > 0) {
    toast('warn', `仍有未识别槽位：${missing.map((s) => SLOT_LABELS[s]).join('、')}`)
  } else {
    toast('ok', '自动匹配完成')
  }
}

export function conformSkeletonToUE(): void {
  if (!character?.rig) {
    toast('err', '当前模型没有骨骼')
    return
  }
  const char = character
  const { renamed, missing } = char.conformToUE()
  removeSkeletonHelper()
  if (useEditor.getState().showSkeleton) addSkeletonHelper()
  syncCharacter()
  useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
  if (renamed.length === 0) {
    toast('info', '骨骼命名已符合 UEFN / Manny 标准，无需修改')
    return
  }
  const forward = new Map(renamed)
  const backward = new Map(renamed.map(([a, b]) => [b, a] as [string, string]))
  const applyRename = (map: Map<string, string>) => {
    char.renameBones(map)
    if (character === char) {
      syncCharacter()
      useEditor.setState({ playback: { ...DEFAULT_PLAYBACK } })
    }
  }
  pushCommand({
    label: '重命名为标准骨骼名',
    undo: () => applyRename(backward),
    redo: () => applyRename(forward),
  })
  toast('ok', `已把 ${renamed.length} 根骨骼重命名为 UEFN / Manny 标准名${missing.length > 0 ? `；${missing.length} 个槽位未映射保持原名` : ''}`)
}

/**
 * 用 Manny / UEFN 标准骨架覆盖当前角色：
 * 有蒙皮 → 骨骼移植（保留原蒙皮质量）；无骨骼 / 拼装结果 → 自动蒙皮。
 */
export function overrideSkeletonWithManny(): void {
  if (!character) {
    toast('warn', '先加载一个角色')
    return
  }
  try {
    stopPlayback()
    let hasSkin = false
    character.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && (o as THREE.SkinnedMesh).geometry?.attributes.skinIndex) hasSkin = true
    })

    const result = hasSkin && character.rig
      ? transplantToStandard(character)
      : autoSkinToStandard(character.model, character.root, character.name)

    const mode = hasSkin && character.rig ? '骨骼移植' : '自动蒙皮'
    const name = character.name.replace(/·Manny骨骼$/, '')
    installCharacterWithUndo(result.group, `${name}·Manny骨骼`, { autoFit: false, keepTransform: true }, '骨骼覆盖')
    toast('ok', `已通过「${mode}」用 Manny / UEFN 标准骨骼覆盖角色`)
    for (const w of result.warnings) toast('info', w)
  } catch (e) {
    console.error(e)
    toast('err', `骨骼覆盖失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

// ---------------------------------------------------------------- 挂载

export async function mountAsset(assetId: string, target: { presetId?: string; boneName?: string }): Promise<void> {
  if (!character?.rig) {
    toast('warn', '先加载一个带骨骼的角色，才能挂载')
    return
  }
  const char = character
  const meta = useLibrary.getState().assets.find((a) => a.id === assetId)
  if (!meta) return

  try {
    const blob = await getAssetBlob(assetId)
    if (!blob) throw new Error('找不到资源文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)
    const object = parsed.object

    // 解析期间角色可能已被替换，不能挂到被搁置的旧角色上
    if (char !== character) {
      disposeObject(object)
      toast('warn', `角色已更换，已取消挂载「${meta.name}」`)
      return
    }

    const preset = SOCKET_PRESETS.find((p) => p.id === target.presetId)
    let bone: THREE.Bone | undefined
    if (preset) {
      bone = char.slotBone(preset.slot)
      if (!bone) {
        disposeObject(object)
        toast('warn', `「${preset.label}」对应的骨骼未映射，请到「骨骼」页设置 ${SLOT_LABELS[preset.slot]}`)
        return
      }
    } else if (target.boneName) {
      bone = char.rig!.byName.get(target.boneName)
    }
    if (!bone) {
      disposeObject(object)
      toast('err', '找不到目标骨骼')
      return
    }

    const box = new THREE.Box3().setFromObject(object)
    const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray())
    let initScale = 1
    if (maxDim > 3 || (maxDim > 0 && maxDim < 0.02)) initScale = 1 / maxDim
    object.traverse((o) => {
      o.castShadow = true
    })

    const att = char.attach(object, bone, meta.name, {
      px: preset?.pos[0] ?? 0,
      py: preset?.pos[1] ?? 0,
      pz: preset?.pos[2] ?? 0,
      rx: preset?.rot[0] ?? 0,
      ry: preset?.rot[1] ?? 0,
      rz: preset?.rot[2] ?? 0,
      scale: initScale,
    })
    syncAttachments()
    select({ kind: 'attachment', id: att.id })
    pushCommand({
      label: `挂载 ${meta.name}`,
      undo: () => {
        char.detach(att.id, false)
        if (character === char) {
          syncAttachments()
          refreshSelectionVisuals()
        }
      },
      redo: () => {
        char.reattach(att)
        if (character === char) syncAttachments()
      },
      dispose: () => {
        if (!char.attachments.includes(att)) disposeObject(att.object)
      },
    })
    toast('ok', `已把「${meta.name}」挂到 ${preset ? preset.label : bone.name}；视口里点击它即可用操纵器微调`)
  } catch (e) {
    console.error(e)
    toast('err', `挂载失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

export function updateAttachment(id: string, patch: Partial<AttachmentInfo>): void {
  if (!character) return
  const char = character
  const att = char.attachments.find((a) => a.id === id)
  if (!att) return
  const before = { ...att.info }
  const apply = (info: AttachmentInfo) => {
    const cur = char.attachments.find((a) => a.id === id)
    if (!cur) return
    if (info.bone !== cur.info.bone && char.rig) {
      const bone = char.rig.byName.get(info.bone)
      if (bone) char.moveAttachment(cur, bone)
    }
    cur.info = { ...info, bone: cur.info.bone }
    char.applyAttachmentOffset(cur)
    if (character === char) {
      syncAttachments()
      refreshSelectionVisuals()
    }
  }
  const next = { ...att.info, ...patch }
  apply(next)
  pushCommand({
    label: '调整挂载',
    key: `att:${id}`,
    undo: () => apply(before),
    redo: () => apply(next),
  })
}

export function removeAttachment(id: string): void {
  if (!character) return
  const char = character
  const sel = useEditor.getState().selection
  if (sel?.kind === 'attachment' && sel.id === id) select(null)
  const att = char.detach(id, false)
  if (!att) return
  syncAttachments()
  pushCommand({
    label: `移除挂载 ${att.name}`,
    undo: () => {
      char.reattach(att)
      if (character === char) syncAttachments()
    },
    redo: () => {
      char.detach(id, false)
      if (character === char) {
        syncAttachments()
        refreshSelectionVisuals()
      }
    },
    dispose: () => {
      if (!char.attachments.includes(att)) disposeObject(att.object)
    },
  })
}

// ---------------------------------------------------------------- 视图

function addSkeletonHelper(): void {
  if (!engine || !character?.rig || skeletonHelper) return
  skeletonHelper = new THREE.SkeletonHelper(character.model)
  engine.scene.add(skeletonHelper)
}

function removeSkeletonHelper(): void {
  if (skeletonHelper) {
    skeletonHelper.removeFromParent()
    skeletonHelper.dispose()
    skeletonHelper = null
  }
}

export function toggleSkeleton(): void {
  const next = !useEditor.getState().showSkeleton
  useEditor.setState({ showSkeleton: next })
  if (next) addSkeletonHelper()
  else removeSkeletonHelper()
}

export function toggleGrid(): void {
  const next = !useEditor.getState().showGrid
  useEditor.setState({ showGrid: next })
  engine?.setGridVisible(next)
}

export function frameCharacter(): void {
  if (!engine) return
  const sel = useEditor.getState().selection
  const obj = selectedObject(sel) ?? character?.root
  if (obj) engine.frameObject(obj)
}

export function takeScreenshot(): void {
  if (!engine) return
  const url = engine.screenshot()
  downloadDataUrl(url, `characterlab_${Date.now()}.png`)
  toast('ok', '截图已保存')
}

// ---------------------------------------------------------------- 切割

let cutBusy = false

/** 把几何块打包成 GLB 存入资源库；返回撤销所需的完整信息 */
async function savePiecesAsAsset(
  pieces: BakedPiece[],
  name: string,
): Promise<{ meta: AssetMeta; blob: Blob } | null> {
  const group = piecesToGroup(pieces, name)
  if (!group) return null
  try {
    const blob = await exportGlbBlob(group)
    const thumb = renderThumbnail(group)
    const id = await useLibrary.getState().addGeneratedAsset(blob, name, 'prop', { thumb })
    const meta = useLibrary.getState().assets.find((a) => a.id === id)
    return meta ? { meta, blob } : null
  } finally {
    disposeObject(group, { keepMaterials: true })
  }
}

/** 切割结果直接以部件形式进入拼装台（几何体独立，材质仍属角色，只读引用） */
function stagePiecesDirect(pieces: BakedPiece[], name: string): StagedPart | null {
  const group = piecesToGroup(
    pieces.map((p) => ({ geometry: p.geometry.clone(), material: p.material })),
    name,
  )
  if (!group) return null
  // 把枢轴移到部件几何中心：操纵器落在部件上，旋转缩放围绕自身
  const mesh = group.children[0] as THREE.Mesh
  mesh.geometry.computeBoundingBox()
  const center = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3())
  mesh.geometry.translate(-center.x, -center.y, -center.z)
  const entry: StagedPart = {
    info: {
      id: uid('part'), name,
      x: +center.x.toFixed(3), y: +center.y.toFixed(3), z: +center.z.toFixed(3),
      rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, mirror: false,
    },
    object: group,
  }
  attachPartEntry(entry)
  return entry
}

interface CutRecord {
  assets: { meta: AssetMeta; blob: Blob }[]
  parts: StagedPart[]
}

function pushCutCommand(label: string, record: CutRecord): void {
  pushCommand({
    label,
    undo: () => {
      for (const p of record.parts) detachPartEntry(p)
      for (const a of record.assets) useLibrary.getState().removeAsset(a.meta.id, true)
    },
    redo: () => {
      for (const a of record.assets) useLibrary.getState().restoreAsset(a.meta, a.blob)
      for (const p of record.parts) attachPartEntry(p)
    },
    dispose: () => {
      for (const p of record.parts) {
        if (!stagedParts.includes(p)) disposeObject(p.object, { keepMaterials: true })
      }
    },
  })
}

async function runCut(
  label: string,
  toStage: boolean,
  splitter: () => { name: string; pieces: BakedPiece[] }[],
): Promise<void> {
  if (!character || !engine || cutBusy) return
  cutBusy = true
  try {
    stopPlayback()
    const outputs = splitter().filter((o) => o.pieces.length > 0)
    if (outputs.length === 0) {
      toast('warn', '没有切到任何网格，请调整切割参数')
      return
    }
    const record: CutRecord = { assets: [], parts: [] }
    for (const out of outputs) {
      const saved = await savePiecesAsAsset(out.pieces, out.name)
      if (saved) record.assets.push(saved)
      if (toStage) {
        const staged = stagePiecesDirect(out.pieces, out.name)
        if (staged) record.parts.push(staged)
      }
    }
    if (record.parts.length > 0) {
      select({ kind: 'part', id: record.parts[0].info.id })
      useEditor.setState({ tab: 'parts' })
    }
    pushCutCommand(`切割 ${label}`, record)
    toast('ok', `切割完成：${record.assets.map((a) => `「${a.meta.name}」`).join(' ')}已入库${toStage ? '，并加入拼装台' : ''}`)
  } catch (e) {
    console.error(e)
    toast('err', `切割失败：${e instanceof Error ? e.message : '未知错误'}`)
  } finally {
    cutBusy = false
  }
}

/** 按身体部位组合切割（正反两件） */
export async function cutCharacterByRegions(regions: BodyRegion[], label: string, toStage: boolean): Promise<void> {
  if (!character?.rig) {
    toast('warn', '按部位切割需要带骨骼的模型；静态模型请用平面切割')
    return
  }
  const char = character
  const scene = engine!.scene
  await runCut(label, toStage, () => {
    const { inside, outside } = cutByRegion(char.model, scene, char.rig!, char.boneMap, new Set(regions))
    return [
      { name: `${char.name}·${label}`, pieces: inside },
      { name: `${char.name}·除${label}`, pieces: outside },
    ]
  })
}

/** 沿切割平面（可移动旋转）切开；keep 控制保留哪一侧 */
export async function cutCharacterByPlane(keep: 'both' | 'front' | 'back', toStage: boolean): Promise<void> {
  if (!character || !engine) return
  if (!planePreview?.visible) {
    toast('warn', '先打开「切割平面」，用操纵器摆好位置和角度')
    return
  }
  const char = character
  const scene = engine.scene
  const point = planePreview.getWorldPosition(new THREE.Vector3())
  const normal = planePreview.getWorldDirection(new THREE.Vector3())
  await runCut('平面', toStage, () => {
    const pieces = bakeMeshesStatic(char.model, scene)
    const { inside, outside } = cutByPlane(pieces, point, normal)
    for (const p of pieces) p.geometry.dispose()
    const outs: { name: string; pieces: BakedPiece[] }[] = []
    if (keep !== 'back') outs.push({ name: `${char.name}·切件A`, pieces: inside })
    else for (const p of inside) p.geometry.dispose()
    if (keep !== 'front') outs.push({ name: `${char.name}·切件B`, pieces: outside })
    else for (const p of outside) p.geometry.dispose()
    if (inside.length === 0 || outside.length === 0) {
      for (const o of outs) for (const p of o.pieces) p.geometry.dispose()
      return []
    }
    return outs
  })
}

export async function splitCharacterSubmeshes(toStage: boolean): Promise<void> {
  if (!character || !engine) return
  const char = character
  const scene = engine.scene
  const meshes: THREE.Mesh[] = []
  char.model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o as THREE.Mesh)
  })
  if (meshes.length < 2) {
    toast('info', '模型只有一个网格，无需拆分（可用部位 / 平面切割）')
    return
  }
  await runCut('子网格', toStage, () =>
    meshes.map((mesh, i) => ({
      name: `${char.name}·${mesh.name || `网格${i + 1}`}`,
      pieces: bakeMeshesStatic(mesh, scene),
    })),
  )
}

// ---- 切割平面（用操纵器摆放）

export function setCutPlaneVisible(visible: boolean): void {
  if (!engine) return
  useEditor.setState({ cutPlaneOn: visible })
  if (!visible) {
    const sel = useEditor.getState().selection
    if (sel?.kind === 'plane') select(null)
    if (planePreview) planePreview.visible = false
    return
  }
  if (!planePreview) {
    planePreview = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({
        color: '#6d9eff', transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    planePreview.name = 'CutPlane'
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(planePreview.geometry),
      new THREE.LineBasicMaterial({ color: '#6d9eff', transparent: true, opacity: 0.7 }),
    )
    // 线段的默认拾取阈值是 1 世界单位，会大范围抢占点击；边框仅作装饰
    edge.raycast = () => {}
    planePreview.add(edge)
    engine.scene.add(planePreview)
    setCutPlanePreset('y')
  }
  planePreview.visible = true
  select({ kind: 'plane' })
}

/** 快速把切割平面摆成水平 / 竖直姿态（之后可用操纵器自由调整） */
export function setCutPlanePreset(axis: 'x' | 'y' | 'z'): void {
  if (!planePreview) return
  useEditor.setState({ cutPlaneOn: true })
  const center = new THREE.Vector3(0, 1, 0)
  if (character) {
    const box = new THREE.Box3().setFromObject(character.root)
    if (!box.isEmpty()) box.getCenter(center)
  }
  planePreview.position.copy(center)
  planePreview.rotation.set(0, 0, 0)
  if (axis === 'x') planePreview.rotation.y = Math.PI / 2
  else if (axis === 'y') planePreview.rotation.x = -Math.PI / 2
  planePreview.visible = true
  select({ kind: 'plane' })
}

// ---------------------------------------------------------------- 拼装台

function ensureStaging(): THREE.Group {
  if (!stagingGroup) {
    stagingGroup = new THREE.Group()
    stagingGroup.name = 'AssemblyStage'
    engine?.scene.add(stagingGroup)
  }
  return stagingGroup
}

function applyPartTransform(p: StagedPart): void {
  p.object.position.set(p.info.x, p.info.y, p.info.z)
  p.object.rotation.set(
    THREE.MathUtils.degToRad(p.info.rx),
    THREE.MathUtils.degToRad(p.info.ry),
    THREE.MathUtils.degToRad(p.info.rz),
  )
  const sx = Math.max(Math.abs(p.info.sx), 0.001)
  p.object.scale.set(p.info.mirror ? -sx : sx, Math.max(p.info.sy, 0.001), Math.max(p.info.sz, 0.001))
}

function applyPartInfo(id: string, info: PartInfo): void {
  const p = stagedParts.find((x) => x.info.id === id)
  if (!p) return
  p.info = { ...info }
  applyPartTransform(p)
  syncParts()
  refreshSelectionVisuals()
}

function attachPartEntry(entry: StagedPart): void {
  if (stagedParts.includes(entry)) return
  ensureStaging().add(entry.object)
  applyPartTransform(entry)
  stagedParts.push(entry)
  syncParts()
}

function detachPartEntry(entry: StagedPart): void {
  const i = stagedParts.indexOf(entry)
  if (i < 0) return
  const sel = useEditor.getState().selection
  if (sel?.kind === 'part' && sel.id === entry.info.id) select(null)
  entry.object.removeFromParent()
  stagedParts.splice(i, 1)
  syncParts()
}

/** 从资源库把模型 / 部件加入拼装台 */
export async function addPartFromAsset(assetId: string): Promise<void> {
  if (!engine) return
  const meta = useLibrary.getState().assets.find((a) => a.id === assetId)
  if (!meta) {
    toast('err', '该资源已不存在（可能已被删除）')
    return
  }
  try {
    const blob = await getAssetBlob(assetId)
    if (!blob) throw new Error('找不到资源文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)

    // 静态化（去蒙皮 / 层级），几何体归部件所有
    const pieces = bakeMeshesStatic(parsed.object, parsed.object)
    disposeObject(parsed.object, { keepMaterials: true })
    const group = piecesToGroup(pieces, meta.name)
    if (!group) throw new Error('该资源没有网格')

    // 尺寸异常自动归一化 + 原点移到包围盒底部中心，便于摆放
    const mesh = group.children[0] as THREE.Mesh
    const box = new THREE.Box3().setFromObject(group)
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 3.2 || (maxDim > 0 && maxDim < 0.02)) {
      mesh.geometry.scale(1.6 / maxDim, 1.6 / maxDim, 1.6 / maxDim)
      box.setFromObject(group)
    }
    const center = box.getCenter(new THREE.Vector3())
    mesh.geometry.translate(-center.x, -box.min.y, -center.z)

    const spawnX = stagedParts.length === 0
      ? 0
      : Math.ceil(stagedParts.length / 2) * 0.7 * (stagedParts.length % 2 === 1 ? 1 : -1)
    const entry: StagedPart = {
      info: {
        id: uid('part'), name: meta.name,
        x: +spawnX.toFixed(2), y: 0, z: 0.9,
        rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, mirror: false,
      },
      object: group,
    }
    attachPartEntry(entry)
    select({ kind: 'part', id: entry.info.id })
    useEditor.setState({ tab: 'parts' })
    pushCommand({
      label: `加入部件 ${meta.name}`,
      undo: () => detachPartEntry(entry),
      redo: () => attachPartEntry(entry),
      // 合并成角色后新角色会共享部件材质，统一保留材质（约定 2）
      dispose: () => {
        if (!stagedParts.includes(entry)) disposeObject(entry.object, { keepMaterials: true })
      },
    })
    toast('ok', `「${meta.name}」已加入拼装台，直接拖操纵器摆放`)
  } catch (e) {
    console.error(e)
    toast('err', `加入拼装台失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

export function updatePart(id: string, patch: Partial<PartInfo>): void {
  const part = stagedParts.find((p) => p.info.id === id)
  if (!part) return
  const before = { ...part.info }
  Object.assign(part.info, patch)
  applyPartTransform(part)
  syncParts()
  refreshSelectionVisuals()
  const after = { ...part.info }
  pushCommand({
    label: `调整部件 ${part.info.name}`,
    key: `part:${id}`,
    undo: () => applyPartInfo(id, before),
    redo: () => applyPartInfo(id, after),
  })
}

export function selectPart(id: string): void {
  select({ kind: 'part', id })
}

export function removePart(id: string): void {
  const entry = stagedParts.find((p) => p.info.id === id)
  if (!entry) return
  detachPartEntry(entry)
  pushCommand({
    label: `移除部件 ${entry.info.name}`,
    undo: () => attachPartEntry(entry),
    redo: () => detachPartEntry(entry),
    // 切割部件的材质引用自活动角色，只放几何（约定 2）
    dispose: () => {
      if (!stagedParts.includes(entry)) disposeObject(entry.object, { keepMaterials: true })
    },
  })
}

export function clearParts(): void {
  if (stagedParts.length === 0) return
  const entries = [...stagedParts]
  for (const e of entries) detachPartEntry(e)
  pushCommand({
    label: '清空拼装台',
    undo: () => {
      for (const e of entries) attachPartEntry(e)
    },
    redo: () => {
      for (const e of entries) detachPartEntry(e)
    },
    dispose: () => {
      for (const e of entries) {
        if (!stagedParts.includes(e)) disposeObject(e.object, { keepMaterials: true })
      }
    },
  })
}

/** 合并拼装台的所有部件 */
export async function mergeParts(mode: 'character' | 'library'): Promise<void> {
  if (!engine || stagedParts.length === 0) {
    toast('warn', '拼装台是空的，先从资源库「加入拼装台」或切割出部件')
    return
  }
  try {
    const stage = ensureStaging()
    const pieces = bakeMeshesStatic(stage, stage)
    const name = `拼装模型_${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replaceAll(':', '')}`
    const group = piecesToGroup(pieces, name)
    if (!group) throw new Error('部件里没有网格')

    const blob = await exportGlbBlob(group)
    const thumb = renderThumbnail(group)
    const assetId = await useLibrary.getState().addGeneratedAsset(blob, name, 'model', { thumb })
    const meta = useLibrary.getState().assets.find((a) => a.id === assetId)

    if (mode === 'character') {
      const entries = [...stagedParts]
      for (const e of entries) detachPartEntry(e)
      installCharacterWithUndo(group, name, { autoFit: true }, '合并部件为角色')
      // 合并命令包含：清空拼装台（附加到刚才的替换命令之后单独可撤销）
      pushCommand({
        label: '清空拼装台（合并后）',
        undo: () => {
          for (const e of entries) attachPartEntry(e)
        },
        redo: () => {
          for (const e of entries) detachPartEntry(e)
        },
        dispose: () => {
          for (const e of entries) {
            if (!stagedParts.includes(e)) disposeObject(e.object, { keepMaterials: true })
          }
        },
      })
      toast('ok', `已合并为「${name}」并设为当前角色；到「骨骼」页盖上 Manny 骨骼即可动起来`)
    } else {
      disposeObject(group, { keepMaterials: true })
      if (meta) {
        pushCommand({
          label: '合并保存到库',
          undo: () => useLibrary.getState().removeAsset(assetId, true),
          redo: () => useLibrary.getState().restoreAsset(meta, blob),
        })
      }
      toast('ok', `已合并保存到资源库：「${name}」（拼装台保留，可继续调整）`)
    }
  } catch (e) {
    console.error(e)
    toast('err', `合并失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

// ---------------------------------------------------------------- 资源库（带撤销的删除）

export async function deleteAssetWithUndo(assetId: string): Promise<void> {
  const lib = useLibrary.getState()
  const meta = lib.assets.find((a) => a.id === assetId)
  if (!meta || meta.builtin) return
  const blob = await getAssetBlob(assetId)
  await lib.removeAsset(assetId, true)
  toast('info', `已删除「${meta.name}」（可撤销）`)
  if (!blob) return
  pushCommand({
    label: `删除资源 ${meta.name}`,
    undo: () => useLibrary.getState().restoreAsset(meta, blob),
    redo: () => useLibrary.getState().removeAsset(assetId, true),
  })
}

// ---------------------------------------------------------------- 导出与入库

export async function exportCharacterGlb(opts: {
  fileName: string
  clipIds: string[]
  includeAttachments: boolean
}): Promise<void> {
  if (!character) {
    toast('warn', '没有可导出的角色')
    return
  }
  const char = character
  const pb = useEditor.getState().playback

  const hiddenSockets: THREE.Object3D[] = []
  if (!opts.includeAttachments) {
    for (const att of char.attachments) {
      if (att.socket.visible) {
        att.socket.visible = false
        hiddenSockets.push(att.socket)
      }
    }
  }
  const wasClip = pb.clipId
  const wasTime = pb.time
  const wasPlaying = pb.playing
  char.mixer.stopAllAction()
  char.resetPose()

  const clips = opts.clipIds
    .map((id) => char.getClip(id)?.clip)
    .filter((c): c is THREE.AnimationClip => Boolean(c))

  try {
    const blob = await exportGlbBlob(char.root, { clips })
    downloadBlob(blob, `${opts.fileName || char.name}.glb`)
    toast('ok', `已导出 GLB（${clips.length} 条动画${opts.includeAttachments ? '，含挂载物' : ''}）`)
  } catch (e) {
    console.error(e)
    toast('err', `导出失败：${e instanceof Error ? e.message : '未知错误'}`)
  } finally {
    for (const s of hiddenSockets) s.visible = true
    if (wasClip && char.getClip(wasClip)) {
      const cur = useEditor.getState().playback
      char.play(wasClip, { speed: cur.speed, loop: cur.loop, inPlace: cur.inPlace })
      if (char.currentAction) {
        char.currentAction.time = wasTime
        char.mixer.update(0)
      }
      useEditor.setState({ playback: { ...cur, clipId: wasClip, time: wasTime, playing: wasPlaying } })
    }
  }
}

export async function saveCharacterToLibrary(): Promise<void> {
  if (!character || !engine) {
    toast('warn', '没有可保存的角色')
    return
  }
  const char = character
  const pb = useEditor.getState().playback
  const wasClip = pb.clipId
  const wasTime = pb.time
  const wasPlaying = pb.playing
  char.mixer.stopAllAction()
  char.resetPose()
  try {
    const clips = char.clips.map((c) => c.clip)
    const blob = await exportGlbBlob(char.root, { clips })
    const thumb = renderThumbnail(char.root)
    engine.scene.add(char.root) // 缩略图渲染会临时改挂父级，取回
    await useLibrary.getState().addGeneratedAsset(blob, char.name, 'model', {
      thumb,
      bones: char.boneNames,
      clipNames: clips.map((c) => c.name),
    })
    toast('ok', `「${char.name}」已保存到资源库（含 ${clips.length} 条动画）`)
  } catch (e) {
    console.error(e)
    toast('err', `保存失败：${e instanceof Error ? e.message : '未知错误'}`)
  } finally {
    if (wasClip && char.getClip(wasClip)) {
      const cur = useEditor.getState().playback
      char.play(wasClip, { speed: cur.speed, loop: cur.loop, inPlace: cur.inPlace })
      if (char.currentAction) {
        char.currentAction.time = wasTime
        char.mixer.update(0)
      }
      useEditor.setState({ playback: { ...cur, clipId: wasClip, time: wasTime, playing: wasPlaying } })
    }
  }
}

/** 当前角色的骨骼名列表（挂载面板的自定义骨骼选择用） */
export function characterBoneNames(): string[] {
  return character?.boneNames ?? []
}

export { undoLast, redoLast } from './history'

/** 调试 / 自检入口（浏览器控制台用），界面代码不依赖 */
export function debugHandles(): { engine: Engine | null; character: Character | null } {
  return { engine, character }
}

/** 调试：直接安装一个对象树为角色（自动化测试用） */
function debugInstall(group: THREE.Object3D, name: string): void {
  installCharacterWithUndo(group, name, { autoFit: true }, '调试载入')
}

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__characterlab = {
    debugHandles,
    debugInstall,
    useAssetAsCharacter,
    bindAnimAsset,
    mountAsset,
    conformSkeletonToUE,
    playClip,
    cutCharacterByRegions,
    cutCharacterByPlane,
    setCutPlaneVisible,
    setCutPlanePreset,
    splitCharacterSubmeshes,
    addPartFromAsset,
    updatePart,
    removePart,
    mergeParts,
    overrideSkeletonWithManny,
    saveCharacterToLibrary,
    pickAtCanvas,
    select,
    setGizmoMode,
    deleteSelection,
    clearHistory,
    undoLast: historyUndo,
    redoLast: historyRedo,
    useEditor,
    useLibrary,
    setUniformScale,
    debugSyncGizmo: () => {
      lastGizmoSync = 0
      syncFromGizmo()
    },
  }
}

// 供类型引用（避免未使用告警）
export type { Attachment }
