import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { Engine } from '../core/engine'
import { Character, uid, type Attachment, type OwnedClip } from '../core/character'
import { AnimationEditLayer } from '../core/animation/editLayer'
import { buildRig, type BonePose, type Rig } from '../core/rig'
import { autoMapBones, buildRetargetNameMap, missingRequiredSlots } from '../core/skeletons/autoMap'
import { bakeRetargetedClip, directBindScore } from '../core/skeletons/retarget'
import { SLOT_LABELS, SOCKET_PRESETS } from '../core/skeletons/standard'
import { transplantToStandard } from '../core/skeletons/transplant'
import { autoSkinToStandard } from '../core/skeletons/autoSkin'
import { autoRigToBaseline, prepareBaselineRig } from '../core/skeletons/baselineAutoRig'
import { disposeObject, downloadBlob, downloadDataUrl, parseAssetFile } from '../core/loaders'
import { exportGlbBlob } from '../core/exporter'
import { bakeMeshesStatic, mergePieces, piecesToGroup, type BakedPiece } from '../core/mesh/bake'
import { centerObjectOnGround, computeVisibleMeshBoundsInParent } from '../core/modelPlacement'
import { cutByPlane, cutByRegion } from '../core/mesh/cut'
import { splitPiecesByConnectedComponents } from '../core/mesh/decompose'
import { applyReferencePose as applyVerifiedReferencePose } from '../core/poses/reference'
import { renderThumbnail } from '../core/thumbs'
import { getAssetBlob } from '../db/assetDb'
import {
  fetchSystemAsset,
  fetchHubJob,
  loadCharacterWorkspace as loadWorkspaceFromHub,
  loadReferencePoseProfiles,
  saveCharacterWorkspace as saveWorkspaceToHub,
  submitAutoRigJob,
} from '../services/animotionHub'
import { DEFAULT_PLAYBACK, toast, useEditor } from '../store/editor'
import { useLibrary } from '../store/library'
import { pushCommand, clearHistory, discardCommandsByKeyPrefix, undoLast as historyUndo, redoLast as historyRedo } from './history'
import type {
  AssetMeta, AttachmentInfo, BodyRegion, BoneSlot, GizmoMode, MaterialInfo, MeshInfo,
  MaterialTextureSlot, MorphInfo, ObjectNodeInfo, ObjectTool, PartInfo, PrimitiveKind,
  ReferencePoseName, SculptBrush, Selection, TransformInfo,
} from '../types'

/**
 * 应用编排层：持有 Engine 与 Character 实例，
 * 把 UI 操作翻译成三维世界的变更，并把结果镜像回 zustand。
 * 所有可逆操作都会向撤销栈（history）登记命令。
 */
let engine: Engine | null = null
let character: Character | null = null
/** 进入单物体编辑页时暂存人物工作区，返回后无损恢复 */
let parkedCharacterWorkspace: Character | null = null
interface BoneOverlay {
  group: THREE.Group
  lines: THREE.LineSegments
  points: THREE.Points
  bones: THREE.Bone[]
  lineBones: [THREE.Bone, THREE.Bone][]
}

let skeletonHelper: BoneOverlay | null = null
let transformControls: TransformControls | null = null

interface RigFitSession {
  profileId: 'ue5-mannequin-simple' | 'uefn-mannequin'
  sourcePose: 't' | 'a'
  container: THREE.Group
  rigRoot: THREE.Object3D
  rig: Rig
  initialLocal: Map<THREE.Bone, BonePose>
  adjustedBones: Set<string>
}

let rigFitSession: RigFitSession | null = null

function activeRig(): Rig | null {
  return rigFitSession?.rig ?? character?.rig ?? null
}

function syncRigFitContainer(): void {
  if (!rigFitSession || !character) return
  rigFitSession.container.position.copy(character.root.position)
  rigFitSession.container.quaternion.copy(character.root.quaternion)
  rigFitSession.container.scale.copy(character.root.scale)
  rigFitSession.container.updateWorldMatrix(true, true)
}

function rigFitBoneNames(rig: Rig): string[] {
  const preferred = /^(root|pelvis|spine_0[1-5]|neck_0?1|head|clavicle_[lr]|upperarm_[lr]|lowerarm_[lr]|hand_[lr]|thigh_[lr]|calf_[lr]|foot_[lr]|ball_[lr])$/i
  const names = rig.bones.filter((bone) => preferred.test(bone.name)).map((bone) => bone.name)
  return names.length ? names : rig.bones.map((bone) => bone.name)
}

function markRigFitBoneAdjusted(name: string): void {
  if (!rigFitSession) return
  const bone = rigFitSession.rig.byName.get(name)
  const initial = bone ? rigFitSession.initialLocal.get(bone) : null
  if (!bone || !initial) return
  const changed = bone.position.distanceToSquared(initial.pos) > 1e-10
    || 1 - Math.abs(bone.quaternion.dot(initial.quat)) > 1e-8
    || bone.scale.distanceToSquared(initial.scale) > 1e-10
  if (changed) rigFitSession.adjustedBones.add(name)
  else rigFitSession.adjustedBones.delete(name)
  useEditor.setState({ rigFitAdjustedCount: rigFitSession.adjustedBones.size })
}

let planePreview: THREE.Mesh | null = null
let lastPushedTime = -1
const animationEditLayers = new Map<string, AnimationEditLayer>()

interface HeadGeometryRecord {
  mesh: THREE.Mesh
  originalGeometry: THREE.BufferGeometry
  originalVisible: boolean
  derivedGeometry: THREE.BufferGeometry | null
}

interface HeadReplacementState {
  attachment: Attachment
  records: HeadGeometryRecord[]
}

const headStateByCharacter = new WeakMap<Character, HeadReplacementState>()

function normalizedBoneName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isDescendantBone(bone: THREE.Bone, ancestor: THREE.Bone): boolean {
  for (let current: THREE.Object3D | null = bone; current && (current as THREE.Bone).isBone; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

function geometryWithoutHead(
  mesh: THREE.SkinnedMesh,
  headBone: THREE.Bone,
): { geometry: THREE.BufferGeometry; removedFaces: number; headBounds: THREE.Box3 } | null {
  const geometry = mesh.geometry
  const position = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined
  const skinIndex = geometry?.getAttribute('skinIndex') as THREE.BufferAttribute | undefined
  const skinWeight = geometry?.getAttribute('skinWeight') as THREE.BufferAttribute | undefined
  if (!position || !skinIndex || !skinWeight || !mesh.skeleton) return null

  const meshHead = mesh.skeleton.bones.find(
    (bone) => normalizedBoneName(bone.name) === normalizedBoneName(headBone.name),
  ) || headBone
  const headIndices = new Set<number>()
  mesh.skeleton.bones.forEach((bone, index) => {
    if (isDescendantBone(bone, meshHead)) headIndices.add(index)
  })
  if (!headIndices.size) return null

  const headWeight = (vertex: number): number => {
    let total = 0
    for (let slot = 0; slot < Math.min(4, skinIndex.itemSize); slot += 1) {
      if (headIndices.has(skinIndex.getComponent(vertex, slot))) {
        total += skinWeight.getComponent(vertex, slot)
      }
    }
    return total
  }
  const sourceIndices = geometry.index
    ? Array.from(geometry.index.array)
    : Array.from({ length: position.count }, (_value, index) => index)
  const groups = geometry.groups.length
    ? geometry.groups
    : [{ start: 0, count: sourceIndices.length, materialIndex: 0 }]
  const keptGroups: { materialIndex: number; indices: number[] }[] = []
  const headBounds = new THREE.Box3()
  const point = new THREE.Vector3()
  let removedFaces = 0

  mesh.updateWorldMatrix(true, false)
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    if (headWeight(vertex) < 0.45) continue
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld)
    headBounds.expandByPoint(point)
  }

  for (const group of groups) {
    const indices: number[] = []
    const end = Math.min(sourceIndices.length, group.start + group.count)
    for (let offset = group.start; offset + 2 < end; offset += 3) {
      const triangle = [
        sourceIndices[offset],
        sourceIndices[offset + 1],
        sourceIndices[offset + 2],
      ]
      const weights = triangle.map(headWeight)
      const strong = weights.filter((value) => value >= 0.45).length
      if (strong >= 2 || weights[0] + weights[1] + weights[2] >= 1.65) removedFaces += 1
      else indices.push(...triangle)
    }
    keptGroups.push({ materialIndex: group.materialIndex || 0, indices })
  }
  if (!removedFaces) return null

  const derived = geometry.clone()
  derived.setIndex(keptGroups.flatMap((group) => group.indices))
  derived.clearGroups()
  let start = 0
  for (const group of keptGroups) {
    if (!group.indices.length) continue
    derived.addGroup(start, group.indices.length, group.materialIndex)
    start += group.indices.length
  }
  derived.computeBoundingBox()
  derived.computeBoundingSphere()
  return { geometry: derived, removedFaces, headBounds }
}

function libraryAssetById(assetId: string): AssetMeta | undefined {
  const lib = useLibrary.getState()
  return [...lib.systemAssets, ...lib.assets]
    .find((asset) => asset.id === assetId)
}

async function resolveAssetBlob(meta: AssetMeta): Promise<Blob | null> {
  if (meta.system) return fetchSystemAsset(meta)
  return (await getAssetBlob(meta.id)) ?? null
}

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
  syncRigFitContainer()
  updateBoneOverlay()
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
  if (sel.kind === 'object' && sel.id) return editableObjectById(sel.id)
  if (sel.kind === 'bone' && sel.id) return activeRig()?.byName.get(sel.id) ?? null
  return null
}

const SELECT_COLORS: Record<Selection['kind'], string> = {
  part: '#f5c065',
  character: '#6d9eff',
  attachment: '#67d4a8',
  plane: '#6d9eff',
  object: '#f0bd63',
  bone: '#a8c6ff',
}

function refreshSelectionVisuals(): void {
  if (!engine || !transformControls) return
  if (useEditor.getState().workspaceMode === 'object' && useEditor.getState().objectTool === 'sculpt') {
    engine.setOutline([])
    transformControls.detach()
    return
  }
  const sel = useEditor.getState().selection
  const obj = selectedObject(sel)
  if (!obj || !sel) {
    engine.setOutline([])
    transformControls.detach()
    if (sel) useEditor.setState({ selection: null })
    return
  }
  if (sel.kind === 'bone') {
    engine.setOutline([])
    const rootMovable = sel.id === character?.boneMap.root || sel.id === character?.boneMap.hips
    const requested = useEditor.getState().gizmoMode
    const mode = rigFitSession ? 'translate' : requested === 'translate' && rootMovable ? 'translate' : 'rotate'
    transformControls.setSpace(rigFitSession ? 'world' : 'local')
    transformControls.setMode(mode)
    transformControls.attach(obj)
    updateBoneOverlayColors()
    syncBoneTransform()
    return
  }
  // 轮廓描边（蒙皮动画下同样贴合模型轮廓）
  engine.setOutline([obj], SELECT_COLORS[sel.kind])
  transformControls.setSpace('world')
  transformControls.setMode(useEditor.getState().gizmoMode)
  transformControls.attach(obj)
}

export function select(sel: Selection | null): void {
  const state = useEditor.getState()
  if (state.workspaceMode === 'object') {
    const preserveMultiple = sel?.kind === 'plane' && state.objectTool === 'split'
    const objectSelectedIds = sel?.kind === 'object' && sel.id
      ? [sel.id]
      : preserveMultiple
        ? state.objectSelectedIds
        : []
    useEditor.setState({ selection: sel, objectSelectedIds })
  } else {
    useEditor.setState({ selection: sel })
  }
  syncObjectTransform()
  syncBoneTransform()
  updateBoneOverlayColors()
  refreshSelectionVisuals()
}

/** 左侧网格列表的多选；主选择仍作为操纵器和属性面板的编辑目标。 */
export function toggleObjectSelection(nodeId: string, additive = true): void {
  if (useEditor.getState().workspaceMode !== 'object' || !editableObjectById(nodeId)) return
  const state = useEditor.getState()
  const selected = additive ? new Set(state.objectSelectedIds) : new Set<string>()
  if (selected.has(nodeId) && additive) selected.delete(nodeId)
  else selected.add(nodeId)
  const ids = [...selected]
  useEditor.setState({
    objectSelectedIds: ids,
    selection: ids.length ? { kind: 'object', id: nodeId } : null,
  })
  syncObjectTransform()
  refreshSelectionVisuals()
}

export function setObjectTool(tool: ObjectTool): void {
  if (useEditor.getState().workspaceMode !== 'object') return
  useEditor.setState({ objectTool: tool })
  if (engine) engine.controls.enabled = tool !== 'sculpt'
  if (tool === 'sculpt') {
    transformControls?.detach()
    engine?.setOutline([])
  } else {
    endObjectSculpt()
    if (sculptCursor) sculptCursor.visible = false
    refreshSelectionVisuals()
  }
}

