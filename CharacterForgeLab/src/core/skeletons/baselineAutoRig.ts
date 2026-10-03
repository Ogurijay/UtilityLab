import * as THREE from 'three'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { bakeMeshesStatic, mergePieces } from '../mesh/bake'
import { buildRig } from '../rig'
import { centerObjectOnGround } from '../modelPlacement'

const MAIN_BONE = /^(root|pelvis|hips|spine\d*|neck\d*|head|clavicle[lr]|upperarm[lr]|lowerarm[lr]|hand[lr]|thigh[lr]|calf[lr]|foot[lr]|ball[lr])$/

function key(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function skeletonOnlyClone(root: THREE.Object3D, profileId: string): THREE.Object3D {
  const clone = SkeletonUtils.clone(root)
  const meshes: THREE.Object3D[] = []
  clone.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object)
  })
  for (const mesh of meshes) mesh.removeFromParent()
  clone.name = `Rig_${profileId}`
  return clone
}
export interface PreparedBaselineRig {
  root: THREE.Object3D
  rig: NonNullable<ReturnType<typeof buildRig>>
}

/**
 * 按目标人物的包围盒缩放、居中基准骨架，但暂不生成蒙皮。
 * 返回的骨架可直接放进视口，让用户在绑定前拖动关节点做人工适配。
 */
export function prepareBaselineRig(
  baselineRoot: THREE.Object3D,
  targetBounds: THREE.Box3,
  profileId: string,
): PreparedBaselineRig {
  const targetSize = targetBounds.getSize(new THREE.Vector3())
  if (targetSize.y < 0.01) throw new Error('人物高度异常，无法准备骨架')

  const rigRoot = skeletonOnlyClone(baselineRoot, profileId)
  const baselineBounds = new THREE.Box3().setFromObject(baselineRoot)
  const baselineHeight = baselineBounds.getSize(new THREE.Vector3()).y
  if (baselineHeight < 0.01) throw new Error('系统基准模型高度异常')
  rigRoot.scale.multiplyScalar(targetSize.y / baselineHeight)
  rigRoot.updateWorldMatrix(true, true)

  const initialRig = buildRig(rigRoot)
  if (!initialRig) throw new Error('系统基准没有骨骼')
  const rigBounds = new THREE.Box3()
  for (const bone of initialRig.bones) {
    rigBounds.expandByPoint(bone.getWorldPosition(new THREE.Vector3()))
  }
  const targetCenter = targetBounds.getCenter(new THREE.Vector3())
  const rigCenter = rigBounds.getCenter(new THREE.Vector3())
  rigRoot.position.add(targetCenter.sub(rigCenter))
  rigRoot.updateWorldMatrix(true, true)

  const rig = buildRig(rigRoot)
  if (!rig) throw new Error('系统基准骨架克隆失败')
  return { root: rigRoot, rig }
}

interface Segment {
  boneIndex: number
  start: THREE.Vector3
  end: THREE.Vector3
  lengthSq: number
}

function buildSegments(bones: THREE.Bone[]): Segment[] {
  const accepted = new Set(
    bones.filter((bone) => MAIN_BONE.test(key(bone.name)) && !/(twist|ik|finger|thumb)/.test(key(bone.name))),
  )
  const segments: Segment[] = []
  bones.forEach((bone, boneIndex) => {
    if (!accepted.has(bone)) return
    let child = bone.children.find((item) => (item as THREE.Bone).isBone && accepted.has(item as THREE.Bone)) as THREE.Bone | undefined
    if (!child) {
      bone.traverse((item) => {
        if (!child && item !== bone && (item as THREE.Bone).isBone && accepted.has(item as THREE.Bone)) {
          child = item as THREE.Bone
        }
      })
    }
    const start = bone.getWorldPosition(new THREE.Vector3())
    let end = child?.getWorldPosition(new THREE.Vector3())
    if (!end || start.distanceToSquared(end) < 1e-12) {
      const parent = (bone.parent as THREE.Bone | null)?.isBone
        ? bone.parent!.getWorldPosition(new THREE.Vector3())
        : start.clone().add(new THREE.Vector3(0, 0.02, 0))
      end = start.clone().add(start.clone().sub(parent).multiplyScalar(0.45))
    }
    segments.push({ boneIndex, start, end, lengthSq: start.distanceToSquared(end) })
  })
  if (!segments.length) throw new Error('基准骨架里没有可用于蒙皮的主要骨骼段')
  return segments
}

