import * as THREE from 'three'
import type { BoneSlot } from '../../types'
import type { Character } from '../character'
import { resetRigToBind } from '../rig'
import { missingRequiredSlots } from './autoMap'
import { SLOT_LABELS, UE_SLOT_NAMES } from './standard'
import { buildFittedBones, fitStandardToBoneMap } from './fit'

/**
 * 骨骼移植：用 Manny / UEFN 标准骨架整体替换已蒙皮模型的原骨架。
 *  - 标准关节位置按源骨架比例适配（模型体型不变）
 *  - 蒙皮权重逐顶点重映射到新骨骼；未映射骨骼（手指、饰品骨等）的权重
 *    并入最近的已映射祖先，表现为该部位随父骨骼刚性运动
 *  - 结果骨架命名、层级与标准完全一致，内置动画可直接播放
 */
export function transplantToStandard(character: Character): { group: THREE.Group; warnings: string[] } {
  const rig = character.rig
  if (!rig) throw new Error('当前模型没有骨骼，请改用「自动蒙皮」')
  const missing = missingRequiredSlots(character.boneMap)
  if (missing.length > 0) {
    throw new Error(`骨骼映射不完整（缺 ${missing.map((s) => SLOT_LABELS[s]).join('、')}），请先到映射表补全`)
  }

  resetRigToBind(rig)
  const warnings: string[] = []

  const joints = fitStandardToBoneMap(rig, character.boneMap)
  const fitted = buildFittedBones(joints)
  const stdIndex = new Map<string, number>()
  fitted.bones.forEach((b, i) => stdIndex.set(b.name, i))

  // 源骨骼名 → 槽位（仅已映射的）
  const nameToSlot = new Map<string, BoneSlot>()
  for (const [slot, name] of Object.entries(character.boneMap) as [BoneSlot, string][]) {
    if (name) nameToSlot.set(name, slot)
  }
  // 源骨骼 → 标准骨骼下标（未映射时上溯祖先）
  const boneStdCache = new Map<THREE.Object3D, number>()
  let mergedBones = 0
  const stdIndexOfBone = (bone: THREE.Object3D): number => {
    const cached = boneStdCache.get(bone)
    if (cached !== undefined) return cached
    let cur: THREE.Object3D | null = bone
    let result = stdIndex.get('pelvis')!
    let direct = false
    while (cur) {
      const slot = nameToSlot.get(cur.name)
      if (slot && (cur as THREE.Bone).isBone) {
        result = stdIndex.get(UE_SLOT_NAMES[slot])!
        direct = cur === bone
        break
      }
      cur = cur.parent
    }
    if (!direct) mergedBones++
    boneStdCache.set(bone, result)
    return result
  }

  const group = new THREE.Group()
  group.name = `${character.name}·Manny`
  group.add(fitted.root)

  character.model.updateWorldMatrix(true, true)
  character.root.updateWorldMatrix(true, false)
  const invRoot = character.root.matrixWorld.clone().invert()
  const skinnedMeshes: THREE.SkinnedMesh[] = []
  let droppedStatic = 0

  character.model.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!(mesh as THREE.Mesh).isMesh || !mesh.geometry || !mesh.visible) return
    const rel = invRoot.clone().multiply(mesh.matrixWorld)
    const mirrored = rel.determinant() < 0

    if (mesh.isSkinnedMesh && mesh.geometry.attributes.skinIndex) {
      let geo = mesh.geometry.clone()
      if (mirrored && geo.index) geo = geo.toNonIndexed()
      geo.applyMatrix4(rel)
      if (mirrored) flipWinding(geo)
      transformMorphs(geo, rel)

      // 权重重映射：同一顶点映射到相同标准骨骼的权重合并，取前 4
      const count = geo.attributes.position.count
      const oldIdx = geo.attributes.skinIndex as THREE.BufferAttribute
      const oldWgt = geo.attributes.skinWeight as THREE.BufferAttribute
      const newIdx = new Uint16Array(count * 4)
      const newWgt = new Float32Array(count * 4)
      const acc = new Map<number, number>()
      for (let i = 0; i < count; i++) {
        acc.clear()
        for (let k = 0; k < 4; k++) {
          const w = oldWgt.getComponent(i, k)
          if (w <= 0) continue
          const srcBone = mesh.skeleton.bones[oldIdx.getComponent(i, k)]
          if (!srcBone) continue
          const std = stdIndexOfBone(srcBone)
          acc.set(std, (acc.get(std) ?? 0) + w)
        }
        const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        let sum = 0
        for (const [, w] of top) sum += w
        if (sum <= 0) {
          newIdx[i * 4] = stdIndex.get('pelvis')!
          newWgt[i * 4] = 1
          continue
        }
        top.forEach(([idx, w], k) => {
          newIdx[i * 4 + k] = idx
          newWgt[i * 4 + k] = w / sum
        })
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(newIdx, 4))
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(newWgt, 4))

      const out = new THREE.SkinnedMesh(geo, mesh.material)
      out.name = mesh.name
      out.castShadow = true
      out.receiveShadow = true
      out.frustumCulled = false
      out.morphTargetDictionary = mesh.morphTargetDictionary
      out.morphTargetInfluences = mesh.morphTargetInfluences?.slice()
      group.add(out)
      skinnedMeshes.push(out)
      return
    }

    // 无蒙皮网格：如果挂在骨骼下，转成 100% 刚性蒙皮跟随对应标准骨骼
    let boneAncestor: THREE.Object3D | null = mesh.parent
    while (boneAncestor && !(boneAncestor as THREE.Bone).isBone) boneAncestor = boneAncestor.parent
    let geo = mesh.geometry.clone()
    if (mirrored && geo.index) geo = geo.toNonIndexed()
    geo.applyMatrix4(rel)
    if (mirrored) flipWinding(geo)
    if (boneAncestor) {
      const std = stdIndexOfBone(boneAncestor)
      const count = geo.attributes.position.count
      const idx = new Uint16Array(count * 4)
      const wgt = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        idx[i * 4] = std
        wgt[i * 4] = 1
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
      const out = new THREE.SkinnedMesh(geo, mesh.material)
      out.name = mesh.name
      out.castShadow = true
      out.receiveShadow = true
      out.frustumCulled = false
      group.add(out)
      skinnedMeshes.push(out)
    } else {
      const out = new THREE.Mesh(geo, mesh.material)
      out.name = mesh.name
      out.castShadow = true
      out.receiveShadow = true
      group.add(out)
      droppedStatic++
    }
  })

  if (skinnedMeshes.length === 0) throw new Error('模型里没有可移植的蒙皮网格')

  group.updateWorldMatrix(true, true)
  const skeleton = new THREE.Skeleton(fitted.bones)
  for (const mesh of skinnedMeshes) mesh.bind(skeleton)

  if (mergedBones > 0) warnings.push(`${mergedBones} 根未映射骨骼（手指 / 饰品等）的权重已并入邻近标准骨骼`)
  if (droppedStatic > 0) warnings.push(`${droppedStatic} 个静态网格未参与蒙皮，保持固定位置`)
  return { group, warnings }
}

function flipWinding(geo: THREE.BufferGeometry): void {
  for (const attr of Object.values(geo.attributes)) {
    const a = attr as THREE.BufferAttribute
    for (let tri = 0; tri < a.count / 3; tri++) {
      for (let k = 0; k < a.itemSize; k++) {
        const i0 = (tri * 3) * a.itemSize + k
        const i1 = (tri * 3 + 1) * a.itemSize + k
        const arr = a.array as Float32Array
        const tmp = arr[i0]
        arr[i0] = arr[i1]
        arr[i1] = tmp
      }
    }
    a.needsUpdate = true
  }
  geo.computeVertexNormals()
}

/** 形态目标增量随基准几何一起变换（只取旋转缩放部分） */
function transformMorphs(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
  const m3 = new THREE.Matrix3().setFromMatrix4(m)
  const v = new THREE.Vector3()
  for (const key of ['position', 'normal'] as const) {
    const list = geo.morphAttributes[key]
    if (!list) continue
    for (const attr of list) {
      const a = attr as THREE.BufferAttribute
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i).applyMatrix3(m3)
        a.setXYZ(i, v.x, v.y, v.z)
      }
      a.needsUpdate = true
    }
  }
}