export function setSculptSettings(patch: Partial<{
  brush: SculptBrush
  radius: number
  strength: number
}>): void {
  const state = useEditor.getState()
  useEditor.setState({
    sculptBrush: patch.brush ?? state.sculptBrush,
    sculptRadius: patch.radius === undefined
      ? state.sculptRadius
      : THREE.MathUtils.clamp(patch.radius, 0.01, 5),
    sculptStrength: patch.strength === undefined
      ? state.sculptStrength
      : THREE.MathUtils.clamp(patch.strength, 0.01, 1),
  })
}

export function setGizmoMode(mode: GizmoMode): void {
  if (useEditor.getState().workspaceMode === 'object' && useEditor.getState().objectTool !== 'select') {
    setObjectTool('select')
  }
  const selection = useEditor.getState().selection
  let next = mode
  if (selection?.kind === 'bone') {
    if (rigFitSession) next = 'translate'
    else {
      const rootMovable = selection.id === character?.boneMap.root || selection.id === character?.boneMap.hips
      if (mode === 'scale' || (mode === 'translate' && !rootMovable)) next = 'rotate'
    }
  }
  useEditor.setState({ gizmoMode: next })
  transformControls?.setSpace(rigFitSession ? 'world' : 'local')
  transformControls?.setMode(next)
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

  if (
    useEditor.getState().workspaceMode === 'character'
    && useEditor.getState().showSkeleton
    && skeletonHelper?.points.visible
  ) {
    raycaster.params.Points = { threshold: 0.045 }
    const hit = raycaster.intersectObject(skeletonHelper.points, false)[0]
    if (hit?.index !== undefined) {
      const bone = skeletonHelper.bones[hit.index]
      if (bone) {
        select({ kind: 'bone', id: bone.name })
        return
      }
    }
  }

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

  if (useEditor.getState().workspaceMode === 'object' && character) {
    let objectNode: THREE.Object3D | null = hits[0].object
    while (objectNode && objectNode !== character.model && objectNode !== character.root) {
      if ((objectNode as THREE.Mesh).isMesh) {
        select({ kind: 'object', id: objectNode.uuid })
        return
      }
      objectNode = objectNode.parent
    }
    select({ kind: 'character' })
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
  else if (sel.kind === 'object' && sel.id) removeObjectNode(sel.id)
}

// ---- 操纵器拖拽 ⇄ 状态镜像 / 撤销

type DragSnapshot =
  | { kind: 'part'; id: string; info: PartInfo }
  | { kind: 'character'; pos: number[]; quat: number[]; scale: number[] }
  | { kind: 'attachment'; id: string; info: AttachmentInfo }
  | { kind: 'object'; id: string; pos: number[]; quat: number[]; scale: number[] }
  | { kind: 'bone'; id: string; pos: number[]; quat: number[] }
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
  if (sel.kind === 'object' && sel.id) {
    const object = editableObjectById(sel.id)
    return object
      ? {
          kind: 'object',
          id: sel.id,
          pos: object.position.toArray(),
          quat: object.quaternion.toArray() as number[],
          scale: object.scale.toArray(),
        }
      : null
  }
  if (sel.kind === 'bone' && sel.id && activeRig()) {
    const bone = activeRig()!.byName.get(sel.id)
    return bone
      ? {
          kind: 'bone',
          id: bone.name,
          pos: bone.position.toArray(),
          quat: bone.quaternion.toArray() as number[],
        }
      : null
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
    markObjectDirty()
  } else if (snap.kind === 'attachment' && character) {
    const a = character.attachments.find((x) => x.id === snap.id)
    if (a) {
      a.info = { ...snap.info }
      character.applyAttachmentOffset(a)
      syncAttachments()
    }
  } else if (snap.kind === 'object') {
    const object = editableObjectById(snap.id)
    if (object) {
      object.position.fromArray(snap.pos)
      object.quaternion.fromArray(snap.quat)
      object.scale.fromArray(snap.scale)
      syncObjectTransform()
      markObjectDirty()
    }
  } else if (snap.kind === 'bone' && activeRig()) {
    const bone = activeRig()!.byName.get(snap.id)
    if (bone) {
      bone.position.fromArray(snap.pos)
      bone.quaternion.fromArray(snap.quat)
      activeRig()!.root.updateWorldMatrix(true, true)
      if (rigFitSession) markRigFitBoneAdjusted(bone.name)
      syncBoneTransform()
      updateBoneOverlay()
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
    label: rigFitSession && before.kind === 'bone' ? '调整骨架适配点' : '操纵器调整',
    key: rigFitSession && before.kind === 'bone' ? `rig-fit-drag:${before.id}` : undefined,    undo: () => applySnapshot(before),
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
      const sc = character.root.scale
      if (useEditor.getState().uniformScale) {
        const cur = useEditor.getState().transform
        const vals = [Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z)]
        const previous = [Math.abs(cur.sx), Math.abs(cur.sy), Math.abs(cur.sz)]
        const deltas = vals.map((value, index) => Math.abs(value - previous[index]))
        const axis = deltas.indexOf(Math.max(...deltas))
        const base = Math.max(previous[axis], 0.000001)
        const ratio = Math.max(vals[axis], 0.001) / base
        sc.set(
          Math.max(0.001, previous[0] * ratio),
          Math.max(0.001, previous[1] * ratio),
          Math.max(0.001, previous[2] * ratio),
        )
      }
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
  } else if (sel.kind === 'object' && sel.id) {
    const object = editableObjectById(sel.id)
    if (!object) return
    if (useEditor.getState().uniformScale) {
      const current = useEditor.getState().objectTransform
      const values = [Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z)]
      const previous = [Math.abs(current.sx), Math.abs(current.sy), Math.abs(current.sz)]
      const deltas = values.map((value, index) => Math.abs(value - previous[index]))
      const axis = deltas.indexOf(Math.max(...deltas))
      const ratio = Math.max(values[axis], 0.01) / Math.max(previous[axis], 0.000001)
      object.scale.set(
        Math.max(0.01, previous[0] * ratio),
        Math.max(0.01, previous[1] * ratio),
        Math.max(0.01, previous[2] * ratio),
      )
    }
    syncObjectTransform()
    markObjectDirty()
  } else if (sel.kind === 'bone') {
    if (sel.id && rigFitSession) markRigFitBoneAdjusted(sel.id)
    activeRig()?.root.updateWorldMatrix(true, true)
    syncBoneTransform()
    updateBoneOverlay()
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

function editableObjectById(id: string): THREE.Object3D | null {
  if (!character) return null
  return character.model.getObjectByProperty('uuid', id) ?? null
}

function transformInfoOf(object: THREE.Object3D | null): TransformInfo {
  if (!object) {
    return {
      px: 0, py: 0, pz: 0,
      rx: 0, ry: 0, rz: 0,
      sx: 1, sy: 1, sz: 1,
    }
  }
  return {
    px: object.position.x,
    py: object.position.y,
    pz: object.position.z,
    rx: THREE.MathUtils.radToDeg(object.rotation.x),
    ry: THREE.MathUtils.radToDeg(object.rotation.y),
    rz: THREE.MathUtils.radToDeg(object.rotation.z),
    sx: object.scale.x,
    sy: object.scale.y,
    sz: object.scale.z,
  }
}

function collectObjectNodes(): ObjectNodeInfo[] {
  if (!character) return []
  const out: ObjectNodeInfo[] = []
  character.model.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    out.push({
      id: object.uuid,
      name: object.name || `网格 ${out.length + 1}`,
      type: (mesh as THREE.SkinnedMesh).isSkinnedMesh ? '蒙皮网格' : '静态网格',
      visible: object.visible,
      vertices: mesh.geometry?.getAttribute('position')?.count ?? 0,
      sculptable: !(mesh as THREE.SkinnedMesh).isSkinnedMesh,
    })
  })
  return out
}

function syncObjectTransform(): void {
  const selection = useEditor.getState().selection
  const selected = selection?.kind === 'object' && selection.id
    ? editableObjectById(selection.id)
    : null
  useEditor.setState({ objectTransform: transformInfoOf(selected) })
}

function syncBoneTransform(): void {
  const selection = useEditor.getState().selection
  const rig = activeRig()
  const bone = selection?.kind === 'bone' && selection.id && rig
    ? rig.byName.get(selection.id) ?? null
    : null
  useEditor.setState({ boneTransform: transformInfoOf(bone) })
}

function syncObjectNodes(): void {
  const nodes = collectObjectNodes()
  const validIds = new Set(nodes.map((node) => node.id))
  useEditor.setState({
    objectNodes: nodes,
    objectSelectedIds: useEditor.getState().objectSelectedIds.filter((id) => validIds.has(id)),
    meshes: collectMeshInfos(),
    materials: collectMaterialInfos(),
    morphs: collectMorphInfos(),
  })
  syncObjectTransform()
}

function markObjectDirty(): void {
  if (useEditor.getState().workspaceMode === 'object') {
    useEditor.setState({ objectDirty: true })
  }
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
        textures: {
          ...(std.map ? { map: std.map.name || '颜色贴图' } : {}),
          ...(std.normalMap ? { normalMap: std.normalMap.name || '法线贴图' } : {}),
          ...(std.roughnessMap ? { roughnessMap: std.roughnessMap.name || '粗糙度贴图' } : {}),
          ...(std.metalnessMap ? { metalnessMap: std.metalnessMap.name || '金属度贴图' } : {}),
        },
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
  const root = character.root
  useEditor.setState({
    transform: {
      px: root.position.x,
      py: root.position.y,
      pz: root.position.z,
      rx: THREE.MathUtils.radToDeg(root.rotation.x),
      ry: THREE.MathUtils.radToDeg(root.rotation.y),
      rz: THREE.MathUtils.radToDeg(root.rotation.z),
      sx: root.scale.x,
      sy: root.scale.y,
      sz: root.scale.z,
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
      rigFitActive: false, rigFitProfileId: null, rigFitBones: [], rigFitAdjustedCount: 0,
      referencePose: 'source', referencePoseProfileId: null, animationEditTracks: 0,
      objectNodes: [],
      objectSelectedIds: [],
      objectTransform: transformInfoOf(null),
      transform: {
        px: 0, py: 0, pz: 0,
        rx: 0, ry: 0, rz: 0,
        sx: 1, sy: 1, sz: 1,
      },
      playback: { ...DEFAULT_PLAYBACK },
    })
    refreshSelectionVisuals()
    return
  }
  const currentCharacter = character
  store.set({
    hasCharacter: true,
    characterName: currentCharacter.name,
    skeletonGuess: currentCharacter.skeletonGuess,
    meshes: collectMeshInfos(),
    materials: collectMaterialInfos(),
    morphs: collectMorphInfos(),
    bones: currentCharacter.boneNames,
    rigFitActive: false,
    rigFitProfileId: null,
    rigFitBones: [],
    rigFitAdjustedCount: 0,
    boneMap: { ...currentCharacter.boneMap },
    referencePoseProfileId: currentCharacter.skeletonProfileId,
    clips: currentCharacter.clipInfos(),
    attachments: currentCharacter.attachments.map((a) => ({ ...a.info })),
    objectNodes: store.workspaceMode === 'object' ? collectObjectNodes() : [],
    objectSelectedIds: store.workspaceMode === 'object'
      ? store.objectSelectedIds.filter((id) => Boolean(currentCharacter.model.getObjectByProperty('uuid', id)))
      : [],
    objectTransform: store.workspaceMode === 'object'
      ? transformInfoOf(selectedObject(store.selection))
      : transformInfoOf(null),
    transform: {
      px: currentCharacter.root.position.x,
      py: currentCharacter.root.position.y,
      pz: currentCharacter.root.position.z,
      rx: THREE.MathUtils.radToDeg(currentCharacter.root.rotation.x),
      ry: THREE.MathUtils.radToDeg(currentCharacter.root.rotation.y),
      rz: THREE.MathUtils.radToDeg(currentCharacter.root.rotation.z),
      sx: currentCharacter.root.scale.x,
      sy: currentCharacter.root.scale.y,
      sz: currentCharacter.root.scale.z,
    },
  })
  refreshSelectionVisuals()
}

// ---------------------------------------------------------------- 角色装载与替换

