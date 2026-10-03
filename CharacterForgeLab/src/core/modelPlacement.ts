import * as THREE from 'three'

export interface PlacementCorrection {
  /** 在父节点坐标系内施加到对象的位置修正量。 */
  offset: THREE.Vector3
  /** 修正前、位于父节点坐标系内的可见网格包围盒。 */
  bounds: THREE.Box3
}

function isInsideExcludedRoot(
  object: THREE.Object3D,
  excludedRoots: ReadonlySet<THREE.Object3D>,
  stopAt: THREE.Object3D,
): boolean {
  for (let current: THREE.Object3D | null = object; current && current !== stopAt; current = current.parent) {
    if (excludedRoots.has(current)) return true
  }
  return false
}

function isEffectivelyVisible(object: THREE.Object3D, stopAt: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false
    if (current === stopAt) break
  }
  return true
}

/**
 * 精确计算对象下所有可见网格在父节点坐标系内的包围盒。
 *
 * Mesh.getVertexPosition() 会同时处理 Morph（形态键）和 SkinnedMesh（蒙皮网格），
 * 因此比只读 geometry.boundingBox 更适合人物归位。
 */
export function computeVisibleMeshBoundsInParent(
  object: THREE.Object3D,
  excludedRoots: readonly THREE.Object3D[] = [],
): THREE.Box3 {
  object.parent?.updateWorldMatrix(true, false)
  object.updateWorldMatrix(true, true)
  const parentInverse = object.parent
    ? object.parent.matrixWorld.clone().invert()
    : new THREE.Matrix4()
  const excluded = new Set(excludedRoots)
  const bounds = new THREE.Box3()
  const point = new THREE.Vector3()

  object.traverse((candidate) => {
    const mesh = candidate as THREE.Mesh
    const position = mesh.geometry?.getAttribute('position')
    if (!mesh.isMesh || !position || !isEffectivelyVisible(mesh, object)) return
    if (isInsideExcludedRoot(mesh, excluded, object)) return

    for (let index = 0; index < position.count; index += 1) {
      mesh.getVertexPosition(index, point)
      point.applyMatrix4(mesh.matrixWorld).applyMatrix4(parentInverse)
      bounds.expandByPoint(point)
    }
  })
  return bounds
}

/**
 * 保持对象内部层级、骨架和蒙皮的相对关系不变，只移动共同父节点：
 * 水平中心归到 X/Z=0，最低点落到 Y=0。
 */
export function centerObjectOnGround(
  object: THREE.Object3D,
  excludedRoots: readonly THREE.Object3D[] = [],
): PlacementCorrection | null {
  const bounds = computeVisibleMeshBoundsInParent(object, excludedRoots)
  if (bounds.isEmpty()) return null

  const center = bounds.getCenter(new THREE.Vector3())
  const offset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z)
  if (![offset.x, offset.y, offset.z].every(Number.isFinite)) return null

  object.position.add(offset)
  object.updateWorldMatrix(true, true)
  return { offset, bounds }
}