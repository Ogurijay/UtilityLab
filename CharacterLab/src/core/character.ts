import * as THREE from 'three'
import type { AttachmentInfo, BoneMap, BoneSlot, ClipInfo } from '../types'
import { autoMapBones, guessSkeletonType } from './skeletons/autoMap'
import { UE_SLOT_NAMES } from './skeletons/standard'
import { renameClipTracks } from './skeletons/retarget'
import type { Rig } from './rig'
import { buildRig, resetRigToBind } from './rig'
import { disposeObject } from './loaders'

let nextId = 1
export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${(nextId++).toString(36)}`
}

export interface OwnedClip {
  id: string
  clip: THREE.AnimationClip
  source: string
}

export interface Attachment {
  id: string
  name: string
  /** 挂在骨骼下的插槽节点（承载偏移） */
  socket: THREE.Group
  /** 插槽下的武器本体 */
  object: THREE.Object3D
  bone: THREE.Bone
  info: AttachmentInfo
}

/**
 * 场景中的角色实例：模型 + 骨架快照 + 动画混合器 + 挂载物。
 * root 是用户变换（移动/朝向/缩放）的载体，模型与骨架都在其下。
 */
export class Character {
  readonly root = new THREE.Group()
  readonly model: THREE.Object3D
  readonly mixer: THREE.AnimationMixer
  readonly rig: Rig | null
  name: string
  boneMap: BoneMap = {}
  skeletonGuess = '无骨骼'
  clips: OwnedClip[] = []
  attachments: Attachment[] = []
  currentAction: THREE.AnimationAction | null = null
  currentClipId: string | null = null

  constructor(model: THREE.Object3D, name: string) {
    this.name = name
    this.model = model
    this.root.name = `character:${name}`
    this.root.add(model)
    this.mixer = new THREE.AnimationMixer(model)
    this.rig = buildRig(model)
    if (this.rig) {
      this.boneMap = autoMapBones(this.rig.bones)
      this.skeletonGuess = guessSkeletonType(this.rig.bones.map((b) => b.name))
    }
  }

  get boneNames(): string[] {
    return this.rig ? this.rig.bones.map((b) => b.name) : []
  }

  slotBone(slot: BoneSlot): THREE.Bone | undefined {
    const name = this.boneMap[slot]
    return name && this.rig ? this.rig.byName.get(name) : undefined
  }

  addClip(clip: THREE.AnimationClip, source: string): OwnedClip {
    const owned: OwnedClip = { id: uid('clip'), clip, source }
    this.clips.push(owned)
    return owned
  }

  getClip(id: string): OwnedClip | undefined {
    return this.clips.find((c) => c.id === id)
  }

  removeClip(id: string): void {
    const owned = this.getClip(id)
    if (!owned) return
    if (this.currentClipId === id) this.stop()
    this.mixer.uncacheClip(owned.clip)
    this.clips = this.clips.filter((c) => c.id !== id)
  }

  /** 播放某条动画（inPlace 时使用去位移副本） */
  play(id: string, opts: { speed: number; loop: boolean; inPlace: boolean }): OwnedClip | null {
    const owned = this.getClip(id)
    if (!owned) return null
    const clip = opts.inPlace ? this.makeInPlaceClip(owned.clip) : owned.clip

    if (this.currentAction) {
      this.currentAction.stop()
      this.mixer.uncacheAction(this.currentAction.getClip(), this.model)
    }
    const action = this.mixer.clipAction(clip)
    action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    action.clampWhenFinished = true
    action.timeScale = opts.speed
    action.play()
    this.currentAction = action
    this.currentClipId = id
    return owned
  }

  stop(): void {
    if (this.currentAction) {
      this.currentAction.stop()
      this.mixer.uncacheAction(this.currentAction.getClip(), this.model)
    }
    this.currentAction = null
    this.currentClipId = null
    this.resetPose()
  }

  resetPose(): void {
    if (this.rig) resetRigToBind(this.rig)
  }

  /** 去掉髋部水平位移的动画副本（原地播放） */
  private inPlaceCache = new Map<THREE.AnimationClip, THREE.AnimationClip>()
  private makeInPlaceClip(clip: THREE.AnimationClip): THREE.AnimationClip {
    const cached = this.inPlaceCache.get(clip)
    if (cached) return cached
    const copy = clip.clone()
    copy.name = clip.name
    const hips = this.boneMap.hips
    for (const track of copy.tracks) {
      if (!(track instanceof THREE.VectorKeyframeTrack)) continue
      const parsed = THREE.PropertyBinding.parseTrackName(track.name)
      if (parsed.propertyName !== 'position') continue
      if (hips && parsed.nodeName !== hips) continue
      const v = track.values
      const x0 = v[0]
      const z0 = v[2]
      for (let i = 0; i < v.length; i += 3) {
        v[i] = x0
        v[i + 2] = z0
      }
    }
    this.inPlaceCache.set(clip, copy)
    return copy
  }

  /** 挂载一个对象到骨骼 */
  attach(object: THREE.Object3D, bone: THREE.Bone, name: string, info: Omit<AttachmentInfo, 'id' | 'name' | 'bone'>): Attachment {
    const socket = new THREE.Group()
    socket.name = `socket:${name}`
    // 骨骼可能带缩放（FBX 常见），先抵消，让偏移量所见即所得
    const ws = new THREE.Vector3()
    bone.getWorldScale(ws)
    const inv = new THREE.Vector3(
      ws.x !== 0 ? 1 / ws.x : 1,
      ws.y !== 0 ? 1 / ws.y : 1,
      ws.z !== 0 ? 1 / ws.z : 1,
    )
    socket.scale.copy(inv)
    bone.add(socket)
    socket.add(object)

    const att: Attachment = {
      id: uid('att'),
      name,
      socket,
      object,
      bone,
      info: { id: '', name, bone: bone.name, ...info },
    }
    att.info.id = att.id
    this.attachments.push(att)
    this.applyAttachmentOffset(att)
    return att
  }

  applyAttachmentOffset(att: Attachment): void {
    const { px, py, pz, rx, ry, rz, scale } = att.info
    att.object.position.set(px / 100, py / 100, pz / 100)
    att.object.rotation.set(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz),
    )
    att.object.scale.setScalar(scale)
  }

  /** 换骨骼重挂 */
  moveAttachment(att: Attachment, bone: THREE.Bone): void {
    bone.add(att.socket)
    const ws = new THREE.Vector3()
    bone.getWorldScale(ws)
    att.socket.scale.set(
      ws.x !== 0 ? 1 / ws.x : 1,
      ws.y !== 0 ? 1 / ws.y : 1,
      ws.z !== 0 ? 1 / ws.z : 1,
    )
    att.bone = bone
    att.info.bone = bone.name
  }

  /** 卸下挂载物；dispose=false 时保留对象（撤销栈持有，稍后可重新挂回） */
  detach(id: string, dispose = true): Attachment | undefined {
    const att = this.attachments.find((a) => a.id === id)
    if (!att) return undefined
    att.socket.removeFromParent()
    if (dispose) disposeObject(att.object)
    this.attachments = this.attachments.filter((a) => a.id !== id)
    return att
  }

  /** 重新挂回一个此前 detach(id, false) 保留下来的挂载物 */
  reattach(att: Attachment): void {
    att.bone.add(att.socket)
    this.attachments.push(att)
    this.applyAttachmentOffset(att)
  }

  /**
   * 把已映射的骨骼重命名为 UEFN / Manny 标准名，并同步全部动画轨道。
   * 返回 { renamed, missing }：重命名清单与未映射槽位。
   */
  conformToUE(): { renamed: [string, string][]; missing: BoneSlot[] } {
    if (!this.rig) return { renamed: [], missing: [] }
    const renames = new Map<string, string>()
    const renamed: [string, string][] = []
    const missing: BoneSlot[] = []
    const existing = new Set(this.boneNames)

    for (const slot of Object.keys(UE_SLOT_NAMES) as BoneSlot[]) {
      const cur = this.boneMap[slot]
      const std = UE_SLOT_NAMES[slot]
      if (!cur) {
        missing.push(slot)
        continue
      }
      if (cur === std) continue
      // 避免撞名：目标名已被其他骨骼占用且它不会被改走时跳过
      if (existing.has(std) && !Object.values(this.boneMap).includes(std)) continue
      renames.set(cur, std)
      renamed.push([cur, std])
    }

    if (renames.size === 0) return { renamed, missing }
    this.renameBones(renames)
    return { renamed, missing }
  }

  /** 批量重命名骨骼并同步映射、动画轨道与混合器缓存（可传入反向映射实现撤销） */
  renameBones(renames: Map<string, string>): void {
    if (!this.rig || renames.size === 0) return
    for (const bone of this.rig.bones) {
      const to = renames.get(bone.name)
      if (to) bone.name = to
    }
    // 重建名字索引
    this.rig.byName.clear()
    for (const b of this.rig.bones) if (!this.rig.byName.has(b.name)) this.rig.byName.set(b.name, b)
    // 槽位映射与动画轨道同步
    for (const slot of Object.keys(this.boneMap) as BoneSlot[]) {
      const cur = this.boneMap[slot]
      if (cur && renames.has(cur)) this.boneMap[slot] = renames.get(cur)
    }
    // 挂载镜像以骨骼对象实名为准（骨骼是原地改名的，正反向重命名都正确）
    for (const att of this.attachments) att.info.bone = att.bone.name
    for (const owned of this.clips) renameClipTracks(owned.clip, renames)
    this.inPlaceCache.clear()
    // 混合器里旧名字的绑定全部作废
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.model)
    this.currentAction = null
    this.currentClipId = null
    this.skeletonGuess = guessSkeletonType(this.boneNames)
  }

  clipInfos(): ClipInfo[] {
    return this.clips.map((c) => ({
      id: c.id,
      name: c.clip.name,
      duration: c.clip.duration,
      frames: Math.max(1, Math.round(c.clip.duration * 30)),
      source: c.source,
    }))
  }

  dispose(keepModelMaterials = false): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.model)
    // 骨骼移植 / 自动蒙皮会把挂载物连同材质烘进新角色，材质保留策略需一并透传
    for (const att of this.attachments) disposeObject(att.object, { keepMaterials: keepModelMaterials })
    disposeObject(this.model, { keepMaterials: keepModelMaterials })
    this.root.removeFromParent()
  }
}