function clearRigFitSession(): void {
  const session = rigFitSession
  if (!session) return
  if (useEditor.getState().selection?.kind === 'bone') select(null)
  removeSkeletonHelper()
  session.container.removeFromParent()
  disposeObject(session.container)
  discardCommandsByKeyPrefix('rig-fit')
  rigFitSession = null
  useEditor.setState({
    rigFitActive: false,
    rigFitProfileId: null,
    rigFitBones: [],
    rigFitAdjustedCount: 0,
  })
}
/** 把当前角色移出场景但不销毁（撤销栈持有） */
function swapOutCharacter(): Character | null {
  clearRigFitSession()
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
  opts: {
    autoFit?: boolean
    keepTransform?: boolean
    skeletonProfileId?: string | null
    sourceAssetId?: string | null
  },
  label: string,
): void {
  if (!engine) return
  const prevTransform = character
    ? {
        pos: character.root.position.clone(),
        quat: character.root.quaternion.clone(),
        scale: character.root.scale.clone(),
      }
    : null
  let parked = swapOutCharacter()

  character = new Character(
    group,
    name,
    opts.skeletonProfileId ?? null,
    opts.sourceAssetId ?? null,
  )
  animationEditLayers.clear()
  engine.scene.add(character.root)
  if (opts.keepTransform && prevTransform) {
    character.root.position.copy(prevTransform.pos)
    character.root.quaternion.copy(prevTransform.quat)
    character.root.scale.copy(prevTransform.scale)
  } else if (opts.autoFit) {
    const box = new THREE.Box3().setFromObject(character.root)
    const h = box.getSize(new THREE.Vector3()).y
    if (h > 0 && (h > 3.2 || h < 0.8)) {
      character.root.scale.setScalar(1.75 / h)
      toast('info', `已自动调整模型尺寸（原始高度 ${h.toFixed(2)}）`)
    }
    const placement = centerObjectOnGround(character.model)
    if (placement && placement.offset.lengthSq() > 1e-10) {
      const cm = placement.offset.clone().multiplyScalar(100)
      toast('info', `已自动归位模型：X ${cm.x.toFixed(1)} / Y ${cm.y.toFixed(1)} / Z ${cm.z.toFixed(1)} cm`)
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
  const meta = libraryAssetById(assetId)
  if (!meta) return

  try {
    const blob = await resolveAssetBlob(meta)
    if (!blob) throw new Error('找不到资源文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)

    installCharacterWithUndo(
      parsed.object,
      meta.name,
      {
        autoFit: true,
        skeletonProfileId: meta.skeletonProfileId ?? null,
        sourceAssetId: meta.id,
      },
      `载入角色 ${meta.name}`,
    )
    if (!character) return
    workspaceSnapshotAssetId = null
    useEditor.setState({
      workspaceId: null,
      workspaceSavedAt: null,
      workspaceDirty: true,
    })
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

/**
 * 进入绑定前骨架适配：只显示骨架预览，不立即改变或蒙皮原模型。
 * 用户可以在视口点选关节点并用移动操纵器调整，再确认生成基础蒙皮。
 */
export async function beginBaselineRigFit(
  profileId: 'ue5-mannequin-simple' | 'uefn-mannequin',
  sourcePose: 't' | 'a',
): Promise<boolean> {
  if (!engine || !character) {
    toast('warn', '请先加载静态完整人物')
    return false
  }
  const baseline = useLibrary.getState().systemAssets.find(
    (asset) => asset.kind === 'model' && asset.skeletonProfileId === profileId,
  )
  if (!baseline) {
    toast('err', `资源库中找不到 ${profileId} 系统基准`)
    return false
  }

  clearRigFitSession()
  const char = character
  let parsedBaseline: Awaited<ReturnType<typeof parseAssetFile>> | null = null
  try {
    char.stop()
    char.resetPose()
    const targetBounds = computeVisibleMeshBoundsInParent(
      char.model,
      char.attachments.map((attachment) => attachment.object),
    )
    if (targetBounds.isEmpty() || targetBounds.getSize(new THREE.Vector3()).y < 0.01) {
      throw new Error('当前人物没有可用于骨架适配的有效网格')
    }

    const blob = await resolveAssetBlob(baseline)
    if (!blob) throw new Error('系统基准文件不存在')
    parsedBaseline = await parseAssetFile(
      await blob.arrayBuffer(),
      `${baseline.name}.${baseline.format}`,
    )
    const baselineRig = buildRig(parsedBaseline.object)
    if (!baselineRig) throw new Error('系统基准资产没有骨架')
    const payload = await loadReferencePoseProfiles()
    const profile = payload.profiles[profileId]
    if (!profile) throw new Error(`缺少 ${profileId} 参考姿势`)
    applyVerifiedReferencePose(baselineRig, profileId, profile, sourcePose)

    const prepared = prepareBaselineRig(parsedBaseline.object, targetBounds, profileId)
    const container = new THREE.Group()
    container.name = 'RigFitPreview'
    container.add(prepared.root)
    engine.scene.add(container)
    const initialLocal = new Map<THREE.Bone, BonePose>()
    for (const bone of prepared.rig.bones) {
      initialLocal.set(bone, {
        pos: bone.position.clone(),
        quat: bone.quaternion.clone(),
        scale: bone.scale.clone(),
      })
    }
    rigFitSession = {
      profileId,
      sourcePose,
      container,
      rigRoot: prepared.root,
      rig: prepared.rig,
      initialLocal,
      adjustedBones: new Set(),
    }
    syncRigFitContainer()
    useEditor.setState({
      rigFitActive: true,
      rigFitProfileId: profileId,
      rigFitSourcePose: sourcePose,
      rigFitBones: rigFitBoneNames(prepared.rig),
      rigFitAdjustedCount: 0,
      showSkeleton: true,
      gizmoMode: 'translate',
      playback: { ...DEFAULT_PLAYBACK },
    })
    removeSkeletonHelper()
    addSkeletonHelper()
    const firstBone = prepared.rig.byName.get('pelvis')
      ?? prepared.rig.byName.get('root')
      ?? prepared.rig.bones[0]
    if (firstBone) select({ kind: 'bone', id: firstBone.name })
    engine.frameObject(char.root)
    toast('ok', '骨架适配已开启：拖动关节点贴合肩、肘、手、髋、膝和脚，再确认生成蒙皮')
    return true
  } catch (error) {
    console.error(error)
    clearRigFitSession()
    toast('err', `准备骨架失败：${error instanceof Error ? error.message : '未知错误'}`)
    return false
  } finally {
    if (parsedBaseline) disposeObject(parsedBaseline.object)
  }
}

export function resetBaselineRigFit(): void {
  if (!rigFitSession) return
  for (const [bone, pose] of rigFitSession.initialLocal) {
    bone.position.copy(pose.pos)
    bone.quaternion.copy(pose.quat)
    bone.scale.copy(pose.scale)
  }
  rigFitSession.adjustedBones.clear()
  discardCommandsByKeyPrefix('rig-fit')
  rigFitSession.rig.root.updateWorldMatrix(true, true)
  useEditor.setState({ rigFitAdjustedCount: 0 })
  syncBoneTransform()
  updateBoneOverlay()
  toast('info', '骨架适配已恢复到自动匹配结果')
}

export function cancelBaselineRigFit(): void {
  if (!rigFitSession) return
  clearRigFitSession()
  useEditor.setState({ showSkeleton: Boolean(character?.rig) })
  if (character?.rig && useEditor.getState().showSkeleton) addSkeletonHelper()
  toast('info', '已取消骨架适配，原模型没有被修改')
}

export async function commitBaselineRigFit(): Promise<void> {
  if (!engine || !character || !rigFitSession) {
    toast('warn', '请先开始骨架适配')
    return
  }
  const char = character
  const session = rigFitSession
  try {
    toast('info', '正在按当前关节点位置计算基础四权重蒙皮…')
    const result = await autoRigToBaseline(
      char.model,
      char.root,
      session.rigRoot,
      session.profileId,
      char.name,
      session.rigRoot,
    )
    const profileId = session.profileId
    const sourcePose = session.sourcePose
    const sourceAssetId = char.sourceAssetId
    clearRigFitSession()
    installCharacterWithUndo(
      result.group,
      char.name,
      { keepTransform: true, skeletonProfileId: profileId, sourceAssetId },
      `按适配结果添加 ${profileId} 骨架`,
    )
    useEditor.setState({
      referencePose: sourcePose,
      referencePoseProfileId: profileId,
      workspaceDirty: true,
    })
    toast(
      'ok',
      `基础蒙皮完成：${result.boneCount} 根骨骼、${result.vertexCount.toLocaleString()} 个顶点；可继续添加动画`,
    )
  } catch (error) {
    console.error(error)
    toast('err', `生成骨架失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/** 兼容旧调用：自动准备后立即生成；新界面使用“预览适配 → 确认生成”的两阶段流程。 */
export async function overrideSkeletonWithBaseline(
  profileId: 'ue5-mannequin-simple' | 'uefn-mannequin',
  sourcePose: 't' | 'a',
): Promise<void> {
  if (await beginBaselineRigFit(profileId, sourcePose)) await commitBaselineRigFit()
}
/** 提交后端 Blender 自动权重；浏览器基础蒙皮不会被覆盖，完成结果作为新资产安装。 */
export async function submitBlenderAutoRig(
  profileId: 'ue5-mannequin-simple' | 'uefn-mannequin',
  sourcePose: 't' | 'a',
): Promise<void> {
  if (!character) {
    toast('warn', '请先加载完整人物')
    return
  }
  const char = character
  const baseline = useLibrary.getState().systemAssets.find(
    (asset) => asset.kind === 'model' && asset.skeletonProfileId === profileId,
  )
  if (!baseline) {
    toast('err', '找不到所选系统基准骨架')
    return
  }
  const pieces = bakeMeshesStatic(char.model, char.root)
  const staticGroup = piecesToGroup(pieces, char.name)
  if (!staticGroup) {
    toast('err', '当前人物没有可提交的网格')
    return
  }
  try {
    const blob = await exportGlbBlob(staticGroup)
    const job = await submitAutoRigJob(blob, {
      name: char.name,
      profileId,
      sourcePose,
      baselineAssetId: baseline.id,
      sourceAssetId: char.sourceAssetId,
    })
    useEditor.setState({ rigJob: { id: job.id, status: job.status, progress: job.progress } })
    toast('ok', `Blender 自动蒙皮任务已提交：${job.id}`)
    void monitorAutoRigJob(job.id, char, profileId)
  } catch (error) {
    console.error(error)
    toast('err', `后台蒙皮任务失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    disposeObject(staticGroup, { keepMaterials: true })
  }
}

async function monitorAutoRigJob(
  jobId: string,
  sourceCharacter: Character,
  profileId: 'ue5-mannequin-simple' | 'uefn-mannequin',
): Promise<void> {
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2200))
      const job = await fetchHubJob(jobId)
      useEditor.setState({ rigJob: { id: job.id, status: job.status, progress: job.progress } })
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(job.status)) {
        if (job.status !== 'completed' || !job.result?.file) {
          toast('warn', job.error || `后台任务已结束：${job.status}`)
          return
        }
        const response = await fetch(job.result.file, { cache: 'no-store' })
        if (!response.ok) throw new Error(`精修结果下载失败：HTTP ${response.status}`)
        const blob = await response.blob()
        const parsed = await parseAssetFile(await blob.arrayBuffer(), `${sourceCharacter.name}-blender.glb`)
        const thumb = renderThumbnail(parsed.object)
        const localId = await useLibrary.getState().addGeneratedAsset(
          blob,
          `${sourceCharacter.name}·Blender 精修`,
          'model',
          {
            thumb,
            bones: parsed.boneNames,
            clipNames: parsed.clips.map((clip) => clip.name),
          },
        )
        if (character === sourceCharacter) {
          installCharacterWithUndo(
            parsed.object,
            `${sourceCharacter.name}·Blender 精修`,
            {
              keepTransform: true,
              skeletonProfileId: profileId,
              sourceAssetId: localId,
            },
            '安装 Blender 精修蒙皮',
          )
          toast('ok', 'Blender 自动权重已完成并安装；浏览器基础蒙皮仍保留在撤销记录中')
        } else {
          disposeObject(parsed.object)
          toast('ok', 'Blender 自动权重已完成并保存到资源库；当前人物已变化，因此没有自动替换')
        }
        return
      }
    }
  } catch (error) {
    console.error(error)
    toast('err', `后台任务监控失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

// ---------------------------------------------------------------- 动画绑定

/**
 * 直接绑定时按角色髋骨绑定高度缩放位移轨道：
 * 骨骼命名相同但体型 / 单位不同（例如骨骼覆盖后的角色配外部动画）也能落对高度。
 */
// ---------------------------------------------------------------- 单物体编辑工作区

function confirmDiscardObjectChanges(): boolean {
  return !useEditor.getState().objectDirty
    || window.confirm('当前物体还有未保存的修改。确定放弃修改吗？')
}

function prepareObjectWorkspace(): boolean {
  const state = useEditor.getState()
  if (state.workspaceMode === 'object' && !confirmDiscardObjectChanges()) return false

  endObjectSculpt()
  if (engine) engine.controls.enabled = true
  if (sculptCursor) sculptCursor.visible = false
  clearHistory()
  if (state.workspaceMode === 'character') {
    parkedCharacterWorkspace = swapOutCharacter()
  } else {
    const previousObject = swapOutCharacter()
    previousObject?.dispose(true)
  }
  select(null)
  return true
}

function installObjectDocument(
  group: THREE.Object3D,
  name: string,
  sourceAsset: AssetMeta | null,
): void {
  if (!engine) return
  character = new Character(group, name)
  engine.scene.add(character.root)

  const box = new THREE.Box3().setFromObject(character.root)
  const size = box.getSize(new THREE.Vector3())
  const maxDimension = Math.max(size.x, size.y, size.z)
  if (maxDimension > 0 && (maxDimension > 6 || maxDimension < 0.08)) {
    character.root.scale.setScalar(1.5 / maxDimension)
  }
  groundCharacter(false)

  useEditor.setState({
    workspaceMode: 'object',
    objectSourceAssetId: sourceAsset?.id ?? null,
    objectSourceKind: sourceAsset?.kind === 'model' ? 'model' : 'prop',
    objectDirty: false,
    objectSelectedIds: [],
    objectTool: 'select',
    tab: 'model',
    showSkeleton: false,
    playback: { ...DEFAULT_PLAYBACK },
    selection: null,
  })
  syncCharacter()
  syncObjectNodes()
  engine.frameObject(character.root)
}

/** 从资产列表进入隔离的单物体编辑页。 */
export async function editAssetAsObject(assetId: string): Promise<void> {
  if (!engine) return
  const meta = libraryAssetById(assetId)
  if (!meta || meta.kind === 'anim') {
    toast('warn', '只有模型和物品资产可以进入单物体编辑器')
    return
  }

  try {
    const blob = await resolveAssetBlob(meta)
    if (!blob) throw new Error('找不到资产文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)
    if (!prepareObjectWorkspace()) {
      disposeObject(parsed.object)
      return
    }
    installObjectDocument(parsed.object, meta.name, meta)
    toast('ok', `已进入「${meta.name}」的单物体编辑页`)
  } catch (error) {
    console.error(error)
    toast('err', `打开物体失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/** 顶部“新增物体”：建立真正的空白物体文档。 */
export function createNewObject(): void {
  if (!engine || !prepareObjectWorkspace()) return
  const group = new THREE.Group()
  group.name = '空白物体'
  installObjectDocument(group, '未命名物体', null)
  toast('info', '已创建空白物体；请从左侧添加第一个基础形状')
}

/** 返回人物工作区，并恢复进入物体编辑器前的人物。 */
export function leaveObjectEditor(): void {
  if (useEditor.getState().workspaceMode !== 'object' || !confirmDiscardObjectChanges()) return
  endObjectSculpt()
  if (engine) engine.controls.enabled = true
  if (sculptCursor) sculptCursor.visible = false
  clearHistory()
  const currentObject = swapOutCharacter()
  currentObject?.dispose(true)
  useEditor.setState({
    workspaceMode: 'character',
    objectSourceAssetId: null,
    objectSourceKind: null,
    objectDirty: false,
    objectNodes: [],
    objectSelectedIds: [],
    objectTool: 'select',
    objectTransform: transformInfoOf(null),
    selection: null,
  })
  reinstallCharacter(parkedCharacterWorkspace)
  parkedCharacterWorkspace = null
  if (character && engine) engine.frameObject(character.root)
}

function primitiveDefinition(kind: PrimitiveKind): {
  geometry: THREE.BufferGeometry
  name: string
  y: number
  color: number
} {
  if (kind === 'sphere') {
    return { geometry: new THREE.SphereGeometry(0.5, 32, 20), name: '球体', y: 0.5, color: 0x6f9cff }
  }
  if (kind === 'cylinder') {
    return { geometry: new THREE.CylinderGeometry(0.45, 0.45, 1, 32), name: '圆柱', y: 0.5, color: 0x59c5a7 }
  }
  if (kind === 'cone') {
    return { geometry: new THREE.ConeGeometry(0.5, 1, 32), name: '圆锥', y: 0.5, color: 0xe7a453 }
  }
  if (kind === 'capsule') {
    return { geometry: new THREE.CapsuleGeometry(0.35, 0.7, 8, 16), name: '胶囊', y: 0.7, color: 0xc184e8 }
  }
  if (kind === 'torus') {
    return { geometry: new THREE.TorusGeometry(0.55, 0.18, 16, 48), name: '圆环', y: 0.65, color: 0xe7778d }
  }
  return { geometry: new THREE.BoxGeometry(1, 1, 1), name: '方块', y: 0.5, color: 0x8d98aa }
}

/** 向空白或现有物体文档添加一个独立基础网格。 */
export function addObjectPrimitive(kind: PrimitiveKind): void {
  if (!character || useEditor.getState().workspaceMode !== 'object') return
  const definition = primitiveDefinition(kind)
  const material = new THREE.MeshStandardMaterial({
    color: definition.color,
    roughness: 0.62,
    metalness: 0.08,
  })
  const mesh = new THREE.Mesh(definition.geometry, material)
  mesh.name = `${definition.name} ${collectObjectNodes().length + 1}`
  mesh.position.y = definition.y
  mesh.castShadow = true
  mesh.receiveShadow = true
  const parent = character.model
  parent.add(mesh)

  const applyAdd = () => {
    parent.add(mesh)
    syncObjectNodes()
    markObjectDirty()
    select({ kind: 'object', id: mesh.uuid })
  }
  const applyRemove = () => {
    mesh.removeFromParent()
    if (useEditor.getState().selection?.id === mesh.uuid) select(null)
    syncObjectNodes()
    markObjectDirty()
  }

  syncObjectNodes()
  markObjectDirty()
  select({ kind: 'object', id: mesh.uuid })
  engine?.frameObject(mesh)
  pushCommand({
    label: `添加${definition.name}`,
    undo: applyRemove,
    redo: applyAdd,
    dispose: () => {
      if (!mesh.parent) disposeObject(mesh)
    },
  })
}

export function selectObjectRoot(): void {
  if (useEditor.getState().workspaceMode === 'object' && character) {
    select({ kind: 'character' })
  }
}

export function setObjectName(name: string): void {
  if (!character || useEditor.getState().workspaceMode !== 'object') return
  const next = name.slice(0, 80)
  character.name = next
  character.root.name = `object:${next || '未命名物体'}`
  useEditor.setState({ characterName: next, objectDirty: true })
}

export function setObjectNodeTransform(nodeId: string, patch: Partial<TransformInfo>): void {
  const object = editableObjectById(nodeId)
  if (!object) return
  const before = transformInfoOf(object)
  const apply = (value: Partial<TransformInfo>) => {
    if (value.px !== undefined) object.position.x = value.px
    if (value.py !== undefined) object.position.y = value.py
    if (value.pz !== undefined) object.position.z = value.pz
    if (value.rx !== undefined) object.rotation.x = THREE.MathUtils.degToRad(value.rx)
    if (value.ry !== undefined) object.rotation.y = THREE.MathUtils.degToRad(value.ry)
    if (value.rz !== undefined) object.rotation.z = THREE.MathUtils.degToRad(value.rz)
    if (value.sx !== undefined || value.sy !== undefined || value.sz !== undefined) {
      const state = useEditor.getState()
      const hasCompleteScale = value.sx !== undefined && value.sy !== undefined && value.sz !== undefined
      // 撤销/恢复传入的是完整终态，必须精确还原；单轴 UI 调整才应用等比缩放锁。
      if (hasCompleteScale) {
        object.scale.set(
          Math.max(0.01, value.sx!),
          Math.max(0.01, value.sy!),
          Math.max(0.01, value.sz!),
        )
      } else if (state.uniformScale) {
        const axis = value.sx !== undefined ? 'sx' : value.sy !== undefined ? 'sy' : 'sz'
        const previous = Math.max(Math.abs(state.objectTransform[axis]), 0.000001)
        const ratio = Math.max(Math.abs(value[axis] ?? previous), 0.01) / previous
        object.scale.set(
          Math.max(0.01, state.objectTransform.sx * ratio),
          Math.max(0.01, state.objectTransform.sy * ratio),
          Math.max(0.01, state.objectTransform.sz * ratio),
        )
      } else {
        if (value.sx !== undefined) object.scale.x = Math.max(0.01, value.sx)
        if (value.sy !== undefined) object.scale.y = Math.max(0.01, value.sy)
        if (value.sz !== undefined) object.scale.z = Math.max(0.01, value.sz)
      }
    }
    syncObjectTransform()
    markObjectDirty()
  }
  apply(patch)
  const after = transformInfoOf(object)
  pushCommand({
    label: '调整物体组件',
    key: `object-transform:${nodeId}`,
    undo: () => apply(before),
    redo: () => apply(after),
  })
}

export function renameObjectNode(nodeId: string, name: string): void {
  const object = editableObjectById(nodeId)
  const next = name.trim()
  if (!object || !next || object.name === next) return
  const before = object.name
  const apply = (value: string) => {
    object.name = value
    syncObjectNodes()
    markObjectDirty()
  }
  apply(next)
  pushCommand({ label: '重命名组件', undo: () => apply(before), redo: () => apply(next) })
}

export function setObjectNodeVisible(nodeId: string, visible: boolean): void {
  const object = editableObjectById(nodeId)
  if (!object || object.visible === visible) return
  const apply = (value: boolean) => {
    object.visible = value
    syncObjectNodes()
    markObjectDirty()
  }
  apply(visible)
  pushCommand({
    label: visible ? '显示组件' : '隐藏组件',
    undo: () => apply(!visible),
    redo: () => apply(visible),
  })
}

function cloneEditableNode(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true)
  clone.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry = mesh.geometry.clone()
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => material.clone())
    } else if (mesh.material) {
      mesh.material = mesh.material.clone()
    }
  })
  return clone
}

