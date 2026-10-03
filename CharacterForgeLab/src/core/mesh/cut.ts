import * as THREE from 'three'
import type { BodyRegion, BoneMap, BoneSlot } from '../../types'
import type { Rig } from '../rig'
import { applyMatrixWithWinding, normalizeGeometry, sliceVertexRange, type BakedPiece } from './bake'

/**
 * 网格切割：
 *  - 按身体部位：利用蒙皮权重把三角形归类到骨骼区域，干净分离头 / 臂 / 腿等
 *  - 按平面：任意轴向位置一刀两半，跨面三角形做精确劈分（切口不封闭）
 */

export const REGION_LABELS: Record<BodyRegion, string> = {
  head: '头部',
  torso: '躯干',
  armL: '左臂',
  armR: '右臂',
  legL: '左腿',
  legR: '右腿',
}

const REGION_SLOTS: Record<BodyRegion, BoneSlot[]> = {
  head: ['neck', 'head'],
  torso: ['root', 'hips', 'spine', 'chest', 'upperChest'],
  armL: ['shoulderL', 'upperArmL', 'lowerArmL', 'handL'],
  armR: ['shoulderR', 'upperArmR', 'lowerArmR', 'handR'],
  legL: ['upLegL', 'lowerLegL', 'footL', 'toeL'],
  legR: ['upLegR', 'lowerLegR', 'footR', 'toeR'],
}

/** 每根骨骼属于哪个区域：先精确匹配槽位，未映射骨骼继承最近的已映射祖先 */
export function classifyBonesToRegions(rig: Rig, boneMap: BoneMap): Map<THREE.Bone, BodyRegion> {
  const slotRegion = new Map<string, BodyRegion>()
  for (const [region, slots] of Object.entries(REGION_SLOTS) as [BodyRegion, BoneSlot[]][]) {
    for (const slot of slots) {
      const name = boneMap[slot]
      if (name) slotRegion.set(name, region)
    }
  }
  const out = new Map<THREE.Bone, BodyRegion>()
  for (const bone of rig.bones) {
    let cur: THREE.Object3D | null = bone
    let region: BodyRegion | undefined
    while (cur) {
      if ((cur as THREE.Bone).isBone && slotRegion.has(cur.name)) {
        region = slotRegion.get(cur.name)
        break
      }
      cur = cur.parent
    }
    out.set(bone, region ?? 'torso')
  }
  return out
}

interface SplitResult {
  inside: BakedPiece[]
  outside: BakedPiece[]
}

/**
 * 按身体区域切割：返回区域内 / 区域外两组静态几何块（relTo 参考系）。
 * 支持多区域组合（如 头部+躯干+双臂 = 上半身）。要求当前处于绑定姿势。
 */
