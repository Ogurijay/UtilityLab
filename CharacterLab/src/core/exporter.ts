import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/** 把对象树导出为 GLB 二进制 Blob */
export async function exportGlbBlob(
  object: THREE.Object3D,
  opts: { clips?: THREE.AnimationClip[] } = {},
): Promise<Blob> {
  const exporter = new GLTFExporter()
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      object,
      (out) => resolve(out as ArrayBuffer),
      (err) => reject(err instanceof Error ? err : new Error('GLB 导出失败')),
      { binary: true, animations: opts.clips ?? [], embedImages: true },
    )
  })
  return new Blob([buffer], { type: 'model/gltf-binary' })
}