export function duplicateObjectNode(nodeId: string): void {
  const source = editableObjectById(nodeId)
  if (!source || !source.parent) return
  const parent = source.parent
  const clone = cloneEditableNode(source)
  clone.name = `${source.name || '组件'} 副本`
  clone.position.x += 0.12
  const applyAdd = () => {
    parent.add(clone)
    syncObjectNodes()
    markObjectDirty()
    select({ kind: 'object', id: clone.uuid })
  }
  const applyRemove = () => {
    clone.removeFromParent()
    if (useEditor.getState().selection?.id === clone.uuid) select(null)
    syncObjectNodes()
    markObjectDirty()
  }
  applyAdd()
  pushCommand({
    label: '复制物体组件',
    undo: applyRemove,
    redo: applyAdd,
    dispose: () => {
      if (!clone.parent) disposeObject(clone)
    },
  })
}

export function removeObjectNode(nodeId: string): void {
  const object = editableObjectById(nodeId)
  if (!object?.parent) return
  const parent = object.parent
  const applyRemove = () => {
    object.removeFromParent()
    if (useEditor.getState().selection?.id === nodeId) select(null)
    syncObjectNodes()
    markObjectDirty()
  }
  const applyRestore = () => {
    parent.add(object)
    syncObjectNodes()
    markObjectDirty()
    select({ kind: 'object', id: nodeId })
  }
  applyRemove()
  pushCommand({
    label: '删除物体组件',
    undo: applyRestore,
    redo: applyRemove,
    dispose: () => {
      if (!object.parent) disposeObject(object)
    },
  })
}

interface ObjectNodeLocation {
  object: THREE.Object3D
  parent: THREE.Object3D
  index: number
}

function insertChildAt(parent: THREE.Object3D, object: THREE.Object3D, index: number): void {
  parent.add(object)
  const current = parent.children.indexOf(object)
  parent.children.splice(current, 1)
  parent.children.splice(Math.min(Math.max(index, 0), parent.children.length), 0, object)
}

