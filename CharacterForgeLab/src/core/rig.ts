import * as THREE from 'three'

/** 单根骨骼的本地绑定姿势 */
export interface BonePose {
  pos: THREE.Vector3
  quat: THREE.Quaternion
  scale: THREE.Vector3
}

/**
 * 骨架快照：记录层级、绑定姿势（本地与世界空间），
 * 是重定向与"重置姿势"的数据基础。必须在模型刚加载、还没播放动画时创建。
 */
export interface Rig {
  root: THREE.Object3D
  bones: THREE.Bone[]
  byName: Map<string, THREE.Bone>
  /** 父先子后的遍历顺序 */
  order: THREE.Bone[]
  bindLocal: Map<THREE.Bone, BonePose>
  bindWorldQuat: Map<THREE.Bone, THREE.Quaternion>
  bindWorldPos: Map<THREE.Bone, THREE.Vector3>
  bindWorldMatrix: Map<THREE.Bone, THREE.Matrix4>
  /** 非骨骼父节点（骨架挂点）在绑定时的世界旋转/矩阵，重定向时视为静止 */
  parentWorldQuat: Map<THREE.Bone, THREE.Quaternion>
  parentWorldMatrixInv: Map<THREE.Bone, THREE.Matrix4>
  /** 绑定姿势下最低点的世界 Y（近似地面），用于换算髋部高度比例 */
  groundY: number
}

export function buildRig(root: THREE.Object3D): Rig | null {
  root.updateWorldMatrix(true, true)

  const bones: THREE.Bone[] = []
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone)
  })
  if (bones.length === 0) return null

  const byName = new Map<string, THREE.Bone>()
  for (const b of bones) if (!byName.has(b.name)) byName.set(b.name, b)

  // traverse 是先序深度优先，天然父先子后
  const order = bones.slice()

  const bindLocal = new Map<THREE.Bone, BonePose>()
  const bindWorldQuat = new Map<THREE.Bone, THREE.Quaternion>()
  const bindWorldPos = new Map<THREE.Bone, THREE.Vector3>()
  const bindWorldMatrix = new Map<THREE.Bone, THREE.Matrix4>()
  const parentWorldQuat = new Map<THREE.Bone, THREE.Quaternion>()
  const parentWorldMatrixInv = new Map<THREE.Bone, THREE.Matrix4>()

  let groundY = Infinity
  const wp = new THREE.Vector3()
  const wq = new THREE.Quaternion()
  const ws = new THREE.Vector3()

  for (const b of bones) {
    bindLocal.set(b, {
      pos: b.position.clone(),
      quat: b.quaternion.clone(),
      scale: b.scale.clone(),
    })
    b.matrixWorld.decompose(wp, wq, ws)
    bindWorldQuat.set(b, wq.clone())
    bindWorldPos.set(b, wp.clone())
    bindWorldMatrix.set(b, b.matrixWorld.clone())
    if (wp.y < groundY) groundY = wp.y

    const p = b.parent
    if (p && !(p as THREE.Bone).isBone) {
      p.matrixWorld.decompose(wp, wq, ws)
      parentWorldQuat.set(b, wq.clone())
      parentWorldMatrixInv.set(b, p.matrixWorld.clone().invert())
    } else if (!p) {
      parentWorldQuat.set(b, new THREE.Quaternion())
      parentWorldMatrixInv.set(b, new THREE.Matrix4())
    }
  }

  // 有网格时用包围盒底部作为地面参考，比骨骼位置更准
  const box = new THREE.Box3()
  try {
    box.setFromObject(root)
    if (!box.isEmpty() && isFinite(box.min.y)) groundY = Math.min(groundY, box.min.y)
  } catch {
    // 空层级等极端情况忽略
  }

  return {
    root, bones, byName, order,
    bindLocal, bindWorldQuat, bindWorldPos, bindWorldMatrix,
    parentWorldQuat, parentWorldMatrixInv,
    groundY,
  }
}

/** 把骨架恢复到绑定姿势 */
export function resetRigToBind(rig: Rig): void {
  for (const b of rig.bones) {
    const p = rig.bindLocal.get(b)
    if (!p) continue
    b.position.copy(p.pos)
    b.quaternion.copy(p.quat)
    b.scale.copy(p.scale)
  }
  rig.root.updateWorldMatrix(true, true)
}

/** 收集一个对象树里的全部骨骼名 */
export function collectBoneNames(root: THREE.Object3D): string[] {
  const names: string[] = []
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) names.push(o.name)
  })
  return names
}