export function cutByRegion(
  model: THREE.Object3D,
  relTo: THREE.Object3D,
  rig: Rig,
  boneMap: BoneMap,
  regions: ReadonlySet<BodyRegion>,
): SplitResult {
  const boneRegion = classifyBonesToRegions(rig, boneMap)
  model.updateWorldMatrix(true, true)
  relTo.updateWorldMatrix(true, false)
  const invRel = relTo.matrixWorld.clone().invert()

  const inside: BakedPiece[] = []
  const outside: BakedPiece[] = []

  // 区域骨骼的世界坐标（用于给无蒙皮子网格归类）
  const regionBonePos: { region: BodyRegion; pos: THREE.Vector3 }[] = []
  for (const [bone, r] of boneRegion) {
    regionBonePos.push({ region: r, pos: bone.getWorldPosition(new THREE.Vector3()) })
  }

  model.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!(mesh as THREE.Mesh).isMesh || !mesh.geometry || !mesh.visible) return
    const rel = invRel.clone().multiply(mesh.matrixWorld)

    if (!mesh.isSkinnedMesh || !mesh.geometry.attributes.skinIndex) {
      // 无蒙皮的子网格（眼镜、附件等）：按中心点最近的骨骼整体归边，按材质组保留多材质
      const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())
      let best: BodyRegion = 'torso'
      let bestD = Infinity
      for (const rb of regionBonePos) {
        const d = rb.pos.distanceToSquared(center)
        if (d < bestD) {
          bestD = d
          best = rb.region
        }
      }
      const target = regions.has(best) ? inside : outside
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const nonIndexed = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
      const vCount = nonIndexed.attributes.position.count
      const meshGroups = nonIndexed.groups?.length
        ? nonIndexed.groups
        : [{ start: 0, count: vCount, materialIndex: 0 }]
      for (const g of meshGroups) {
        const count = Math.min(g.count, vCount - g.start)
        if (count <= 0) continue
        const piece = sliceVertexRange(nonIndexed, g.start, count)
        const geo = normalizeGeometry(piece)
        piece.dispose()
        applyMatrixWithWinding(geo, rel)
        target.push({ geometry: geo, material: mats[Math.min(g.materialIndex ?? 0, mats.length - 1)] })
      }
      return
    }

    // 蒙皮网格：逐顶点求主导骨骼 → 区域；逐三角形多数表决归边
    const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
    const skinIndex = src.attributes.skinIndex as THREE.BufferAttribute
    const skinWeight = src.attributes.skinWeight as THREE.BufferAttribute
    const count = src.attributes.position.count
    const bones = mesh.skeleton.bones

    const vertexIn = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      let bestW = -1
      let bestBone = 0
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k)
        if (w > bestW) {
          bestW = w
          bestBone = skinIndex.getComponent(i, k)
        }
      }
      const bone = bones[bestBone]
      const r = bone ? boneRegion.get(bone) : undefined
      vertexIn[i] = r && regions.has(r) ? 1 : 0
    }

    const groups = src.groups?.length ? src.groups : [{ start: 0, count, materialIndex: 0 }]
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const g of groups) {
      const gCount = Math.min(g.count, count - g.start)
      const mat = mats[Math.min(g.materialIndex ?? 0, mats.length - 1)]
      const inTris: number[] = []
      const outTris: number[] = []
      for (let t = g.start; t + 2 < g.start + gCount; t += 3) {
        const votes = vertexIn[t] + vertexIn[t + 1] + vertexIn[t + 2]
        ;(votes >= 2 ? inTris : outTris).push(t)
      }
      for (const [tris, target] of [
        [inTris, inside],
        [outTris, outside],
      ] as const) {
        if (tris.length === 0) continue
        const geo = sliceTriangles(src, tris)
        const normalized = normalizeGeometry(geo)
        geo.dispose()
        applyMatrixWithWinding(normalized, rel)
        target.push({ geometry: normalized, material: mat })
      }
    }
  })

  return { inside, outside }
}

/** 从非索引几何体中抽取指定三角形（t 为首顶点下标） */
function sliceTriangles(src: THREE.BufferGeometry, triStarts: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute
    const item = a.itemSize
    const arr = new Float32Array(triStarts.length * 3 * item)
    let w = 0
    for (const t of triStarts) {
      for (let v = 0; v < 3; v++) {
        for (let k = 0; k < item; k++) arr[w++] = a.getComponent(t + v, k)
      }
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, item))
  }
  return geo
}

/**
 * 平面切割：pieces 应是与切割平面同一参考系下的静态几何块。
 * 平面由一点与法线定义（可任意旋转），返回法线正侧与负侧两组块。
 */