function meshFromPieces(pieces: readonly BakedPiece[], name: string): THREE.Mesh | null {
  const merged = mergePieces([...pieces])
  if (!merged) return null
  const mesh = new THREE.Mesh(
    merged.geometry,
    merged.materials.length === 1 ? merged.materials[0] : merged.materials,
  )
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function applyObjectReplacement(
  originals: readonly ObjectNodeLocation[],
  replacements: readonly THREE.Mesh[],
  useReplacements: boolean,
): void {
  if (!character) return
  if (useReplacements) {
    for (const item of originals) item.object.removeFromParent()
    for (const replacement of replacements) character.model.add(replacement)
    syncObjectNodes()
    markObjectDirty()
    const first = replacements[0]
    if (first) {
      select({ kind: 'object', id: first.uuid })
      useEditor.setState({ objectSelectedIds: replacements.map((mesh) => mesh.uuid) })
    } else {
      select(null)
    }
    return
  }
  for (const replacement of replacements) replacement.removeFromParent()
  for (const item of originals) insertChildAt(item.parent, item.object, item.index)
  syncObjectNodes()
  markObjectDirty()
  const first = originals[0]?.object
  if (first) {
    select({ kind: 'object', id: first.uuid })
    useEditor.setState({ objectSelectedIds: originals.map((item) => item.object.uuid) })
  }
}

/** 把左侧勾选的多个静态网格烘焙并合并成一个真正的网格组件。 */
export function mergeSelectedObjectNodes(): void {
  if (!character || useEditor.getState().workspaceMode !== 'object') return
  const ids = [...new Set(useEditor.getState().objectSelectedIds)]
  if (ids.length < 2) {
    toast('warn', '请先在左侧勾选至少两个静态网格')
    return
  }
  const objects = ids
    .map((id) => editableObjectById(id) as THREE.Mesh | null)
    .filter((object): object is THREE.Mesh => Boolean(object?.isMesh && object.parent))
  if (objects.length !== ids.length) {
    toast('warn', '选择中包含已经失效的组件，请重新选择')
    return
  }
  if (objects.some((mesh) => (mesh as THREE.SkinnedMesh).isSkinnedMesh)) {
    toast('warn', '基础合并只处理静态网格；蒙皮网格请先在人物工作区导出静态副本')
    return
  }

  const originals: ObjectNodeLocation[] = objects.map((object) => ({
    object,
    parent: object.parent!,
    index: object.parent!.children.indexOf(object),
  }))
  const pieces = objects.flatMap((object) => bakeMeshesStatic(object, character!.model))
  const merged = meshFromPieces(pieces, `${character.name || '物体'}·合并`)
  for (const piece of pieces) piece.geometry.dispose()
  if (!merged) {
    toast('warn', '所选组件没有可合并的网格')
    return
  }

  applyObjectReplacement(originals, [merged], true)
  pushCommand({
    label: '合并物体组件',
    undo: () => applyObjectReplacement(originals, [merged], false),
    redo: () => applyObjectReplacement(originals, [merged], true),
    dispose: () => {
      if (!merged.parent) disposeObject(merged, { keepMaterials: true })
    },
  })
  toast('ok', `已把 ${objects.length} 个组件合并成一个网格`)
}

function selectedStaticObjectMesh(): THREE.Mesh | null {
  const selection = useEditor.getState().selection
  const objectId = selection?.kind === 'object' && selection.id
    ? selection.id
    : useEditor.getState().objectSelectedIds[0]
  const mesh = objectId
    ? editableObjectById(objectId) as THREE.Mesh | null
    : null
  if (!mesh?.isMesh) {
    toast('warn', '请先选择一个网格组件')
    return null
  }
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    toast('warn', '拆分和雕刻目前只修改静态网格，避免破坏蒙皮权重')
    return null
  }
  return mesh
}

function installSplitMeshes(source: THREE.Mesh, meshes: THREE.Mesh[], label: string): void {
  if (!source.parent || meshes.length < 2) {
    for (const mesh of meshes) disposeObject(mesh, { keepMaterials: true })
    toast('warn', '拆分结果不足两个组件')
    return
  }
  const originals: ObjectNodeLocation[] = [{
    object: source,
    parent: source.parent,
    index: source.parent.children.indexOf(source),
  }]
  applyObjectReplacement(originals, meshes, true)
  pushCommand({
    label,
    undo: () => applyObjectReplacement(originals, meshes, false),
    redo: () => applyObjectReplacement(originals, meshes, true),
    dispose: () => {
      for (const mesh of meshes) {
        if (!mesh.parent) disposeObject(mesh, { keepMaterials: true })
      }
    },
  })
}

/** 沿当前切割平面把选中网格替换为 A/B 两个真实组件。 */
export function splitSelectedObjectByPlane(): void {
  if (!character || !planePreview?.visible) {
    toast('warn', '先打开切割平面并调整位置')
    return
  }
  const source = selectedStaticObjectMesh()
  if (!source) return
  const pieces = bakeMeshesStatic(source, character.model)
  const worldPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    planePreview.getWorldDirection(new THREE.Vector3()),
    planePreview.getWorldPosition(new THREE.Vector3()),
  )
  character.model.updateWorldMatrix(true, false)
  const localPlane = worldPlane.clone().applyMatrix4(character.model.matrixWorld.clone().invert())
  const point = localPlane.coplanarPoint(new THREE.Vector3())
  const { inside, outside } = cutByPlane(pieces, point, localPlane.normal)
  for (const piece of pieces) piece.geometry.dispose()
  const front = meshFromPieces(inside, `${source.name || '组件'}·切件A`)
  const back = meshFromPieces(outside, `${source.name || '组件'}·切件B`)
  for (const piece of [...inside, ...outside]) piece.geometry.dispose()
  if (!front || !back) {
    if (front) disposeObject(front, { keepMaterials: true })
    if (back) disposeObject(back, { keepMaterials: true })
    toast('warn', '切割平面没有穿过所选网格')
    return
  }
  installSplitMeshes(source, [front, back], '平面拆分物体')
  setCutPlaneVisible(false)
  toast('ok', '已用切割平面把原组件替换为切件 A 与切件 B')
}

/** 按材质组或拓扑连通壳体拆分一个聚合网格。 */
export function splitSelectedObject(mode: 'material' | 'connected'): void {
  if (!character) return
  const source = selectedStaticObjectMesh()
  if (!source) return
  const baked = bakeMeshesStatic(source, character.model)
  const outputs = mode === 'connected'
    ? splitPiecesByConnectedComponents(baked)
    : baked.map((piece) => ({ geometry: piece.geometry.clone(), material: piece.material }))
  for (const piece of baked) piece.geometry.dispose()
  if (outputs.length < 2) {
    for (const piece of outputs) piece.geometry.dispose()
    toast('info', mode === 'material' ? '这个网格只有一个材质组' : '这个网格只有一个连通壳体')
    return
  }
  const meshes = outputs.map((piece, index) => {
    const mesh = new THREE.Mesh(piece.geometry, piece.material)
    mesh.name = `${source.name || '组件'}·${mode === 'material' ? '材质' : '壳体'}${index + 1}`
    mesh.castShadow = source.castShadow
    mesh.receiveShadow = source.receiveShadow
    return mesh
  })
  installSplitMeshes(source, meshes, mode === 'material' ? '按材质拆分' : '按连通块拆分')
  toast('ok', `已拆成 ${meshes.length} 个独立网格组件`)
}

interface SculptVertex {
  index: number
  weight: number
}

interface SculptStroke {
  mesh: THREE.Mesh
  position: THREE.BufferAttribute
  before: Float32Array
  startX: number
  startY: number
  vertices: SculptVertex[]
  hitPoint: THREE.Vector3
  hitNormal: THREE.Vector3
  dragPlane: THREE.Plane
  dragStart: THREE.Vector3
  neighbors: Map<number, Set<number>>
}

let sculptStroke: SculptStroke | null = null
let sculptCursor: THREE.LineLoop | null = null

function canvasRay(clientX: number, clientY: number): THREE.Raycaster | null {
  if (!engine) return null
  const rect = engine.renderer.domElement.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ),
    engine.camera,
  )
  return raycaster
}

function ensureSculptCursor(): THREE.LineLoop | null {
  if (!engine) return null
  if (sculptCursor) return sculptCursor
  const points = Array.from({ length: 64 }, (_value, index) => {
    const angle = (index / 64) * Math.PI * 2
    return new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0)
  })
  sculptCursor = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: '#e4b86b',
      transparent: true,
      opacity: 0.75,
      depthTest: false,
    }),
  )
  sculptCursor.name = 'SculptBrushCursor'
  sculptCursor.visible = false
  sculptCursor.renderOrder = 1000
  engine.scene.add(sculptCursor)
  return sculptCursor
}

function updateSculptCursor(clientX: number, clientY: number): THREE.Intersection | null {
  const mesh = selectedStaticObjectMeshQuiet()
  const ray = canvasRay(clientX, clientY)
  const cursor = ensureSculptCursor()
  if (!mesh || !ray || !cursor) {
    if (cursor) cursor.visible = false
    return null
  }
  mesh.updateWorldMatrix(true, false)
  const hit = ray.intersectObject(mesh, false)[0]
  if (!hit?.face) {
    cursor.visible = false
    return null
  }
  const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld)
  cursor.position.copy(hit.point).addScaledVector(normal, 0.002)
  cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
  cursor.scale.setScalar(useEditor.getState().sculptRadius)
  cursor.visible = true
  return hit
}

function selectedStaticObjectMeshQuiet(): THREE.Mesh | null {
  const selection = useEditor.getState().selection
  const objectId = selection?.kind === 'object' && selection.id
    ? selection.id
    : useEditor.getState().objectSelectedIds[0]
  const mesh = objectId
    ? editableObjectById(objectId) as THREE.Mesh | null
    : null
  return mesh?.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh ? mesh : null
}

function readPositions(position: THREE.BufferAttribute): Float32Array {
  const values = new Float32Array(position.count * 3)
  for (let index = 0; index < position.count; index += 1) {
    values[index * 3] = position.getX(index)
    values[index * 3 + 1] = position.getY(index)
    values[index * 3 + 2] = position.getZ(index)
  }
  return values
}

function applyPositions(mesh: THREE.Mesh, position: THREE.BufferAttribute, values: Float32Array): void {
  for (let index = 0; index < position.count; index += 1) {
    position.setXYZ(index, values[index * 3], values[index * 3 + 1], values[index * 3 + 2])
  }
  position.needsUpdate = true
  mesh.geometry.computeVertexNormals()
  mesh.geometry.computeBoundingBox()
  mesh.geometry.computeBoundingSphere()
}

function buildVertexNeighbors(geometry: THREE.BufferGeometry): Map<number, Set<number>> {
  const neighbors = new Map<number, Set<number>>()
  const count = geometry.getAttribute('position')?.count ?? 0
  const index = geometry.getIndex()
  const add = (left: number, right: number) => {
    const set = neighbors.get(left) ?? new Set<number>()
    set.add(right)
    neighbors.set(left, set)
  }
  const triangleCount = Math.floor((index?.count ?? count) / 3)
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const values = [0, 1, 2].map((offset) => (
      index ? index.getX(triangle * 3 + offset) : triangle * 3 + offset
    ))
    add(values[0], values[1]); add(values[0], values[2])
    add(values[1], values[0]); add(values[1], values[2])
    add(values[2], values[0]); add(values[2], values[1])
  }
  return neighbors
}

/** 仅更新笔刷预览，不修改网格。 */
export function hoverObjectSculpt(clientX: number, clientY: number): void {
  if (useEditor.getState().objectTool !== 'sculpt' || sculptStroke) return
  updateSculptCursor(clientX, clientY)
}

/** 开始一笔雕刻；一次按下到松开只写入一条撤销记录。 */
export function beginObjectSculpt(clientX: number, clientY: number): boolean {
  if (useEditor.getState().workspaceMode !== 'object' || useEditor.getState().objectTool !== 'sculpt') return false
  const mesh = selectedStaticObjectMesh()
  if (!mesh) return false
  const hit = updateSculptCursor(clientX, clientY)
  if (!hit?.face || !engine) return false

  if (!mesh.userData.characterForgeSculptGeometry) {
    const geometry = mesh.geometry.clone()
    const source = geometry.getAttribute('position') as THREE.BufferAttribute
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(readPositions(source), 3))
    mesh.geometry = geometry
    mesh.userData.characterForgeSculptGeometry = true
  }
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const before = readPositions(position)
  const radius = useEditor.getState().sculptRadius
  const vertices: SculptVertex[] = []
  const local = new THREE.Vector3()
  const world = new THREE.Vector3()
  mesh.updateWorldMatrix(true, false)
  for (let index = 0; index < position.count; index += 1) {
    local.fromArray(before, index * 3)
    world.copy(local).applyMatrix4(mesh.matrixWorld)
    const distance = world.distanceTo(hit.point)
    if (distance > radius) continue
    const falloff = 1 - distance / radius
    vertices.push({ index, weight: falloff * falloff * (3 - 2 * falloff) })
  }
  if (!vertices.length) return false

  const hitNormal = hit.face.normal.clone().transformDirection(mesh.matrixWorld)
  const cameraNormal = engine.camera.getWorldDirection(new THREE.Vector3())
  const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraNormal, hit.point)
  const dragStart = raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3()) ?? hit.point.clone()
  sculptStroke = {
    mesh,
    position,
    before,
    startX: clientX,
    startY: clientY,
    vertices,
    hitPoint: hit.point.clone(),
    hitNormal,
    dragPlane,
    dragStart,
    neighbors: buildVertexNeighbors(mesh.geometry),
  }
  return true
}

