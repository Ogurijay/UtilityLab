import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STANDARD_BONES } from '../skeletons/standard'

/**
 * 程序化生成的标准假人：Manny 命名骨架 + 逐骨骼刚性蒙皮的方块身体。
 * 不依赖任何外部模型文件，打开应用即可预览动画与挂载。
 */

/** 仅骨骼层级（无网格），用作内置动画的重定向源等 */
export function buildStandardBones(): { root: THREE.Group; bones: THREE.Bone[]; byName: Map<string, THREE.Bone> } {
  const byName = new Map<string, THREE.Bone>()
  const bones: THREE.Bone[] = []
  const root = new THREE.Group()
  root.name = 'StandardSkeleton'

  for (const def of STANDARD_BONES) {
    const bone = new THREE.Bone()
    bone.name = def.name
    bone.position.set(def.pos[0], def.pos[1], def.pos[2])
    byName.set(def.name, bone)
    bones.push(bone)
    if (def.parent) {
      byName.get(def.parent)!.add(bone)
    } else {
      root.add(bone)
    }
  }
  root.updateWorldMatrix(true, true)
  return { root, bones, byName }
}

export interface SegmentDef {
  bone: string
  /** 目标骨骼名（沿骨骼指向子关节）或显式方向+长度 */
  to?: string
  dir?: [number, number, number]
  len?: number
  w: number
  d: number
  /** 分组：0 = 主体色，1 = 点缀色（头/手/脚尖） */
  g: 0 | 1
}

/** 假人身体分段，同时充当自动蒙皮的权重胶囊 */
export const SEGMENTS: SegmentDef[] = [
  { bone: 'pelvis', to: 'spine_01', w: 0.28, d: 0.18, g: 0 },
  { bone: 'pelvis', dir: [0, -1, 0], len: 0.1, w: 0.27, d: 0.17, g: 0 },
  { bone: 'spine_01', to: 'spine_02', w: 0.25, d: 0.165, g: 0 },
  { bone: 'spine_02', to: 'spine_03', w: 0.255, d: 0.165, g: 0 },
  { bone: 'spine_03', to: 'spine_04', w: 0.27, d: 0.17, g: 0 },
  { bone: 'spine_04', to: 'spine_05', w: 0.285, d: 0.175, g: 0 },
  { bone: 'spine_05', to: 'neck_01', w: 0.3, d: 0.18, g: 0 },
  { bone: 'neck_01', to: 'neck_02', w: 0.095, d: 0.095, g: 0 },
  { bone: 'neck_02', to: 'head', w: 0.09, d: 0.09, g: 0 },
  { bone: 'head', dir: [0, 1, 0], len: 0.235, w: 0.17, d: 0.2, g: 1 },
  { bone: 'clavicle_l', to: 'upperarm_l', w: 0.07, d: 0.07, g: 0 },
  { bone: 'upperarm_l', to: 'lowerarm_l', w: 0.092, d: 0.092, g: 0 },
  { bone: 'lowerarm_l', to: 'hand_l', w: 0.078, d: 0.078, g: 0 },
  { bone: 'hand_l', dir: [1, 0, 0], len: 0.17, w: 0.04, d: 0.09, g: 1 },
  { bone: 'clavicle_r', to: 'upperarm_r', w: 0.07, d: 0.07, g: 0 },
  { bone: 'upperarm_r', to: 'lowerarm_r', w: 0.092, d: 0.092, g: 0 },
  { bone: 'lowerarm_r', to: 'hand_r', w: 0.078, d: 0.078, g: 0 },
  { bone: 'hand_r', dir: [-1, 0, 0], len: 0.17, w: 0.04, d: 0.09, g: 1 },
  { bone: 'thigh_l', to: 'calf_l', w: 0.128, d: 0.128, g: 0 },
  { bone: 'calf_l', to: 'foot_l', w: 0.1, d: 0.1, g: 0 },
  { bone: 'foot_l', to: 'ball_l', w: 0.09, d: 0.08, g: 0 },
  { bone: 'ball_l', dir: [0, 0, 1], len: 0.07, w: 0.088, d: 0.05, g: 1 },
  { bone: 'thigh_r', to: 'calf_r', w: 0.128, d: 0.128, g: 0 },
  { bone: 'calf_r', to: 'foot_r', w: 0.1, d: 0.1, g: 0 },
  { bone: 'foot_r', to: 'ball_r', w: 0.09, d: 0.08, g: 0 },
  { bone: 'ball_r', dir: [0, 0, 1], len: 0.07, w: 0.088, d: 0.05, g: 1 },
]

function segmentGeometry(start: THREE.Vector3, end: THREE.Vector3, w: number, d: number): THREE.BufferGeometry {
  const len = start.distanceTo(end)
  const geo = new THREE.BoxGeometry(w, len, d)
  geo.translate(0, len / 2, 0)
  const dir = end.clone().sub(start).normalize()
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  const m = new THREE.Matrix4().compose(start, quat, new THREE.Vector3(1, 1, 1))
  geo.applyMatrix4(m)
  return geo
}

function bindToBone(geo: THREE.BufferGeometry, boneIndex: number): void {
  const count = geo.attributes.position.count
  const idx = new Uint16Array(count * 4)
  const wgt = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    idx[i * 4] = boneIndex
    wgt[i * 4] = 1
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
}

export function buildMannequin(): THREE.Group {
  const { root, bones, byName } = buildStandardBones()
  root.name = 'StandardMannequin'

  const worldPos = new Map<string, THREE.Vector3>()
  for (const b of bones) worldPos.set(b.name, b.getWorldPosition(new THREE.Vector3()))

  const groups: THREE.BufferGeometry[][] = [[], []]
  for (const seg of SEGMENTS) {
    const bone = byName.get(seg.bone)
    if (!bone) continue
    const start = worldPos.get(seg.bone)!
    let end: THREE.Vector3
    if (seg.to) {
      end = worldPos.get(seg.to)!.clone()
    } else {
      end = start.clone().addScaledVector(new THREE.Vector3(...seg.dir!), seg.len!)
    }
    const geo = segmentGeometry(start, end, seg.w, seg.d)
    bindToBone(geo, bones.indexOf(bone))
    groups[seg.g].push(geo)
  }

  const bodyGeo = mergeGeometries(groups[0], false)!
  const accentGeo = mergeGeometries(groups[1], false)!
  const merged = mergeGeometries([bodyGeo, accentGeo], true)!

  const bodyMat = new THREE.MeshStandardMaterial({
    color: '#8593a8',
    roughness: 0.55,
    metalness: 0.15,
    name: '假人主体',
  })
  const accentMat = new THREE.MeshStandardMaterial({
    color: '#3f74d6',
    roughness: 0.4,
    metalness: 0.3,
    name: '假人点缀',
  })

  const mesh = new THREE.SkinnedMesh(merged, [bodyMat, accentMat])
  mesh.name = 'MannequinBody'
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  root.add(mesh)
  root.updateWorldMatrix(true, true)
  mesh.bind(new THREE.Skeleton(bones))
  return root
}
