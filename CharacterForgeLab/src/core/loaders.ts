import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import type { AssetKind } from '../types'

export interface ParsedAsset {
  object: THREE.Object3D
  clips: THREE.AnimationClip[]
  boneNames: string[]
  hasMesh: boolean
  hasSkinnedMesh: boolean
}

export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj']

export function fileExtension(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

let gltfLoader: GLTFLoader | null = null
function getGltfLoader(): GLTFLoader {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader()
    // Draco 压缩网格的解码器走 CDN，普通 GLB 不需要联网
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    gltfLoader.setDRACOLoader(draco)
  }
  return gltfLoader
}

/** 从原始文件内容解析三维资源（glb / gltf / fbx / obj） */
export async function parseAssetFile(buffer: ArrayBuffer, filename: string): Promise<ParsedAsset> {
  const ext = fileExtension(filename)
  let object: THREE.Object3D
  let clips: THREE.AnimationClip[] = []

  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>(
      (resolve, reject) => {
        try {
          getGltfLoader().parse(buffer, '', resolve, (e) =>
            reject(e instanceof Error ? e : new Error('glTF 解析失败（外部引用的 .gltf 请改用 .glb）')),
          )
        } catch (e) {
          reject(e)
        }
      },
    )
    object = gltf.scene
    clips = gltf.animations ?? []
  } else if (ext === 'fbx') {
    const group = new FBXLoader().parse(buffer, '')
    object = group
    clips = (group.animations ?? []).filter((c) => c.tracks.length > 0)
  } else if (ext === 'obj') {
    const text = new TextDecoder().decode(buffer)
    object = new OBJLoader().parse(text)
  } else {
    throw new Error(`不支持的格式 .${ext}（支持 GLB / GLTF / FBX / OBJ）`)
  }

  object.updateWorldMatrix(true, true)

  let hasMesh = false
  let hasSkinnedMesh = false
  const boneNames: string[] = []
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) hasMesh = true
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkinnedMesh = true
    if ((o as THREE.Bone).isBone) boneNames.push(o.name)
    o.castShadow = true
    o.receiveShadow = true
  })

  // 部分 FBX 动画自带空轨道或 0 时长轨道，清理掉
  clips = clips.filter((c) => c.duration > 0 && c.tracks.length > 0)
  clips.forEach((c, i) => {
    if (!c.name || c.name === 'Take 001' || c.name === 'mixamo.com') {
      c.name = filename.replace(/\.[^.]+$/, '') + (clips.length > 1 ? `_${i + 1}` : '')
    }
  })

  return { object, clips, boneNames, hasMesh, hasSkinnedMesh }
}

/** 根据解析结果推断资源类型 */
export function classifyAsset(parsed: ParsedAsset): AssetKind {
  if (parsed.hasSkinnedMesh) return 'model'
  if (parsed.clips.length > 0 && parsed.boneNames.length > 0) return 'anim'
  if (!parsed.hasMesh && parsed.boneNames.length > 0) return 'anim'
  return 'prop'
}

/** 递归释放对象树占用的 GPU 资源；keepMaterials 用于材质被新对象复用的场合 */
export function disposeObject(root: THREE.Object3D, opts: { keepMaterials?: boolean } = {}): void {
  const skeletons = new Set<THREE.Skeleton>()
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (mesh.geometry) mesh.geometry.dispose()
    // 骨架的 boneTexture 与材质共享无关，始终释放
    if (mesh.isSkinnedMesh && mesh.skeleton) skeletons.add(mesh.skeleton)
    if (opts.keepMaterials) return
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const m of mats) {
      for (const value of Object.values(m)) {
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose()
      }
      m.dispose()
    }
  })
  for (const s of skeletons) s.dispose()
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}

export function formatBytes(n: number): string {
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