export function moveObjectSculpt(clientX: number, clientY: number): void {
  const stroke = sculptStroke
  if (!stroke || !engine) {
    hoverObjectSculpt(clientX, clientY)
    return
  }
  const state = useEditor.getState()
  const output = stroke.before.slice()
  const radius = state.sculptRadius
  const vertical = (stroke.startY - clientY) * radius * 0.012 * state.sculptStrength
  const invWorld = stroke.mesh.matrixWorld.clone().invert()
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(stroke.mesh.matrixWorld)
  const local = new THREE.Vector3()
  const world = new THREE.Vector3()
  const target = new THREE.Vector3()
  const neighborPosition = new THREE.Vector3()
  const localNormal = new THREE.Vector3()

  let dragDelta = new THREE.Vector3()
  if (state.sculptBrush === 'grab') {
    const ray = canvasRay(clientX, clientY)
    const point = ray?.ray.intersectPlane(stroke.dragPlane, new THREE.Vector3())
    if (point) dragDelta = point.sub(stroke.dragStart)
  }

  for (const vertex of stroke.vertices) {
    const offset = vertex.index * 3
    local.fromArray(stroke.before, offset)
    world.copy(local).applyMatrix4(stroke.mesh.matrixWorld)
    if (state.sculptBrush === 'grab') {
      target.copy(world).addScaledVector(dragDelta, vertex.weight)
      local.copy(target).applyMatrix4(invWorld)
    } else if (state.sculptBrush === 'inflate') {
      const normal = stroke.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute
      localNormal.fromBufferAttribute(normal, vertex.index).applyMatrix3(normalMatrix).normalize()
      target.copy(world).addScaledVector(localNormal, vertical * vertex.weight)
      local.copy(target).applyMatrix4(invWorld)
    } else if (state.sculptBrush === 'extend') {
      target.copy(world).addScaledVector(stroke.hitNormal, vertical * 1.5 * vertex.weight)
      local.copy(target).applyMatrix4(invWorld)
    } else if (state.sculptBrush === 'flatten') {
      const distance = stroke.hitNormal.dot(world.clone().sub(stroke.hitPoint))
      const factor = THREE.MathUtils.clamp(Math.abs(vertical) / Math.max(radius, 1e-6), 0, 1)
        * state.sculptStrength * vertex.weight
      target.copy(world).addScaledVector(stroke.hitNormal, -distance * factor)
      local.copy(target).applyMatrix4(invWorld)
    } else {
      const neighbors = stroke.neighbors.get(vertex.index)
      if (!neighbors?.size) continue
      target.set(0, 0, 0)
      for (const neighbor of neighbors) {
        neighborPosition.fromArray(stroke.before, neighbor * 3)
        target.add(neighborPosition)
      }
      target.multiplyScalar(1 / neighbors.size)
      const factor = THREE.MathUtils.clamp(Math.abs(vertical) / Math.max(radius, 1e-6), 0, 1)
        * state.sculptStrength * vertex.weight
      local.lerp(target, factor)
    }
    output[offset] = local.x
    output[offset + 1] = local.y
    output[offset + 2] = local.z
  }
  applyPositions(stroke.mesh, stroke.position, output)
  markObjectDirty()
}

export function endObjectSculpt(): void {
  const stroke = sculptStroke
  sculptStroke = null
  if (!stroke) return
  const after = readPositions(stroke.position)
  let changed = false
  for (let index = 0; index < after.length; index += 1) {
    if (Math.abs(after[index] - stroke.before[index]) > 1e-8) {
      changed = true
      break
    }
  }
  if (!changed) return
  const apply = (values: Float32Array) => {
    applyPositions(stroke.mesh, stroke.position, values)
    markObjectDirty()
  }
  pushCommand({
    label: '雕刻网格',
    undo: () => apply(stroke.before),
    redo: () => apply(after),
  })
  syncObjectNodes()
}

