import * as THREE from 'three'
import type { Rig } from '../rig'
import { resetRigToBind } from '../rig'

/**
 * 动画重定向：把在源骨架上制作的动画烘焙到目标骨架上。
 *
 * 算法（世界空间旋转增量转移）：
 *   1. 让源骨架逐帧播放动画；
 *   2. 对每对映射骨骼，取源骨骼"当前世界旋转 × 绑定世界旋转⁻¹"作为增量；
 *   3. 把增量施加到目标骨骼的绑定世界旋转上，再换算回目标本地空间；
 *   4. 髋部位置按两副骨架的髋高比例缩放后转移（自动兼容厘米/米单位差）。
 *
 * 相比直接拷贝本地旋转，这种做法天然兼容 T-pose / A-pose 等不同绑定姿势，
 * 也不要求两副骨架层级一致 —— 未映射的骨骼保持绑定姿势即可。
 */
export interface RetargetResult {
  clip: THREE.AnimationClip
  mappedCount: number
}

export function bakeRetargetedClip(opts: {
  clip: THREE.AnimationClip
  srcRig: Rig
  tgtRig: Rig
  /** 目标骨骼名 → 源骨骼名 */
  nameMap: Map<string, string>
  /** 目标 / 源髋骨名（用于位置转移，可缺省则不带位移） */
  tgtHips?: string
  srcHips?: string
  fps?: number
  outName?: string
}): RetargetResult {
  const { clip, srcRig, tgtRig, nameMap } = opts
  const fps = opts.fps ?? 30
  const duration = Math.max(clip.duration, 1 / fps)
  const frames = Math.max(2, Math.round(duration * fps) + 1)
  const dt = duration / (frames - 1)

  // 目标骨架回到绑定姿势，保证所有派生数据一致
  resetRigToBind(tgtRig)

  // 源骨架同样先回绑定，再由 mixer 驱动
  resetRigToBind(srcRig)
  const mixer = new THREE.AnimationMixer(srcRig.root)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopRepeat, Infinity)
  action.play()

  // 参与烘焙的目标骨骼（映射双方都存在）
  const pairs: { tgt: THREE.Bone; src: THREE.Bone }[] = []
  const pairByTgt = new Map<THREE.Bone, THREE.Bone>()
  for (const [tgtName, srcName] of nameMap) {
    const tgt = tgtRig.byName.get(tgtName)
    const src = srcRig.byName.get(srcName)
    if (tgt && src) {
      pairs.push({ tgt, src })
      pairByTgt.set(tgt, src)
    }
  }
  if (pairs.length === 0) {
    throw new Error('没有任何骨骼能够映射，无法重定向')
  }

  // 髋部位置转移准备
  const tgtHips = opts.tgtHips ? tgtRig.byName.get(opts.tgtHips) : undefined
  const srcHips = opts.srcHips ? srcRig.byName.get(opts.srcHips) : undefined
  let hipRatio = 1
  let tgtHipsParentInv: THREE.Matrix4 | null = null
  if (tgtHips && srcHips) {
    const tgtH = tgtRig.bindWorldPos.get(tgtHips)!.y - tgtRig.groundY
    const srcH = srcRig.bindWorldPos.get(srcHips)!.y - srcRig.groundY
    hipRatio = srcH > 1e-6 ? tgtH / srcH : 1
    const parent = tgtHips.parent
    if (parent && (parent as THREE.Bone).isBone) {
      tgtHipsParentInv = tgtRig.bindWorldMatrix.get(parent as THREE.Bone)!.clone().invert()
    } else {
      tgtHipsParentInv = tgtRig.parentWorldMatrixInv.get(tgtHips)!.clone()
    }
  }

  // 逐帧采样
  const times = new Float32Array(frames)
  const quatData = new Map<THREE.Bone, Float32Array>()
  for (const { tgt } of pairs) quatData.set(tgt, new Float32Array(frames * 4))
  const hipPosData = tgtHips && srcHips ? new Float32Array(frames * 3) : null

  const srcWorldQ = new THREE.Quaternion()
  const srcBindInv = new THREE.Quaternion()
  const delta = new THREE.Quaternion()
  const desired = new THREE.Quaternion()
  const local = new THREE.Quaternion()
  const parentInv = new THREE.Quaternion()
  const worldNow = new Map<THREE.Bone, THREE.Quaternion>()
  for (const b of tgtRig.order) worldNow.set(b, new THREE.Quaternion())
  const prevQuat = new Map<THREE.Bone, THREE.Quaternion>()

  const srcHipWorld = new THREE.Vector3()
  const hipDesired = new THREE.Vector3()

  for (let f = 0; f < frames; f++) {
    const t = f * dt
    times[f] = t
    // 采样点略微收在时长内，避免 LoopRepeat 在 t == duration 处回绕到第 0 帧
    mixer.setTime(Math.min(t, duration - 1e-4))
    srcRig.root.updateWorldMatrix(true, true)

    // 父先子后遍历目标骨架，维护"本帧世界旋转"链
    for (const b of tgtRig.order) {
      const parent = b.parent
      const parentWorld =
        parent && (parent as THREE.Bone).isBone
          ? worldNow.get(parent as THREE.Bone)!
          : tgtRig.parentWorldQuat.get(b)!

      const src = pairByTgt.get(b)
      if (src) {
        src.getWorldQuaternion(srcWorldQ)
        srcBindInv.copy(srcRig.bindWorldQuat.get(src)!).invert()
        delta.copy(srcWorldQ).multiply(srcBindInv)
        desired.copy(delta).multiply(tgtRig.bindWorldQuat.get(b)!)
        parentInv.copy(parentWorld).invert()
        local.copy(parentInv).multiply(desired)

        // 保持四元数符号连续，避免插值抖动
        const prev = prevQuat.get(b)
        if (prev && prev.dot(local) < 0) {
          local.set(-local.x, -local.y, -local.z, -local.w)
        }
        prevQuat.set(b, (prev ?? new THREE.Quaternion()).copy(local))

        const arr = quatData.get(b)!
        arr[f * 4] = local.x
        arr[f * 4 + 1] = local.y
        arr[f * 4 + 2] = local.z
        arr[f * 4 + 3] = local.w
        worldNow.get(b)!.copy(parentWorld).multiply(local)
      } else {
        // 未映射骨骼保持绑定姿势
        worldNow.get(b)!.copy(parentWorld).multiply(tgtRig.bindLocal.get(b)!.quat)
      }
    }

    // 髋部位置
    if (hipPosData && tgtHips && srcHips && tgtHipsParentInv) {
      srcHips.getWorldPosition(srcHipWorld)
      hipDesired
        .copy(srcHipWorld)
        .sub(srcRig.bindWorldPos.get(srcHips)!)
        .multiplyScalar(hipRatio)
        .add(tgtRig.bindWorldPos.get(tgtHips)!)
      hipDesired.applyMatrix4(tgtHipsParentInv)
      hipPosData[f * 3] = hipDesired.x
      hipPosData[f * 3 + 1] = hipDesired.y
      hipPosData[f * 3 + 2] = hipDesired.z
    }
  }

  // 清理源骨架上的播放状态
  mixer.stopAllAction()
  mixer.uncacheClip(clip)
  mixer.uncacheRoot(srcRig.root)
  resetRigToBind(srcRig)

  // 组装轨道
  const tracks: THREE.KeyframeTrack[] = []
  for (const { tgt } of pairs) {
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${tgt.name}.quaternion`, times as unknown as number[], quatData.get(tgt)! as unknown as number[]),
    )
  }
  if (hipPosData && tgtHips) {
    tracks.push(
      new THREE.VectorKeyframeTrack(`${tgtHips.name}.position`, times as unknown as number[], hipPosData as unknown as number[]),
    )
  }

  const outClip = new THREE.AnimationClip(opts.outName ?? clip.name ?? '重定向动画', duration, tracks)
  return { clip: outClip, mappedCount: pairs.length }
}

/**
 * 判断动画能否直接绑定：动画轨道引用的节点名与角色骨骼名重合度足够高
 * （同一命名体系），直接播放能保留手指等全部细节，优于重定向。
 */
export function directBindScore(clip: THREE.AnimationClip, boneNames: Set<string>): number {
  const nodes = new Set<string>()
  for (const track of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name)
    if (parsed.nodeName) nodes.add(parsed.nodeName)
  }
  if (nodes.size === 0) return 0
  let hit = 0
  for (const n of nodes) if (boneNames.has(n)) hit++
  return hit / nodes.size
}

/** 重写动画轨道所指向的节点名（骨骼重命名后同步动画） */
export function renameClipTracks(clip: THREE.AnimationClip, renames: Map<string, string>): void {
  for (const track of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name)
    const to = parsed.nodeName ? renames.get(parsed.nodeName) : undefined
    if (to) {
      track.name = `${to}.${parsed.propertyName}`
    }
  }
}
