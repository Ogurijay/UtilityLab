import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

/**
 * 渲染引擎：负责 WebGL 渲染器、场景、相机、灯光、地面与主循环。
 * 后期合成管线提供选中对象的轮廓描边（OutlinePass）。
 * 三维对象的业务逻辑（角色、挂载等）在 controller 层，不放这里。
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls

  private readonly composer: EffectComposer
  private readonly outlinePass: OutlinePass
  private readonly clock = new THREE.Clock()
  private readonly tickHandlers = new Set<(dt: number) => void>()
  private readonly resizeObserver: ResizeObserver
  private readonly grid: THREE.GridHelper
  private readonly ground: THREE.Mesh
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#171a20')
    this.scene.fog = new THREE.Fog('#171a20', 14, 34)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55
    pmrem.dispose()

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 120)
    this.camera.position.set(2.4, 1.7, 3.4)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 0.95, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.62
    this.controls.minDistance = 0.4
    this.controls.maxDistance = 24

    const hemi = new THREE.HemisphereLight('#cfd9ea', '#3a3f4a', 0.85)
    this.scene.add(hemi)

    const key = new THREE.DirectionalLight('#ffffff', 2.4)
    key.position.set(3.2, 5.5, 3.6)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -4
    key.shadow.camera.right = 4
    key.shadow.camera.top = 5
    key.shadow.camera.bottom = -2
    key.shadow.camera.far = 20
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.02
    this.scene.add(key)

    const rim = new THREE.DirectionalLight('#7ea6ff', 0.7)
    rim.position.set(-3.5, 3.2, -3.2)
    this.scene.add(rim)

    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 64),
      new THREE.ShadowMaterial({ opacity: 0.34 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(9, 64),
      new THREE.MeshStandardMaterial({ color: '#1d2129', roughness: 0.95, metalness: 0 }),
    )
    disc.rotation.x = -Math.PI / 2
    disc.position.y = -0.002
    disc.receiveShadow = true
    this.scene.add(disc)

    this.grid = new THREE.GridHelper(18, 36, '#39414f', '#262c37')
    ;(this.grid.material as THREE.Material).transparent = true
    ;(this.grid.material as THREE.Material).opacity = 0.6
    this.grid.position.y = 0.001
    this.scene.add(this.grid)

    // 后期合成：MSAA 半浮点目标保证抗锯齿，OutputPass 负责色调映射与 sRGB 输出
    const target = new THREE.WebGLRenderTarget(1, 1, {
      samples: 4,
      type: THREE.HalfFloatType,
    })
    this.composer = new EffectComposer(this.renderer, target)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.outlinePass = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera)
    this.outlinePass.edgeStrength = 4.5
    this.outlinePass.edgeThickness = 1.2
    this.outlinePass.edgeGlow = 0
    this.outlinePass.pulsePeriod = 0
    this.composer.addPass(this.outlinePass)
    this.composer.addPass(new OutputPass())

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement ?? canvas)
    this.resize()

    this.renderer.setAnimationLoop(() => this.frame())
  }

  /** 设置轮廓描边的对象与颜色（空数组清除描边） */
  setOutline(objects: THREE.Object3D[], color?: string): void {
    this.outlinePass.selectedObjects = objects
    if (color) {
      this.outlinePass.visibleEdgeColor.set(color)
      this.outlinePass.hiddenEdgeColor.set(color).multiplyScalar(0.35)
    }
  }

  private resize(): void {
    const el = this.renderer.domElement.parentElement
    if (!el) return
    const w = Math.max(1, el.clientWidth)
    const h = Math.max(1, el.clientHeight)
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private frame(): void {
    if (this.disposed) return
    const dt = Math.min(this.clock.getDelta(), 0.1)
    for (const fn of this.tickHandlers) fn(dt)
    this.controls.update()
    this.composer.render()
  }

  onTick(fn: (dt: number) => void): () => void {
    this.tickHandlers.add(fn)
    return () => this.tickHandlers.delete(fn)
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v
  }

  /** 让相机取景对准某个对象 */
  frameObject(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.5
    const dist = Math.max(0.6, (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.35)
    const dir = new THREE.Vector3(0.55, 0.32, 1).normalize()
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.controls.update()
  }

  /** 截取当前画面为 PNG dataURL */
  screenshot(): string {
    this.composer.render()
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose(): void {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }
}