export async function saveObjectToLibrary(): Promise<void> {
  const state = useEditor.getState()
  if (!character || !engine || state.workspaceMode !== 'object') return
  if (state.objectNodes.length === 0) {
    toast('warn', '空白物体没有可保存的网格；请先添加基础形状')
    return
  }
  const name = character.name.trim() || '未命名物体'
  try {
    const blob = await exportGlbBlob(character.root)
    const thumb = renderThumbnail(character.root)
    engine.scene.add(character.root)
    const sourceId = state.objectSourceAssetId
    const sourceMeta = sourceId ? libraryAssetById(sourceId) : undefined
    const kind = state.objectSourceKind ?? 'prop'
    const replaced = sourceId && sourceMeta && !sourceMeta.system && !sourceMeta.builtin
      ? await useLibrary.getState().replaceAssetContent(sourceId, blob, { name, kind, thumb })
      : false
    if (replaced) {
      toast('ok', `已保存「${name}」的修改`)
    } else {
      const id = await useLibrary.getState().addGeneratedAsset(blob, name, kind, { thumb })
      useEditor.setState({ objectSourceAssetId: id, objectSourceKind: kind })
      toast('ok', `已把「${name}」保存为新的物品资产`)
    }
    useEditor.setState({ objectDirty: false })
  } catch (error) {
    console.error(error)
    toast('err', `保存物体失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

export async function exportObjectGlb(): Promise<void> {
  const state = useEditor.getState()
  if (!character || state.workspaceMode !== 'object' || state.objectNodes.length === 0) {
    toast('warn', '当前没有可导出的物体网格')
    return
  }
  try {
    const blob = await exportGlbBlob(character.root)
    downloadBlob(blob, `${character.name.trim() || '未命名物体'}.glb`)
    toast('ok', '物体 GLB 已导出')
  } catch (error) {
    console.error(error)
    toast('err', `导出物体失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

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
  const meta = libraryAssetById(assetId)
  if (!meta) return

  try {
    const srcMapKnown = null as ReturnType<typeof autoMapBones> | null
    const blob = await resolveAssetBlob(meta)
    if (!blob) throw new Error('找不到资源文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)
    if (parsed.clips.length === 0) throw new Error('文件里没有动画片段')
    const srcRoot: THREE.Object3D = parsed.object
    const clips: THREE.AnimationClip[] = parsed.clips
    const disposable: THREE.Object3D | null = parsed.object

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
        const directClip = adjustClipHipHeight(clip, char)
        if (meta.system && clips.length === 1) directClip.name = meta.name
        added.push(char.addClip(directClip, '直接绑定'))
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
        outName: meta.system && clips.length === 1 ? meta.name : clip.name,
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
  markObjectDirty()
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

export function setCharacterTransform(patch: Partial<TransformInfo>): void {
  if (!character) return
  const before = rootSnapshot()
  const t = useEditor.getState().transform
  const next = { ...t, ...patch }
  const root = character.root
  root.position.set(next.px, next.py, next.pz)
  root.rotation.set(
    THREE.MathUtils.degToRad(next.rx),
    THREE.MathUtils.degToRad(next.ry),
    THREE.MathUtils.degToRad(next.rz),
  )

  const changedScale = (['sx', 'sy', 'sz'] as const)
    .find((key) => patch[key] !== undefined)
  if (changedScale) {
    const axis = changedScale === 'sx' ? 'x' : changedScale === 'sy' ? 'y' : 'z'
    const target = Math.max(0.001, Number(patch[changedScale]))
    if (useEditor.getState().uniformScale) {
      const previous = Math.max(0.000001, Math.abs(root.scale[axis]))
      root.scale.multiplyScalar(target / previous)
      root.scale.set(
        Math.max(0.001, Math.abs(root.scale.x)),
        Math.max(0.001, Math.abs(root.scale.y)),
        Math.max(0.001, Math.abs(root.scale.z)),
      )
    } else {
      root.scale.set(
        Math.max(0.001, next.sx),
        Math.max(0.001, next.sy),
        Math.max(0.001, next.sz),
      )
    }
  }
  syncTransformMirror()
  markObjectDirty()
  refreshSelectionVisuals()
  pushRootCmd(
    useEditor.getState().workspaceMode === 'object' ? '调整物体整体' : '调整角色变换',
    before,
    'char:tf',
  )
}

export function groundCharacter(withUndo = true): void {
  if (!character) return
  const before = withUndo ? rootSnapshot() : null
  const box = new THREE.Box3().setFromObject(character.root)
  if (!box.isEmpty()) character.root.position.y -= box.min.y
  syncTransformMirror()
  markObjectDirty()
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
  markObjectDirty()
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
  markObjectDirty()
  pushRootCmd('重置变换', before)
}

/**
 * 修正导入文件内部自带的偏移：保持网格、骨架和蒙皮之间的关系不变，
 * 仅移动它们共同的 model 节点，使人物水平居中并落在世界原点。
 */
export function resetModelPlacement(): void {
  if (!character) return
  const char = character
  const before = char.model.position.clone()
  const result = centerObjectOnGround(
    char.model,
    char.attachments.map((attachment) => attachment.object),
  )
  if (!result) {
    toast('warn', '当前角色没有可用于归位的可见网格')
    return
  }
  const after = char.model.position.clone()
  if (before.distanceToSquared(after) < 1e-12) {
    toast('info', '模型已经位于默认原点，无需调整')
    return
  }

  const apply = (position: THREE.Vector3) => {
    char.model.position.copy(position)
    char.root.updateWorldMatrix(true, true)
    if (character === char) {
      markObjectDirty()
      updateBoneOverlay()
      refreshSelectionVisuals()
    }
  }
  apply(after)
  pushCommand({
    label: '模型归位到原点',
    undo: () => apply(before),
    redo: () => apply(after),
  })
  engine?.frameObject(char.root)
  const centimeters = result.offset.clone().multiplyScalar(100)
  toast(
    'ok',
    `模型已居中并落地（修正 X ${centimeters.x.toFixed(1)} / Y ${centimeters.y.toFixed(1)} / Z ${centimeters.z.toFixed(1)} cm）`,
  )
}

export function resetPose(): void {
  if (!character) return
  stopPlayback()
  character.resetPose()
  useEditor.setState({ referencePose: 'source' })
  syncBoneTransform()
  updateBoneOverlay()
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
      if (useEditor.getState().workspaceMode === 'object') {
        syncObjectNodes()
        markObjectDirty()
      }
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
      markObjectDirty()
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

function materialById(materialId: string): THREE.Material | null {
  let found: THREE.Material | null = null
  character?.model.traverse((object) => {
    if (found) return
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    found = materials.find((material) => material?.uuid === materialId) ?? null
  })
  return found
}

function applyMaterialTexture(
  material: THREE.Material,
  slot: MaterialTextureSlot,
  texture: THREE.Texture | null,
): void {
  if (!(slot in material)) throw new Error('当前材质不支持这个贴图槽位')
  ;(material as unknown as Record<MaterialTextureSlot, THREE.Texture | null>)[slot] = texture
  material.needsUpdate = true
  useEditor.setState({ materials: collectMaterialInfos() })
  markObjectDirty()
}

/** 在单物体编辑器里给材质加入颜色、法线、粗糙度或金属度贴图。 */
export async function setMaterialTexture(
  materialId: string,
  slot: MaterialTextureSlot,
  file: File,
): Promise<void> {
  if (useEditor.getState().workspaceMode !== 'object') return
  if (!file.type.startsWith('image/')) {
    toast('warn', '贴图必须是 PNG、JPG、WEBP 等图片文件')
    return
  }
  if (file.size > 64 * 1024 * 1024) {
    toast('warn', '单张贴图不能超过 64 MiB，请先压缩图片')
    return
  }
  const material = materialById(materialId)
  if (!material) return
  const previous = (material as unknown as Partial<Record<MaterialTextureSlot, THREE.Texture | null>>)[slot] ?? null
  const url = URL.createObjectURL(file)
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url)
    texture.name = file.name
    texture.flipY = false
    texture.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.anisotropy = engine?.renderer.capabilities.getMaxAnisotropy() ?? 1
    texture.needsUpdate = true
    applyMaterialTexture(material, slot, texture)
    pushCommand({
      label: `添加${slot === 'map' ? '颜色' : slot === 'normalMap' ? '法线' : slot === 'roughnessMap' ? '粗糙度' : '金属度'}贴图`,
      undo: () => applyMaterialTexture(material, slot, previous),
      redo: () => applyMaterialTexture(material, slot, texture),
    })
    toast('ok', `已应用贴图「${file.name}」`)
  } catch (error) {
    console.error(error)
    toast('err', `贴图加载失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function clearMaterialTexture(materialId: string, slot: MaterialTextureSlot): void {
  const material = materialById(materialId)
  if (!material) return
  const previous = (material as unknown as Partial<Record<MaterialTextureSlot, THREE.Texture | null>>)[slot] ?? null
  if (!previous) return
  applyMaterialTexture(material, slot, null)
  pushCommand({
    label: '移除材质贴图',
    undo: () => applyMaterialTexture(material, slot, previous),
    redo: () => applyMaterialTexture(material, slot, null),
  })
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
  const meta = libraryAssetById(assetId)
  if (!meta) return

  try {
    const blob = await resolveAssetBlob(meta)
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
      sourceAssetId: assetId,
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

function deactivateHeadReplacement(char: Character, state: HeadReplacementState): void {
  for (const record of state.records) {
    record.mesh.geometry = record.originalGeometry
    record.mesh.visible = record.originalVisible
  }
  if (char.attachments.includes(state.attachment)) char.detach(state.attachment.id, false)
  char.model.updateWorldMatrix(true, true)
}

function activateHeadReplacement(char: Character, state: HeadReplacementState): void {
  for (const record of state.records) {
    if (record.derivedGeometry) record.mesh.geometry = record.derivedGeometry
    else record.mesh.visible = false
  }
  if (!char.attachments.includes(state.attachment)) char.reattach(state.attachment)
  char.model.updateWorldMatrix(true, true)
}

/**
 * 静态头雕替换：隐藏或派生裁掉原头部，头雕作为独立 head_component 挂到 head 骨骼。
 * 源模型与源几何体不被覆盖，撤销会恢复原头。
 */
export async function replaceHeadWithAsset(assetId: string): Promise<void> {
  if (!engine || !character?.rig) {
    toast('warn', '请先加载带 Manny / UEFN 骨骼的基础角色')
    return
  }
  const char = character
  const rig = char.rig!
  const headBone = char.slotBone('head') || rig.byName.get('head')
  if (!headBone) {
    toast('err', '当前骨架缺少 head（头部）骨骼')
    return
  }
  const meta = libraryAssetById(assetId)
  if (!meta || meta.kind === 'anim') {
    toast('warn', '请选择静态模型或物品作为头雕')
    return
  }

  try {
    const blob = await resolveAssetBlob(meta)
    if (!blob) throw new Error('找不到头雕文件内容')
    const parsed = await parseAssetFile(await blob.arrayBuffer(), `${meta.name}.${meta.format}`)
    if (parsed.boneNames.length || parsed.hasSkinnedMesh || parsed.clips.length) {
      disposeObject(parsed.object)
      throw new Error('头部替换只接受不带骨骼和动画的静态网格体')
    }

    const previous = headStateByCharacter.get(char) ?? null
    if (previous) deactivateHeadReplacement(char, previous)

    const records: HeadGeometryRecord[] = []
    const referenceBounds = new THREE.Box3()
    let removedFaces = 0
    let hiddenMeshes = 0
    const meshes: THREE.Mesh[] = []
    char.model.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh)
    })
    for (const mesh of meshes) {
      const key = normalizedBoneName(mesh.name)
      const namedHead = /(head|face)/.test(key) && meshes.length > 1
      const derived = (mesh as THREE.SkinnedMesh).isSkinnedMesh && !namedHead
        ? geometryWithoutHead(mesh as THREE.SkinnedMesh, headBone)
        : null
      if (!namedHead && !derived) continue
      records.push({
        mesh,
        originalGeometry: mesh.geometry,
        originalVisible: mesh.visible,
        derivedGeometry: derived?.geometry ?? null,
      })
      if (namedHead) {
        referenceBounds.union(new THREE.Box3().setFromObject(mesh))
        mesh.visible = false
        hiddenMeshes += 1
      } else if (derived) {
        mesh.geometry = derived.geometry
        removedFaces += derived.removedFaces
        if (!derived.headBounds.isEmpty()) referenceBounds.union(derived.headBounds)
      }
    }

    const baseBounds = new THREE.Box3().setFromObject(char.root)
    const baseSize = baseBounds.getSize(new THREE.Vector3())
    const targetHeight = Math.max(
      referenceBounds.isEmpty() ? baseSize.y * 0.14 : referenceBounds.getSize(new THREE.Vector3()).y,
      0.001,
    )
    const attachment = char.attach(parsed.object, headBone, meta.name, {
      px: 0, py: 0, pz: 0,
      rx: 0, ry: 0, rz: 0,
      scale: 1,
      role: 'head_component',
      sourceAssetId: assetId,
    })
    let headBounds = new THREE.Box3().setFromObject(attachment.object)
    const extent = headBounds.getSize(new THREE.Vector3())
    const sourceExtent = Math.max(extent.x, extent.y, extent.z, 0.001)
    attachment.info.scale = THREE.MathUtils.clamp(targetHeight / sourceExtent, 0.0001, 50)
    char.applyAttachmentOffset(attachment)
    attachment.object.updateWorldMatrix(true, true)
    headBounds = new THREE.Box3().setFromObject(attachment.object)

    const targetCenter = referenceBounds.isEmpty()
      ? headBone.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, targetHeight * 0.35, 0))
      : referenceBounds.getCenter(new THREE.Vector3()).add(new THREE.Vector3(0, -targetHeight * 0.1, 0))
    const currentCenter = headBounds.getCenter(new THREE.Vector3())
    const desiredLocal = attachment.socket.worldToLocal(targetCenter.clone())
    const currentLocal = attachment.socket.worldToLocal(currentCenter.clone())
    attachment.object.position.add(desiredLocal.sub(currentLocal))
    attachment.info.px = attachment.object.position.x * 100
    attachment.info.py = attachment.object.position.y * 100
    attachment.info.pz = attachment.object.position.z * 100
    char.applyAttachmentOffset(attachment)

    const next: HeadReplacementState = { attachment, records }
    headStateByCharacter.set(char, next)
    syncAttachments()
    syncCharacter()
    select({ kind: 'attachment', id: attachment.id })
    pushCommand({
      label: `替换头部为 ${meta.name}`,
      undo: () => {
        deactivateHeadReplacement(char, next)
        if (previous) {
          activateHeadReplacement(char, previous)
          headStateByCharacter.set(char, previous)
        } else {
          headStateByCharacter.delete(char)
        }
        if (character === char) {
          syncAttachments()
          select({ kind: 'character' })
        }
      },
      redo: () => {
        if (previous) deactivateHeadReplacement(char, previous)
        activateHeadReplacement(char, next)
        headStateByCharacter.set(char, next)
        if (character === char) {
          syncAttachments()
          select({ kind: 'attachment', id: next.attachment.id })
        }
      },
    })
    toast(
      records.length
        ? 'ok'
        : 'warn',
      records.length
        ? `头部已替换：裁掉 ${removedFaces} 个面，隐藏 ${hiddenMeshes} 个独立头部网格`
        : '头雕已挂接，但未识别到可隐藏的原头部；可在“部件显隐”中手动隐藏原头网格',
    )
  } catch (error) {
    console.error(error)
    toast('err', `换头失败：${error instanceof Error ? error.message : '未知错误'}`)
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
  const rig = activeRig()
  if (!engine || !rig || skeletonHelper) return
  const bones = rig.bones
  const boneSet = new Set(bones)
  const lineBones: [THREE.Bone, THREE.Bone][] = []
  for (const bone of bones) {
    const parent = bone.parent as THREE.Bone | null
    if (parent?.isBone && boneSet.has(parent)) lineBones.push([parent, bone])
  }

  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(lineBones.length * 6), 3))
  lineGeometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(lineBones.length * 6), 3))
  const lines = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      depthWrite: false,
    }),
  )
  lines.renderOrder = 900

  const pointGeometry = new THREE.BufferGeometry()
  pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(bones.length * 3), 3))
  pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(bones.length * 3), 3))
  const points = new THREE.Points(
    pointGeometry,
    new THREE.PointsMaterial({
      size: 6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.94,
      depthTest: false,
      depthWrite: false,
    }),
  )
  points.renderOrder = 901

  const group = new THREE.Group()
  group.name = 'CharacterBoneOverlay'
  group.add(lines, points)
  engine.scene.add(group)
  skeletonHelper = { group, lines, points, bones, lineBones }
  updateBoneOverlay()
  updateBoneOverlayColors()
}

function removeSkeletonHelper(): void {
  if (skeletonHelper) {
    skeletonHelper.group.removeFromParent()
    skeletonHelper.lines.geometry.dispose()
    ;(skeletonHelper.lines.material as THREE.Material).dispose()
    skeletonHelper.points.geometry.dispose()
    ;(skeletonHelper.points.material as THREE.Material).dispose()
    skeletonHelper = null
  }
}

function updateBoneOverlay(): void {
  if (!skeletonHelper) return
  syncRigFitContainer()
  activeRig()?.root.updateWorldMatrix(true, true)
  const pointPosition = skeletonHelper.points.geometry.getAttribute('position') as THREE.BufferAttribute
  const world = new THREE.Vector3()
  skeletonHelper.bones.forEach((bone, index) => {
    bone.getWorldPosition(world)
    pointPosition.setXYZ(index, world.x, world.y, world.z)
  })
  pointPosition.needsUpdate = true

  const linePosition = skeletonHelper.lines.geometry.getAttribute('position') as THREE.BufferAttribute
  skeletonHelper.lineBones.forEach(([parent, child], index) => {
    parent.getWorldPosition(world)
    linePosition.setXYZ(index * 2, world.x, world.y, world.z)
    child.getWorldPosition(world)
    linePosition.setXYZ(index * 2 + 1, world.x, world.y, world.z)
  })
  linePosition.needsUpdate = true
}

function updateBoneOverlayColors(): void {
  if (!skeletonHelper) return
  const selected = useEditor.getState().selection
  const pointColor = skeletonHelper.points.geometry.getAttribute('color') as THREE.BufferAttribute
  const lineColor = skeletonHelper.lines.geometry.getAttribute('color') as THREE.BufferAttribute
  const normalPoint = new THREE.Color('#a9c8ef')
  const normalLine = new THREE.Color('#94b9e8')
  const active = new THREE.Color('#ffc766')
  const selectedBoneName = selected?.kind === 'bone' ? selected.id : null
  skeletonHelper.bones.forEach((bone, index) => {
    const value = selectedBoneName === bone.name ? active : normalPoint
    pointColor.setXYZ(index, value.r, value.g, value.b)
  })
  skeletonHelper.lineBones.forEach(([parent, child], index) => {
    const value = selectedBoneName === parent.name || selectedBoneName === child.name
      ? active
      : normalLine
    lineColor.setXYZ(index * 2, value.r, value.g, value.b)
    lineColor.setXYZ(index * 2 + 1, value.r, value.g, value.b)
  })
  pointColor.needsUpdate = true
  lineColor.needsUpdate = true
}

export function toggleSkeleton(): void {
  if (rigFitSession && useEditor.getState().showSkeleton) {
    toast('info', '骨架适配时需要显示关节点；完成或取消后可隐藏')
    return
  }
  const next = !useEditor.getState().showSkeleton
  useEditor.setState({ showSkeleton: next })
  if (next) addSkeletonHelper()
  else removeSkeletonHelper()
}

export function selectBone(boneName: string): void {
  if (!activeRig()?.byName.has(boneName)) return
  if (!useEditor.getState().showSkeleton) {
    useEditor.setState({ showSkeleton: true })
    addSkeletonHelper()
  }
  select({ kind: 'bone', id: boneName })
}

function captureRigLocalPose(): Map<THREE.Bone, { pos: THREE.Vector3; quat: THREE.Quaternion }> {
  const pose = new Map<THREE.Bone, { pos: THREE.Vector3; quat: THREE.Quaternion }>()
  for (const bone of character?.rig?.bones || []) {
    pose.set(bone, { pos: bone.position.clone(), quat: bone.quaternion.clone() })
  }
  return pose
}

function restoreRigLocalPose(pose: Map<THREE.Bone, { pos: THREE.Vector3; quat: THREE.Quaternion }>): void {
  for (const [bone, transform] of pose) {
    bone.position.copy(transform.pos)
    bone.quaternion.copy(transform.quat)
  }
  character?.model.updateWorldMatrix(true, true)
  syncBoneTransform()
  updateBoneOverlay()
}

/** 应用经过真实基准骨架签名校验的 Source / T / A Pose（姿势）。 */
export async function setReferencePose(poseName: ReferencePoseName): Promise<void> {
  if (!character?.rig) {
    toast('warn', '当前角色没有骨骼')
    return
  }
  const char = character
  const rig = char.rig!
  const before = captureRigLocalPose()
  const beforeName = useEditor.getState().referencePose
  try {
    char.stop()
    useEditor.setState({
      playback: { ...DEFAULT_PLAYBACK },
      animationEditTracks: 0,
    })
    if (poseName === 'source') {
      for (const bone of rig.bones) {
        const bind = rig.bindLocal.get(bone)
        if (!bind) continue
        bone.position.copy(bind.pos)
        bone.quaternion.copy(bind.quat)
        bone.scale.copy(bind.scale)
      }
    } else {
      const profileId = char.skeletonProfileId
      if (!profileId) {
        throw new Error('该角色不是已验证的 Manny / UEFN 基准；为避免再次扭曲，不会推算 T/A Pose')
      }
      const payload = await loadReferencePoseProfiles()
      const profile = payload.profiles[profileId]
      if (!profile) throw new Error(`没有 ${profileId} 的参考姿势`)
      applyVerifiedReferencePose(rig, profileId, profile, poseName)
    }
    char.model.updateWorldMatrix(true, true)
    const after = captureRigLocalPose()
    useEditor.setState({ referencePose: poseName })
    syncBoneTransform()
    updateBoneOverlay()
    pushCommand({
      label: `切换 ${poseName === 'source' ? '原始' : poseName.toUpperCase()} Pose`,
      undo: () => {
        restoreRigLocalPose(before)
        useEditor.setState({ referencePose: beforeName })
      },
      redo: () => {
        restoreRigLocalPose(after)
        useEditor.setState({ referencePose: poseName })
      },
    })
    toast('ok', `已切换到${poseName === 'source' ? '原始绑定姿势' : `${poseName.toUpperCase()} Pose`}`)
  } catch (error) {
    restoreRigLocalPose(before)
    toast('err', error instanceof Error ? error.message : '参考姿势应用失败')
  }
}

export function setSelectedBoneTransform(patch: Partial<TransformInfo>): void {
  const selection = useEditor.getState().selection
  const rig = activeRig()
  if (selection?.kind !== 'bone' || !selection.id || !rig) return
  const bone = rig.byName.get(selection.id)
  if (!bone) return
  const before = {
    pos: bone.position.clone(),
    quat: bone.quaternion.clone(),
  }
  const fitting = Boolean(rigFitSession)
  const canMove = fitting || selection.id === character?.boneMap.root || selection.id === character?.boneMap.hips
  if (canMove) {
    if (patch.px !== undefined) bone.position.x = patch.px
    if (patch.py !== undefined) bone.position.y = patch.py
    if (patch.pz !== undefined) bone.position.z = patch.pz
  }
  if (!fitting) {
    const rotation = new THREE.Euler(
      THREE.MathUtils.degToRad(patch.rx ?? THREE.MathUtils.radToDeg(bone.rotation.x)),
      THREE.MathUtils.degToRad(patch.ry ?? THREE.MathUtils.radToDeg(bone.rotation.y)),
      THREE.MathUtils.degToRad(patch.rz ?? THREE.MathUtils.radToDeg(bone.rotation.z)),
      bone.rotation.order,
    )
    bone.quaternion.setFromEuler(rotation)
  }
  const after = {
    pos: bone.position.clone(),
    quat: bone.quaternion.clone(),
  }
  rig.root.updateWorldMatrix(true, true)
  if (fitting) markRigFitBoneAdjusted(bone.name)
  syncBoneTransform()
  updateBoneOverlay()
  pushCommand({
    label: fitting ? `调整适配点 ${bone.name}` : `调整骨骼 ${bone.name}`,
    key: `${fitting ? 'rig-fit' : 'bone'}:${bone.uuid}`,
    undo: () => {
      bone.position.copy(before.pos)
      bone.quaternion.copy(before.quat)
      rig.root.updateWorldMatrix(true, true)
      if (rigFitSession) markRigFitBoneAdjusted(bone.name)
      syncBoneTransform()
      updateBoneOverlay()
    },
    redo: () => {
      bone.position.copy(after.pos)
      bone.quaternion.copy(after.quat)
      rig.root.updateWorldMatrix(true, true)
      if (rigFitSession) markRigFitBoneAdjusted(bone.name)
      syncBoneTransform()
      updateBoneOverlay()
    },
  })
}
function installClipVersion(char: Character, owned: OwnedClip, clip: THREE.AnimationClip, time: number, playing: boolean): void {
  char.mixer.stopAllAction()
  char.mixer.uncacheClip(owned.clip)
  owned.clip = clip
  char.play(owned.id, {
    speed: useEditor.getState().playback.speed,
    loop: useEditor.getState().playback.loop,
    inPlace: useEditor.getState().playback.inPlace,
  })
  if (char.currentAction) {
    char.currentAction.time = Math.min(time, clip.duration)
    char.currentAction.paused = !playing
    char.mixer.update(0)
  }
  useEditor.setState({
    clips: char.clipInfos(),
    playback: {
      ...useEditor.getState().playback,
      clipId: owned.id,
      duration: clip.duration,
      time: Math.min(time, clip.duration),
      playing,
    },
  })
}

/** 把选中骨骼当前局部姿势写入时间轴当前时间。 */
export function setSelectedBoneKeyframe(): void {
  const selection = useEditor.getState().selection
  const playback = useEditor.getState().playback
  if (selection?.kind !== 'bone' || !selection.id || !playback.clipId || !character?.rig) {
    toast('warn', '请先选择动画和一根骨骼')
    return
  }
  const char = character
  const rig = char.rig!
  const bone = rig.byName.get(selection.id)
  const owned = char.getClip(playback.clipId)
  if (!bone || !owned) return

  const before = owned.clip.clone()
  const layer = new AnimationEditLayer(owned.clip, owned.clip.name.replace(/（已编辑）$/, ''))
  layer.setBoneTransform(bone, 'quaternion', playback.time, bone.quaternion.toArray())
  const canMove = bone.name === char.boneMap.root || bone.name === char.boneMap.hips
  const after = canMove
    ? (layer.setBoneTransform(bone, 'position', playback.time, bone.position.toArray()), layer.compose())
    : layer.compose()
  const beforeTracks = useEditor.getState().animationEditTracks
  const afterTracks = beforeTracks + (canMove ? 2 : 1)
  installClipVersion(char, owned, after, playback.time, false)
  useEditor.setState({ animationEditTracks: afterTracks })
  pushCommand({
    label: `在 ${playback.time.toFixed(2)} 秒记录 ${bone.name}`,
    undo: () => {
      installClipVersion(char, owned, before.clone(), playback.time, false)
      useEditor.setState({ animationEditTracks: beforeTracks })
    },
    redo: () => {
      installClipVersion(char, owned, after.clone(), playback.time, false)
      useEditor.setState({ animationEditTracks: afterTracks })
    },
  })
  toast('ok', `已在 ${playback.time.toFixed(2)} 秒记录「${bone.name}」关键帧`)
}

export function resetSelectedBone(): void {
  const selection = useEditor.getState().selection
  const rig = activeRig()
  if (selection?.kind !== 'bone' || !selection.id || !rig) return
  const bone = rig.byName.get(selection.id)
  const bind = bone ? (rigFitSession?.initialLocal.get(bone) ?? rig.bindLocal.get(bone)) : null
  if (!bone || !bind) return
  setSelectedBoneTransform({
    px: bind.pos.x,
    py: bind.pos.y,
    pz: bind.pos.z,
    rx: THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(bind.quat).x),
    ry: THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(bind.quat).y),
    rz: THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(bind.quat).z),
  })
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
  downloadDataUrl(url, `characterforgelab_${Date.now()}.png`)
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
  const meta = libraryAssetById(assetId)
  if (!meta) {
    toast('err', '该资源已不存在（可能已被删除）')
    return
  }
  try {
    const blob = await resolveAssetBlob(meta)
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

let workspaceSnapshotAssetId: string | null = null

interface CharacterWorkspaceV4 {
  id?: string | null
  name: string
  schema_version: 4
  project_id: string
  baseCharacter: {
    asset_ref: { asset_id: string }
    name: string
    profile_id: string | null
    kind: 'snapshot'
    transform: TransformInfo
  }
  rig: { profile_id: string | null; quality: string } | null
  components: Array<{
    type: 'head_component' | 'attachment'
    asset_ref: { asset_id: string }
    name: string
    attachment: AttachmentInfo
  }>
  pose: { active: ReferencePoseName; profile_id: string | null }
  animationClips: Array<{
    name: string
    source: string
    clip: ReturnType<THREE.AnimationClip['toJSON']>
  }>
  selection: { type: string | null; id: string | null }
  validation: { issues: string[]; last_export: string | null }
  legacyData: null
  layers: []
  updated?: string
}

/** 保存可重新打开的人物项目；加载与保存命名明确，草稿不会冒充正式保存。 */
export async function saveCurrentCharacterWorkspace(): Promise<void> {
  if (!character || !engine) {
    toast('warn', '没有可保存的人物项目')
    return
  }
  const char = character
  const state = useEditor.getState()
  const playback = { ...state.playback }
  const localPose = captureRigLocalPose()
  const visibleSockets = char.attachments
    .filter((attachment) => attachment.socket.visible)
    .map((attachment) => attachment.socket)
  visibleSockets.forEach((socket) => {
    socket.visible = false
  })

  try {
    char.mixer.stopAllAction()
    char.resetPose()
    const blob = await exportGlbBlob(char.root, { clips: [] })
    visibleSockets.forEach((socket) => {
      socket.visible = true
    })
    const thumb = renderThumbnail(char.root)
    engine.scene.add(char.root)

    let snapshotId = workspaceSnapshotAssetId
    if (snapshotId) {
      const updated = await useLibrary.getState().replaceAssetContent(snapshotId, blob, {
        name: `${char.name}·项目基底`,
        kind: 'model',
        thumb,
      })
      if (!updated) snapshotId = null
    }
    if (!snapshotId) {
      snapshotId = await useLibrary.getState().addGeneratedAsset(
        blob,
        `${char.name}·项目基底`,
        'model',
        { thumb, bones: char.boneNames },
      )
    }
    workspaceSnapshotAssetId = snapshotId

    const issues: string[] = []
    const components = char.attachments.flatMap((attachment) => {
      const sourceAssetId = attachment.info.sourceAssetId
      if (!sourceAssetId) {
        issues.push(`组件“${attachment.name}”缺少来源资产，重开时会显示为缺失`)
        return []
      }
      return [{
        type: attachment.info.role === 'head_component' ? 'head_component' as const : 'attachment' as const,
        asset_ref: { asset_id: sourceAssetId },
        name: attachment.name,
        attachment: { ...attachment.info },
      }]
    })
    const workspace: CharacterWorkspaceV4 = {
      id: state.workspaceId,
      name: char.name,
      schema_version: 4,
      project_id: 'character-forge-lab',
      baseCharacter: {
        asset_ref: { asset_id: snapshotId },
        name: char.name,
        profile_id: char.skeletonProfileId,
        kind: 'snapshot',
        transform: { ...state.transform },
      },
      rig: char.rig
        ? { profile_id: char.skeletonProfileId, quality: 'browser_preview' }
        : null,
      components,
      pose: {
        active: state.referencePose,
        profile_id: char.skeletonProfileId,
      },
      animationClips: char.clips.map((owned) => ({
        name: owned.clip.name,
        source: owned.source,
        clip: owned.clip.toJSON(),
      })),
      selection: {
        type: state.selection?.kind || null,
        id: state.selection?.id || null,
      },
      validation: { issues, last_export: null },
      legacyData: null,
      layers: [],
    }
    const saved = await saveWorkspaceToHub(workspace)
    useEditor.setState({
      workspaceId: String(saved.id || ''),
      workspaceDirty: false,
      workspaceSavedAt: String(saved.updated || new Date().toISOString()),
    })
    toast('ok', `人物项目“${char.name}”已正式保存`)
  } catch (error) {
    console.error(error)
    toast('err', `保存人物项目失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    visibleSockets.forEach((socket) => {
      socket.visible = true
    })
    restoreRigLocalPose(localPose)
    if (playback.clipId && char.getClip(playback.clipId)) {
      const owned = char.getClip(playback.clipId)!
      installClipVersion(char, owned, owned.clip, playback.time, playback.playing)
    } else {
      useEditor.setState({ playback })
    }
  }
}

/** 从 V4 工作区重建基础角色、独立头部、挂载物和派生动画。 */
export async function openCharacterWorkspace(workspaceId: string): Promise<void> {
  try {
    const workspace = await loadWorkspaceFromHub<CharacterWorkspaceV4>(workspaceId)
    const baseAssetId = workspace.baseCharacter?.asset_ref?.asset_id
    if (!baseAssetId || !libraryAssetById(baseAssetId)) {
      throw new Error('项目基底资产已丢失；请在资源库恢复或重新定位该资产')
    }
    await useAssetAsCharacter(baseAssetId)
    if (!character) throw new Error('项目基底加载失败')
    const char = character
    workspaceSnapshotAssetId = baseAssetId
    char.name = workspace.name || char.name
    char.sourceAssetId = baseAssetId
    if (workspace.baseCharacter.transform) {
      const transform = workspace.baseCharacter.transform
      char.root.position.set(transform.px, transform.py, transform.pz)
      char.root.rotation.set(
        THREE.MathUtils.degToRad(transform.rx),
        THREE.MathUtils.degToRad(transform.ry),
        THREE.MathUtils.degToRad(transform.rz),
      )
      char.root.scale.set(transform.sx, transform.sy, transform.sz)
    }

    char.clips = []
    for (const item of workspace.animationClips || []) {
      try {
        char.addClip(THREE.AnimationClip.parse(item.clip), item.source || '人物项目')
      } catch (error) {
        console.warn('动画片段恢复失败', item.name, error)
      }
    }
    syncCharacter()

    for (const component of workspace.components || []) {
      const assetId = component.asset_ref?.asset_id
      if (!assetId || !libraryAssetById(assetId)) {
        toast('warn', `组件“${component.name}”的资产已丢失`)
        continue
      }
      if (component.type === 'head_component') {
        await replaceHeadWithAsset(assetId)
      } else {
        await mountAsset(assetId, { boneName: component.attachment.bone })
      }
      const restored = character?.attachments.find(
        (attachment) => attachment.info.sourceAssetId === assetId
          && attachment.info.role === component.attachment.role,
      )
      if (restored) updateAttachment(restored.id, component.attachment)
    }
    if (workspace.pose?.active && workspace.pose.active !== 'source') {
      await setReferencePose(workspace.pose.active)
    }
    clearHistory()
    syncCharacter()
    useEditor.setState({
      workspaceId: workspace.id || workspaceId,
      workspaceDirty: false,
      workspaceSavedAt: workspace.updated || null,
      selection: null,
    })
    engine?.frameObject(char.root)
    toast('ok', `已打开人物项目“${workspace.name}”`)
  } catch (error) {
    console.error(error)
    toast('err', `打开人物项目失败：${error instanceof Error ? error.message : '未知错误'}`)
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
  ;(window as unknown as Record<string, unknown>).__characterforgelab = {
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
