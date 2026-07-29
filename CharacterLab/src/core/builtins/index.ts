import * as THREE from 'three'
import type { AssetMeta, BoneMap } from '../../types'
import { STANDARD_BONE_MAP } from '../skeletons/standard'
import { buildStandardBones } from './mannequin'
import { buildIdleClip, buildWalkClip, buildWaveClip } from './clips'

/** 内置资源：仅保留三段示例动画（程序生成，可绑到任何人形骨架） */
export const BUILTIN_ASSETS: AssetMeta[] = [
  {
    id: 'b:clip:idle',
    name: '待机呼吸',
    kind: 'anim',
    format: 'builtin',
    size: 0,
    folderId: null,
    clipNames: ['待机呼吸'],
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'b:clip:walk',
    name: '原地行走',
    kind: 'anim',
    format: 'builtin',
    size: 0,
    folderId: null,
    clipNames: ['原地行走'],
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'b:clip:wave',
    name: '打招呼·挥手',
    kind: 'anim',
    format: 'builtin',
    size: 0,
    folderId: null,
    clipNames: ['打招呼·挥手'],
    builtin: true,
    createdAt: 0,
  },
]

export function isBuiltinId(id: string): boolean {
  return id.startsWith('b:')
}

export interface BuiltinAnim {
  clip: THREE.AnimationClip
  /** 动画的源骨架（标准骨架，仅骨骼） */
  srcRoot: THREE.Object3D
  srcMap: BoneMap
}

export function createBuiltinAnim(id: string): BuiltinAnim | null {
  let clip: THREE.AnimationClip | null = null
  if (id === 'b:clip:idle') clip = buildIdleClip()
  else if (id === 'b:clip:walk') clip = buildWalkClip()
  else if (id === 'b:clip:wave') clip = buildWaveClip()
  if (!clip) return null
  const { root } = buildStandardBones()
  return { clip, srcRoot: root, srcMap: { ...STANDARD_BONE_MAP } }
}
