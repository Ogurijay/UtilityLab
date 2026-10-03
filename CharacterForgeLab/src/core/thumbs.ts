import * as THREE from 'three'

/** 离屏小渲染器：为资源生成 144×144 的缩略图 dataURL */
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null

const SIZE = 144

function ensure(): boolean {
  if (renderer) return true
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setSize(SIZE, SIZE, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping

    scene = new THREE.Scene()
    const key = new THREE.DirectionalLight('#ffffff', 2.6)
    key.position.set(2, 3, 4)
    scene.add(key)
    const fill = new THREE.DirectionalLight('#9db4d8', 1.1)
    fill.position.set(-3, 1, -2)
    scene.add(fill)
    scene.add(new THREE.AmbientLight('#404652', 1.4))

    camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100)
    return true
  } catch {
    return false
  }
}

/** 渲染一个对象的缩略图；失败返回 undefined */
export function renderThumbnail(object: THREE.Object3D): string | undefined {
  if (!ensure() || !renderer || !scene || !camera) return undefined
  try {
    scene.add(object)
    object.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) {
      scene.remove(object)
      return undefined
    }
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z, 0.001) * 0.5
    const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.25
    camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist))
    camera.lookAt(center)
    renderer.render(scene, camera)
    const url = renderer.domElement.toDataURL('image/png')
    scene.remove(object)
    return url
  } catch {
    if (object.parent === scene) scene.remove(object)
    return undefined
  }
}