function pointSegmentDistanceSq(point: THREE.Vector3, segment: Segment): number {
  if (segment.lengthSq < 1e-12) return point.distanceToSquared(segment.start)
  const direction = segment.end.clone().sub(segment.start)
  const t = THREE.MathUtils.clamp(
    point.clone().sub(segment.start).dot(direction) / segment.lengthSq,
    0,
    1,
  )
  return point.distanceToSquared(segment.start.clone().addScaledVector(direction, t))
}

async function addEnvelopeWeights(
  geometry: THREE.BufferGeometry,
  segments: Segment[],
  bodyHeight: number,
  onProgress?: (value: number) => void,
): Promise<void> {
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!positions) throw new Error('静态网格没有顶点位置')
  const indices = new Uint16Array(positions.count * 4)
  const weights = new Float32Array(positions.count * 4)
  const point = new THREE.Vector3()
  const softness = Math.max(bodyHeight * 0.018, 0.0001)

  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    if (vertex > 0 && vertex % 12000 === 0) {
      onProgress?.(vertex / positions.count)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    point.fromBufferAttribute(positions, vertex)
    const nearest = segments
      .map((segment) => ({
        index: segment.boneIndex,
        distance: pointSegmentDistanceSq(point, segment),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 4)
    const scores = nearest.map((item) => 1 / Math.pow(Math.sqrt(item.distance) + softness, 2))
    const total = scores.reduce((sum, value) => sum + value, 0) || 1
    for (let slot = 0; slot < 4; slot += 1) {
      indices[vertex * 4 + slot] = nearest[slot]?.index || 0
      weights[vertex * 4 + slot] = (scores[slot] || 0) / total
    }
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  onProgress?.(1)
}

/**
 * 使用真实 Manny / UEFN 基准的完整骨骼层级为静态人物生成基础四权重蒙皮。
 * 输出是派生角色，输入人物和基准模型均保持只读。
 */
export async function autoRigToBaseline(
  sourceModel: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  baselineRoot: THREE.Object3D,
  profileId: string,
  name: string,
  preparedRigRoot?: THREE.Object3D,
  onProgress?: (value: number) => void,
): Promise<{ group: THREE.Group; boneCount: number; vertexCount: number }> {
  const pieces = bakeMeshesStatic(sourceModel, sourceRoot)
  const merged = mergePieces(pieces)
  if (!merged) throw new Error('当前人物没有可蒙皮的网格')
  const { geometry, materials } = merged
  geometry.computeBoundingBox()
  const targetBounds = geometry.boundingBox!
  const targetSize = targetBounds.getSize(new THREE.Vector3())
  if (targetSize.y < 0.01) throw new Error('人物高度异常，无法生成骨架')

  const rigRoot = preparedRigRoot
    ? skeletonOnlyClone(preparedRigRoot, profileId)
    : prepareBaselineRig(baselineRoot, targetBounds, profileId).root

  const group = new THREE.Group()
  group.name = `${name}·${profileId}`
  group.add(rigRoot)
  group.updateWorldMatrix(true, true)

  const rig = buildRig(rigRoot)
  if (!rig) throw new Error('系统基准骨架克隆失败')
  const skeleton = new THREE.Skeleton(rig.bones)
  const segments = buildSegments(rig.bones)
  await addEnvelopeWeights(geometry, segments, targetSize.y, onProgress)

  const mesh = new THREE.SkinnedMesh(geometry, materials.length === 1 ? materials[0] : materials)
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  group.add(mesh)
  group.updateWorldMatrix(true, true)
  skeleton.calculateInverses()
  mesh.bind(skeleton, mesh.matrixWorld)
  centerObjectOnGround(group)
  return {
    group,
    boneCount: rig.bones.length,
    vertexCount: geometry.getAttribute('position').count,
  }
}
