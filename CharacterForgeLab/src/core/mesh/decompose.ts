import * as THREE from 'three'
import type { BakedPiece } from './bake'

type NumericArray =
  | Int8Array | Uint8Array | Uint8ClampedArray
  | Int16Array | Uint16Array | Int32Array | Uint32Array
  | Float32Array | Float64Array

function vertexKey(position: THREE.BufferAttribute, index: number, precision = 100000): string {
  return `${Math.round(position.getX(index) * precision)},${Math.round(position.getY(index) * precision)},${Math.round(position.getZ(index) * precision)}`
}

function faceVertexIndices(geometry: THREE.BufferGeometry, faceIndex: number): [number, number, number] {
  const index = geometry.getIndex()
  const offset = faceIndex * 3
  if (index) return [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)]
  return [offset, offset + 1, offset + 2]
}

function faceCount(geometry: THREE.BufferGeometry): number {
  const count = geometry.getIndex()?.count || geometry.getAttribute('position')?.count || 0
  return Math.floor(count / 3)
}

function connectedFaceSets(geometry: THREE.BufferGeometry): Set<number>[] {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position) return []
  const total = faceCount(geometry)
  const neighbors = Array.from({ length: total }, () => new Set<number>())
  const edgeFaces = new Map<string, number[]>()

  for (let face = 0; face < total; face += 1) {
    const keys = faceVertexIndices(geometry, face).map((index) => vertexKey(position, index))
    for (const [left, right] of [[0, 1], [1, 2], [2, 0]] as const) {
      const edge = keys[left] < keys[right]
        ? `${keys[left]}|${keys[right]}`
        : `${keys[right]}|${keys[left]}`
      const faces = edgeFaces.get(edge) ?? []
      faces.push(face)
      edgeFaces.set(edge, faces)
    }
  }

  for (const faces of edgeFaces.values()) {
    if (faces.length < 2) continue
    for (const left of faces) {
      for (const right of faces) if (left !== right) neighbors[left].add(right)
    }
  }

  const unseen = new Set(neighbors.map((_value, index) => index))
  const components: Set<number>[] = []
  while (unseen.size) {
    const seed = unseen.values().next().value as number
    const component = new Set<number>([seed])
    const queue = [seed]
    unseen.delete(seed)
    while (queue.length) {
      const face = queue.shift()!
      for (const neighbor of neighbors[face]) {
        if (component.has(neighbor)) continue
        component.add(neighbor)
        unseen.delete(neighbor)
        queue.push(neighbor)
      }
    }
    components.push(component)
  }
  return components.sort((left, right) => right.size - left.size)
}

function copyAttributeForFaces(
  attribute: THREE.BufferAttribute,
  geometry: THREE.BufferGeometry,
  faces: readonly number[],
): THREE.BufferAttribute {
  const ArrayType = attribute.array.constructor as {
    new(length: number): NumericArray
  }
  const values = new ArrayType(faces.length * 3 * attribute.itemSize)
  let output = 0
  for (const face of faces) {
    for (const sourceIndex of faceVertexIndices(geometry, face)) {
      for (let component = 0; component < attribute.itemSize; component += 1) {
        values[output++] = attribute.getComponent(sourceIndex, component)
      }
    }
  }
  return new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized)
}

function extractFacesGeometry(source: THREE.BufferGeometry, faceSelection: ReadonlySet<number>): THREE.BufferGeometry {
  const faces = [...faceSelection].sort((left, right) => left - right)
  const geometry = new THREE.BufferGeometry()
  for (const [name, raw] of Object.entries(source.attributes)) {
    const attribute = raw as THREE.BufferAttribute
    geometry.setAttribute(name, copyAttributeForFaces(attribute, source, faces))
  }
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * 把已经烘焙好的静态几何块按拓扑连通关系拆开。
 * 相互没有共享边的壳体会成为独立组件，适合处理“一个 FBX 网格里塞了多件物品”的情况。
 */
export function splitPiecesByConnectedComponents(pieces: readonly BakedPiece[]): BakedPiece[] {
  const output: BakedPiece[] = []
  for (const piece of pieces) {
    const components = connectedFaceSets(piece.geometry)
    if (components.length <= 1) {
      output.push({ geometry: piece.geometry.clone(), material: piece.material })
      continue
    }
    for (const component of components) {
      output.push({
        geometry: extractFacesGeometry(piece.geometry, component),
        material: piece.material,
      })
    }
  }
  return output
}
