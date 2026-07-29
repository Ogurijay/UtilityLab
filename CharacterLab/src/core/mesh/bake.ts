import * as THREE from 'three'

/**
 * 网格静态烘焙工具：把（可能带蒙皮 / 层级变换的）模型压成
 * 统一属性集（position / normal / uv）、非索引、指定参考系下的静态几何体。
 * 是切割、拼装、自动蒙皮共用的前置步骤。
 */

export interface BakedPiece {
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

/** 交错缓冲属性（部分 glTF / Draco 输出）先去交错成普通属性，后续才能安全按 array 切片 */
export function toPlainAttribute(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    return (attr as THREE.InterleavedBufferAttribute).clone() as unknown as THREE.BufferAttribute
  }
  return attr as THREE.BufferAttribute
}

/** 统一为非索引 + position/normal/uv 三属性（缺 uv 补零，缺 normal 重算） */
export function normalizeGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = src.index ? src.toNonIndexed() : src.clone()
  // clone 路径可能保留交错属性，统一转普通属性
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name]
    if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
      geo.setAttribute(name, toPlainAttribute(a))
    }
  }
  const count = geo.attributes.position.count
  if (!geo.attributes.normal) geo.computeVertexNormals()
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
  }
  // 只保留三件套，避免 merge 时属性集不一致
  const keep = new Set(['position', 'normal', 'uv'])
  for (const name of Object.keys(geo.attributes)) {
    if (!keep.has(name)) geo.deleteAttribute(name)
  }
  geo.morphAttributes = {}
  return geo
}

/** 从非索引几何体截取 [start, start+count) 顶点段（兼容交错属性） */
export function sliceVertexRange(src: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const piece = new THREE.BufferGeometry()
  for (const [name, rawAttr] of Object.entries(src.attributes)) {
    const a = toPlainAttribute(rawAttr as THREE.BufferAttribute)
    const slice = new Float32Array(count * a.itemSize)
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < a.itemSize; k++) slice[i * a.itemSize + k] = a.getComponent(start + i, k)
    }
    piece.setAttribute(name, new THREE.BufferAttribute(slice, a.itemSize))
  }
  return piece
}

/** 施加矩阵；行列式为负（镜像）时翻转三角形绕序，保证法线朝向正确 */
export function applyMatrixWithWinding(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
  geo.applyMatrix4(m)
  if (m.determinant() < 0) {
    for (const name of ['position', 'normal', 'uv']) {
      const attr = geo.attributes[name] as THREE.BufferAttribute | undefined
      if (!attr) continue
      const item = attr.itemSize
      const arr = attr.array as Float32Array
      for (let tri = 0; tri < attr.count / 3; tri++) {
        const a = tri * 3
        const b = tri * 3 + 1
        for (let k = 0; k < item; k++) {
          const tmp = arr[a * item + k]
          arr[a * item + k] = arr[b * item + k]
          arr[b * item + k] = tmp
        }
      }
      attr.needsUpdate = true
    }
    geo.computeVertexNormals()
  }
}

/**
 * 把 root 下所有网格烘焙成 relTo 参考系下的静态几何块。
 * 蒙皮网格按当前姿势的节点变换处理（调用方应先回到绑定姿势）。
 */
export function bakeMeshesStatic(root: THREE.Object3D, relTo: THREE.Object3D): BakedPiece[] {
  root.updateWorldMatrix(true, true)
  relTo.updateWorldMatrix(true, false)
  const invRel = relTo.matrixWorld.clone().invert()
  const out: BakedPiece[] = []

  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.visible) return
    const rel = invRel.clone().multiply(mesh.matrixWorld)
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const groups = mesh.geometry.groups?.length
      ? mesh.geometry.groups
      : [{ start: 0, count: Infinity, materialIndex: 0 }]

    // 按材质组拆开，每块单一材质，后续合并时重新分组
    const nonIndexed = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
    for (const g of groups) {
      const mat = mats[Math.min(g.materialIndex ?? 0, mats.length - 1)]
      if (!mat) continue
      const start = g.start
      const count = g.count === Infinity ? nonIndexed.attributes.position.count - start : Math.min(g.count, nonIndexed.attributes.position.count - start)
      if (count <= 0) continue
      const piece = sliceVertexRange(nonIndexed, start, count)
      const normalized = normalizeGeometry(piece)
      piece.dispose()
      applyMatrixWithWinding(normalized, rel)
      out.push({ geometry: normalized, material: mat })
    }
  })
  return out
}

/** 把多个几何块按材质合并为一个带分组的几何体 */
export function mergePieces(pieces: BakedPiece[]): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } | null {
  const valid = pieces.filter((p) => p.geometry.attributes.position?.count > 0)
  if (valid.length === 0) return null

  // 相同材质的块并到一起，减少 draw call 与材质数量
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
  for (const p of valid) {
    const list = byMat.get(p.material) ?? []
    list.push(p.geometry)
    byMat.set(p.material, list)
  }

  const materials: THREE.Material[] = []
  const geometry = new THREE.BufferGeometry()
  let total = 0
  const chunks: { geos: THREE.BufferGeometry[]; count: number }[] = []
  for (const [mat, geos] of byMat) {
    materials.push(mat)
    const count = geos.reduce((s, g) => s + g.attributes.position.count, 0)
    chunks.push({ geos, count })
    total += count
  }

  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  let offset = 0
  let matIndex = 0
  for (const chunk of chunks) {
    geometry.addGroup(offset, chunk.count, matIndex++)
    for (const g of chunk.geos) {
      const n = g.attributes.position.count
      pos.set(g.attributes.position.array as Float32Array, offset * 3)
      nor.set(g.attributes.normal.array as Float32Array, offset * 3)
      uv.set(g.attributes.uv.array as Float32Array, offset * 2)
      offset += n
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return { geometry, materials }
}

/** 由几何块组装一个可入库 / 可展示的静态模型组 */
export function piecesToGroup(pieces: BakedPiece[], name: string): THREE.Group | null {
  const merged = mergePieces(pieces)
  if (!merged) return null
  const mesh = new THREE.Mesh(merged.geometry, merged.materials)
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  const group = new THREE.Group()
  group.name = name
  group.add(mesh)
  return group
}