export function cutByPlane(pieces: BakedPiece[], point: THREE.Vector3, normal: THREE.Vector3): SplitResult {
  const n = normal.clone().normalize()
  const planeD = n.dot(point)
  const inside: BakedPiece[] = []
  const outside: BakedPiece[] = []
  const EPS = 1e-6

  for (const piece of pieces) {
    const src = piece.geometry
    const pos = src.attributes.position as THREE.BufferAttribute
    const attrs = ['position', 'normal', 'uv'] as const
    const sizes = { position: 3, normal: 3, uv: 2 }
    const sideA: number[][] = [[], [], []]
    const sideB: number[][] = [[], [], []]

    const read = (name: (typeof attrs)[number], i: number, out: number[]) => {
      const a = src.attributes[name] as THREE.BufferAttribute
      for (let k = 0; k < sizes[name]; k++) out[k] = a.getComponent(i, k)
    }
    const lerp = (va: number[], vb: number[], t: number, n: number, out: number[]) => {
      for (let k = 0; k < n; k++) out[k] = va[k] + (vb[k] - va[k]) * t
    }
    const push = (side: number[][], vals: number[][]) => {
      for (let ai2 = 0; ai2 < 3; ai2++) side[ai2].push(...vals[ai2])
    }

    const v: number[][][] = [0, 1, 2].map(() => [[], [], []] as number[][])
    const tmpA: number[][] = [[], [], []]
    const tmpB: number[][] = [[], [], []]

    for (let t = 0; t < pos.count; t += 3) {
      const d = [0, 1, 2].map(
        (k) => n.x * pos.getX(t + k) + n.y * pos.getY(t + k) + n.z * pos.getZ(t + k) - planeD,
      )
      const onA = d.map((x) => x >= 0)
      const nA = onA.filter(Boolean).length

      if (nA === 3) {
        for (let k = 0; k < 3; k++) {
          for (let a2 = 0; a2 < 3; a2++) {
            read(attrs[a2], t + k, v[0][a2] as number[])
            sideA[a2].push(...(v[0][a2] as number[]))
          }
        }
        continue
      }
      if (nA === 0) {
        for (let k = 0; k < 3; k++) {
          for (let a2 = 0; a2 < 3; a2++) {
            read(attrs[a2], t + k, v[0][a2] as number[])
            sideB[a2].push(...(v[0][a2] as number[]))
          }
        }
        continue
      }

      // 找单独一侧的顶点，旋转使其为第 0 个（保持绕序）
      const lone = nA === 1 ? onA.indexOf(true) : onA.indexOf(false)
      const order = [lone, (lone + 1) % 3, (lone + 2) % 3]
      const dv = order.map((k) => d[k])
      for (let k = 0; k < 3; k++) {
        for (let a2 = 0; a2 < 3; a2++) read(attrs[a2], t + order[k], v[k][a2] as number[])
      }
      const t1 = Math.abs(dv[0]) / Math.max(Math.abs(dv[0]) + Math.abs(dv[1]), EPS)
      const t2 = Math.abs(dv[0]) / Math.max(Math.abs(dv[0]) + Math.abs(dv[2]), EPS)
      for (let a2 = 0; a2 < 3; a2++) {
        lerp(v[0][a2] as number[], v[1][a2] as number[], t1, sizes[attrs[a2]], tmpA[a2])
        lerp(v[0][a2] as number[], v[2][a2] as number[], t2, sizes[attrs[a2]], tmpB[a2])
      }

      const loneSide = nA === 1 ? sideA : sideB
      const otherSide = nA === 1 ? sideB : sideA
      // 单独侧：三角 (v0, iAB, iCA)
      push(loneSide, [
        [...(v[0][0] as number[]), ...tmpA[0], ...tmpB[0]] as unknown as number[],
        [...(v[0][1] as number[]), ...tmpA[1], ...tmpB[1]] as unknown as number[],
        [...(v[0][2] as number[]), ...tmpA[2], ...tmpB[2]] as unknown as number[],
      ])
      // 另一侧：四边形 (iAB, v1, v2, iCA) → 两个三角
      push(otherSide, [
        [...tmpA[0], ...(v[1][0] as number[]), ...(v[2][0] as number[]), ...tmpA[0], ...(v[2][0] as number[]), ...tmpB[0]] as unknown as number[],
        [...tmpA[1], ...(v[1][1] as number[]), ...(v[2][1] as number[]), ...tmpA[1], ...(v[2][1] as number[]), ...tmpB[1]] as unknown as number[],
        [...tmpA[2], ...(v[1][2] as number[]), ...(v[2][2] as number[]), ...tmpA[2], ...(v[2][2] as number[]), ...tmpB[2]] as unknown as number[],
      ])
    }

    const build = (side: number[][]) => {
      if (side[0].length === 0) return null
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(side[0], 3))
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(side[1], 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(side[2], 2))
      return geo
    }
    const ga = build(sideA)
    const gb = build(sideB)
    if (ga) inside.push({ geometry: ga, material: piece.material })
    if (gb) outside.push({ geometry: gb, material: piece.material })
  }
  return { inside, outside }
}
