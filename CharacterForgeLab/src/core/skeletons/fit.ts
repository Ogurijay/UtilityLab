import * as THREE from 'three'
import type { BoneMap, BoneSlot } from '../../types'
import type { Rig } from '../rig'
import { STANDARD_BONES } from './standard'

/**
 * 标准骨架适配：把 Manny 命名的标准骨架"套"到目标上——
 * 关节位置来自源骨架映射（骨骼移植）或包围盒比例（自动蒙皮），
 * 骨骼旋转保持单位四元数，层级与命名严格等于标准定义。
 */

export interface FittedJoints {
  /** 骨骼名 → root 参考系下的关节位置 */
  world: Map<string, THREE.Vector3>
}

const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5)
const lerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t)

/** 依据源骨架的槽位映射适配关节位置（保持模型比例）。要求关键槽位齐全。 */
export function fitStandardToBoneMap(rig: Rig, boneMap: BoneMap): FittedJoints {
  const P = (slot: BoneSlot): THREE.Vector3 | undefined => {
    const name = boneMap[slot]
    if (!name) return undefined
    const bone = rig.byName.get(name)
    return bone ? rig.bindWorldPos.get(bone)?.clone() : undefined
  }
  const need = (slot: BoneSlot): THREE.Vector3 => {
    const v = P(slot)
    if (!v) throw new Error(`缺少关键骨骼映射：${slot}`)
    return v
  }

  const pelvis = need('hips')
  const uaL = need('upperArmL')
  const uaR = need('upperArmR')
  const thL = need('upLegL')
  const thR = need('upLegR')
  const shoulderMid = mid(uaL, uaR)

  const head = P('head') ?? lerp(pelvis, shoulderMid, 1.35)
  const neck1 = P('neck') ?? lerp(shoulderMid, head, 0.35)
  const spine1 = P('spine') ?? lerp(pelvis, shoulderMid, 0.22)
  const spine3 = P('chest') ?? lerp(pelvis, shoulderMid, 0.55)
  const spine5 = P('upperChest') ?? lerp(pelvis, shoulderMid, 0.88)
  // 身材比例参考：标准骨架头-骨盆纵距 0.61
  const s = Math.max(0.2, (head.y - pelvis.y) / 0.61)

  const clavL = P('shoulderL') ?? lerp(spine5, uaL, 0.4)
  const clavR = P('shoulderR') ?? lerp(spine5, uaR, 0.4)
  const handLKnown = P('handL')
  const loArmL = P('lowerArmL') ?? (handLKnown ? mid(uaL, handLKnown) : uaL.clone().add(uaL.clone().sub(clavL)))
  const handL = handLKnown ?? loArmL.clone().add(loArmL.clone().sub(uaL))
  const handRKnown = P('handR')
  const loArmR = P('lowerArmR') ?? (handRKnown ? mid(uaR, handRKnown) : uaR.clone().add(uaR.clone().sub(clavR)))
  const handR = handRKnown ?? loArmR.clone().add(loArmR.clone().sub(uaR))

  const footLKnown = P('footL')
  const calfL = P('lowerLegL') ?? (footLKnown ? mid(thL, footLKnown) : thL.clone().add(new THREE.Vector3(0, -0.45 * s, 0)))
  const footL = footLKnown ?? calfL.clone().add(calfL.clone().sub(thL).multiplyScalar(0.95))
  const footRKnown = P('footR')
  const calfR = P('lowerLegR') ?? (footRKnown ? mid(thR, footRKnown) : thR.clone().add(new THREE.Vector3(0, -0.45 * s, 0)))
  const footR = footRKnown ?? calfR.clone().add(calfR.clone().sub(thR).multiplyScalar(0.95))
  const ballL = P('toeL') ?? footL.clone().add(new THREE.Vector3(0, -footL.y * 0.8, 0.13 * s))
  const ballR = P('toeR') ?? footR.clone().add(new THREE.Vector3(0, -footR.y * 0.8, 0.13 * s))

  const world = new Map<string, THREE.Vector3>()
  world.set('root', new THREE.Vector3(pelvis.x, 0, pelvis.z))
  world.set('pelvis', pelvis)
  world.set('spine_01', spine1)
  world.set('spine_02', mid(spine1, spine3))
  world.set('spine_03', spine3)
  world.set('spine_04', mid(spine3, spine5))
  world.set('spine_05', spine5)
  world.set('neck_01', neck1)
  world.set('neck_02', mid(neck1, head))
  world.set('head', head)
  world.set('clavicle_l', clavL)
  world.set('upperarm_l', uaL)
  world.set('lowerarm_l', loArmL)
  world.set('hand_l', handL)
  world.set('clavicle_r', clavR)
  world.set('upperarm_r', uaR)
  world.set('lowerarm_r', loArmR)
  world.set('hand_r', handR)
  world.set('thigh_l', thL)
  world.set('calf_l', calfL)
  world.set('foot_l', footL)
  world.set('ball_l', ballL)
  world.set('thigh_r', thR)
  world.set('calf_r', calfR)
  world.set('foot_r', footR)
  world.set('ball_r', ballR)
  return { world }
}

/** 按包围盒适配标准骨架（用于无骨骼网格的自动蒙皮） */
export function fitStandardToBox(box: THREE.Box3): FittedJoints {
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const s = Math.max(0.05, size.y / 1.8)
  const base = new THREE.Vector3(center.x, box.min.y, center.z)

  // 标准定义是父级偏移，先累加成世界位置再缩放平移
  const acc = new Map<string, THREE.Vector3>()
  for (const def of STANDARD_BONES) {
    const parent = def.parent ? acc.get(def.parent)!.clone() : new THREE.Vector3()
    acc.set(def.name, parent.add(new THREE.Vector3(...def.pos)))
  }
  const world = new Map<string, THREE.Vector3>()
  for (const [name, p] of acc) {
    world.set(name, p.multiplyScalar(s).add(base))
  }
  return { world }
}

/** 由适配好的关节位置实例化骨骼层级（旋转全部为单位四元数） */
export function buildFittedBones(joints: FittedJoints): {
  root: THREE.Group
  bones: THREE.Bone[]
  byName: Map<string, THREE.Bone>
} {
  const root = new THREE.Group()
  root.name = 'MannySkeleton'
  const bones: THREE.Bone[] = []
  const byName = new Map<string, THREE.Bone>()
  for (const def of STANDARD_BONES) {
    const bone = new THREE.Bone()
    bone.name = def.name
    const world = joints.world.get(def.name)!
    const parentWorld = def.parent ? joints.world.get(def.parent)! : new THREE.Vector3()
    bone.position.copy(world).sub(parentWorld)
    byName.set(def.name, bone)
    bones.push(bone)
    if (def.parent) byName.get(def.parent)!.add(bone)
    else root.add(bone)
  }
  root.updateWorldMatrix(true, true)
  return { root, bones, byName }
}
