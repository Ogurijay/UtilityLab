import * as THREE from 'three'
import type { Rig } from '../rig'

export type ReferencePoseName = 'source' | 't' | 'a'

export interface ReferencePoseDefinition {
  mode: 'captured_bind_pose' | 'alias' | 'local_overrides'
  pose?: ReferencePoseName
  bones?: Record<string, {
    position?: number[]
    quaternion?: number[]
    scale?: number[]
  }>
}

export interface ReferenceProfile {
  revision: number
  baseline_asset_id: string
  bone_count: number
  hierarchy_signature: string
  rest_pose_signature: string
  required_bones: string[]
  poses: Record<ReferencePoseName, ReferencePoseDefinition>
}

export interface ReferencePosePayload {
  schema_version: number
  three_revision: string
  profiles: Record<string, ReferenceProfile>
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`
}

export function skeletonHierarchySignature(rig: Rig): string {
  const hierarchy = rig.bones
    .map((bone) => `${bone.name}|${(bone.parent as THREE.Bone | null)?.isBone ? bone.parent!.name : '<root>'}`)
    .sort()
    .join('\n')
  return fnv1a32(hierarchy)
}

export function validateReferenceProfile(rig: Rig, profileId: string, profile: ReferenceProfile): void {
  if (rig.bones.length !== profile.bone_count) {
    throw new Error(`骨骼数量不匹配：参考 ${profile.bone_count}，当前 ${rig.bones.length}`)
  }
  const signature = skeletonHierarchySignature(rig)
  if (signature !== profile.hierarchy_signature) {
    throw new Error(`骨骼层级不匹配（${signature}），已拒绝套用姿势`)
  }
  const missing = profile.required_bones.filter((name) => !rig.byName.has(name))
  if (missing.length) throw new Error(`缺少必需骨骼：${missing.join('、')}`)
  if (!profile.poses) throw new Error(`骨架 ${profileId} 没有参考姿势配置`)
}

export function applyReferencePose(
  rig: Rig,
  profileId: string,
  profile: ReferenceProfile,
  poseName: ReferencePoseName,
): void {
  validateReferenceProfile(rig, profileId, profile)
  for (const bone of rig.bones) {
    const source = rig.bindLocal.get(bone)
    if (!source) continue
    bone.position.copy(source.pos)
    bone.quaternion.copy(source.quat)
    bone.scale.copy(source.scale)
  }
  if (poseName === 'source') {
    rig.root.updateWorldMatrix(true, true)
    return
  }

  const definition = profile.poses[poseName]
  if (!definition) throw new Error(`缺少 ${poseName.toUpperCase()} Pose（姿势）配置`)
  if (definition.mode === 'alias' && definition.pose) {
    applyReferencePose(rig, profileId, profile, definition.pose)
    return
  }
  if (definition.mode !== 'local_overrides') {
    throw new Error(`不支持的参考姿势模式：${definition.mode}`)
  }
  for (const [boneName, transform] of Object.entries(definition.bones || {})) {
    const bone = rig.byName.get(boneName)
    if (!bone) throw new Error(`参考姿势找不到骨骼：${boneName}`)
    if (transform.position) bone.position.fromArray(transform.position)
    if (transform.quaternion) bone.quaternion.fromArray(transform.quaternion).normalize()
    if (transform.scale) bone.scale.fromArray(transform.scale)
  }
  rig.root.updateWorldMatrix(true, true)
}
