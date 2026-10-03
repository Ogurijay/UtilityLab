import * as THREE from 'three'
import { SEGMENTS } from './skinSegments'
import { bakeMeshesStatic, mergePieces } from '../mesh/bake'
import { buildFittedBones, fitStandardToBox } from './fit'
import { centerObjectOnGround } from '../modelPlacement'

/**
 * 自动蒙皮：给任意静态网格（含拼装结果）直接绑上 Manny / UEFN 标准骨架。
 * 骨架按包围盒适配体型；顶点权重取最近的几个身体胶囊段（距离四次方反比），
 * 适合人形、姿态接近 T / A-pose 的模型。
 */
export function autoSkinToStandard(
  model: THREE.Object3D,
  relTo: THREE.Object3D,
  name: string,
): { group: THREE.Group; warnings: string[] } {
  const pieces = bakeMeshesStatic(model, relTo)
  const merged = mergePieces(pieces)
  if (!merged) throw new Error('模型里没有网格，无法蒙皮')
  const { geometry, materials } = merged

  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const size = box.getSize(new THREE.Vector3())
  if (size.y < 0.01) throw new Error('模型高度异常，无法适配骨架')

  const joints = fitStandardToBox(box)
  const fitted = buildFittedBones(joints)
  const stdIndex = new Map<string, number>()
  fitted.bones.forEach((b, i) => stdIndex.set(b.name, i))
  const s = size.y / 1.8

  // 权重胶囊：复用假人的身体分段定义
  interface Capsule {
    a: THREE.Vector3
    b: THREE.Vector3
    r: number
    bone: number
  }
  const capsules: Capsule[] = []
  for (const seg of SEGMENTS) {
    const a = joints.world.get(seg.bone)
    if (!a) continue
    let b: THREE.Vector3
    if (seg.to) {
      b = joints.world.get(seg.to)!.clone()
    } else {
      b = a.clone().addScaledVector(new THREE.Vector3(...seg.dir!), seg.len! * s)
    }
    capsules.push({
      a: a.clone(),
      b,
      r: (Math.max(seg.w, seg.d) / 2) * s,
      bone: stdIndex.get(seg.bone)!,
    })
  }

  const pos = geometry.attributes.position as THREE.BufferAttribute
  const count = pos.count
  const idxArr = new Uint16Array(count * 4)
  const wgtArr = new Float32Array(count * 4)

  const p = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ap = new THREE.Vector3()
  const closest = new THREE.Vector3()
  const perBone = new Map<number, number>()

  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(pos, i)
    perBone.clear()
    for (const c of capsules) {
      // 点到线段距离
      ab.copy(c.b).sub(c.a)
      ap.copy(p).sub(c.a)
      const t = THREE.MathUtils.clamp(ab.lengthSq() > 1e-10 ? ap.dot(ab) / ab.lengthSq() : 0, 0, 1)
      closest.copy(c.a).addScaledVector(ab, t)
      const d = Math.max(p.distanceTo(closest) - c.r * 0.6, 0.004 * s)
      const score = 1 / (d * d * d * d)
      perBone.set(c.bone, Math.max(perBone.get(c.bone) ?? 0, score))
    }
    const top = [...perBone.entries()].sort((a2, b2) => b2[1] - a2[1]).slice(0, 4)
    // 远处骨骼的微小权重直接舍弃，边界更干净
    const cutoff = top[0][1] * 0.02
    let sum = 0
    const kept = top.filter(([, w]) => w >= cutoff)
    for (const [, w] of kept) sum += w
    kept.forEach(([bone, w], k) => {
      idxArr[i * 4 + k] = bone
      wgtArr[i * 4 + k] = w / sum
    })
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idxArr, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgtArr, 4))

  const group = new THREE.Group()
  group.name = `${name}·自动蒙皮`
  group.add(fitted.root)
  const mesh = new THREE.SkinnedMesh(geometry, materials.length === 1 ? materials[0] : materials)
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  group.add(mesh)
  group.updateWorldMatrix(true, true)
  mesh.bind(new THREE.Skeleton(fitted.bones))
  centerObjectOnGround(group)

  return {
    group,
    warnings: ['自动蒙皮为近似权重，适合人形且接近 T/A 姿态的模型；细节部位可能需要在专业工具里精修'],
  }
}
