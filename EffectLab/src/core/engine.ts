import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GpuSim } from './sim/gpuSim'
import { SpriteRenderer } from './render/spriteRenderer'
import { TextureFactory } from './material/procedural'
import { buildColorTexture, buildCurveTexture } from './material/ramp'
import type { EffectSpec } from '../types'

// 色彩空间全部由本项目的着色器手工处理，关掉 three 的自动转换，
// 免得预览与后续离线烘焙之间出现两套隐式转换。
THREE.ColorManagement.enabled = false

export interface EngineStats {
  simTime: number
  frame: number
  capacity: number
  fps: number
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly sim: GpuSim
  readonly sprites = new SpriteRenderer()
  readonly textures: TextureFactory

  private container: HTMLElement
  private resizeObserver: ResizeObserver
  private lastWidth = 0
  private lastHeight = 0
  private raf = 0
  private lastTime = 0
  private accumulator = 0
  private fpsEma = 60
  private spec: EffectSpec
  private curveTex: THREE.DataTexture
  private colorTex: THREE.DataTexture
  private userTextures = new Map<string, THREE.Texture>()
  private helpers: THREE.Group
  private emitterHelper: THREE.LineSegments | null = null
  private planeHelper: THREE.Mesh
  private sphereHelper: THREE.LineSegments
  private helperShapeKey = ''

  playing = true
  onStats: ((s: EngineStats) => void) | null = null

  constructor(container: HTMLElement, spec: EffectSpec) {
    this.container = container
    this.spec = spec

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setClearColor(0x0a0c11, 1)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500)
    this.camera.position.set(0, 1.6, 4.2)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.target.set(0, 1, 0)

    this.textures = new TextureFactory(this.renderer)
    this.sim = new GpuSim(this.renderer, spec.emitter.capacity)

    this.curveTex = buildCurveTexture(spec.curves)
    this.colorTex = buildColorTexture(spec.curves.color)
    this.sprites.setRampTextures(this.curveTex, this.colorTex)
    this.scene.add(this.sprites.mesh)

    // --- 辅助显示 ---
    this.helpers = new THREE.Group()
    const grid = new THREE.GridHelper(10, 20, 0x2a3140, 0x171c26)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.55
    this.helpers.add(grid)

    this.planeHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({ color: 0x3d6bff, transparent: true, opacity: 0.08, side: THREE.DoubleSide })
    )
    this.planeHelper.rotation.x = -Math.PI / 2
    this.planeHelper.visible = false
    this.helpers.add(this.planeHelper)

    this.sphereHelper = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 12)),
      new THREE.LineBasicMaterial({ color: 0x3d6bff, transparent: true, opacity: 0.35 })
    )
    this.sphereHelper.visible = false
    this.helpers.add(this.sphereHelper)
    this.scene.add(this.helpers)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()

    this.applySpec(spec, true)
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    if (w === this.lastWidth && h === this.lastHeight) return
    this.lastWidth = w
    this.lastHeight = h
    // updateStyle 传 false：canvas 的 CSS 尺寸由样式表锁成 100%，
    // 不让绘图缓冲尺寸反过来影响布局
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  setUserTexture(id: string, tex: THREE.Texture) {
    const old = this.userTextures.get(id)
    if (old && old !== tex) old.dispose()
    this.userTextures.set(id, tex)
    this.refreshMaterialTextures()
  }

  removeUserTexture(id: string) {
    this.userTextures.get(id)?.dispose()
    this.userTextures.delete(id)
    this.refreshMaterialTextures()
  }

  private resolve(id: string, fallback: string) {
    if (id.startsWith('lib:')) {
      const tex = this.userTextures.get(id.slice(4))
      if (tex) return tex
    }
    return this.textures.get(id) ?? this.textures.get(fallback)
  }

  private refreshMaterialTextures() {
    this.sprites.setSprite(this.resolve(this.spec.material.sprite, 'builtin:puff'))
    this.sprites.setNoise(this.resolve(this.spec.material.noise, 'builtin:fbm'))
  }

  applySpec(spec: EffectSpec, rebuildAll = false) {
    const prev = this.spec
    this.spec = spec

    if (rebuildAll || spec.emitter.capacity !== prev.emitter.capacity) {
      this.sim.resize(spec.emitter.capacity)
    }
    this.sim.applySpec(spec)

    if (rebuildAll || spec.curves !== prev.curves) {
      buildCurveTexture(spec.curves, this.curveTex)
      buildColorTexture(spec.curves.color, this.colorTex)
    }

    this.sprites.applyMaterialSpec(spec.material)
    if (
      rebuildAll ||
      spec.material.sprite !== prev.material.sprite ||
      spec.material.noise !== prev.material.noise
    ) {
      this.refreshMaterialTextures()
    }

    // 辅助体
    const c = spec.collision
    this.planeHelper.visible = c.planeEnabled
    this.planeHelper.position.y = c.planeHeight
    this.sphereHelper.visible = c.sphereEnabled
    this.sphereHelper.position.fromArray(c.sphereCenter)
    this.sphereHelper.scale.setScalar(Math.max(c.sphereRadius, 1e-3))
    this.updateEmitterHelper()
  }

  private updateEmitterHelper() {
    const e = this.spec.emitter
    const key = `${e.shape}|${e.radius}|${e.boxSize.join(',')}`
    if (key !== this.helperShapeKey) {
      this.helperShapeKey = key
      if (this.emitterHelper) {
        this.helpers.remove(this.emitterHelper)
        this.emitterHelper.geometry.dispose()
      }
      let geo: THREE.BufferGeometry
      if (e.shape === 'box') geo = new THREE.BoxGeometry(e.boxSize[0], e.boxSize[1], e.boxSize[2])
      else if (e.shape === 'disc') geo = new THREE.CylinderGeometry(e.radius, e.radius, 0.001, 24, 1, true)
      else geo = new THREE.SphereGeometry(Math.max(e.radius, 0.02), 14, 10)
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xff9c3d, transparent: true, opacity: 0.3 })
      )
      geo.dispose()
      this.emitterHelper = wire
      this.helpers.add(wire)
    }
    this.emitterHelper?.position.fromArray(this.spec.emitter.position)
  }

  setHelpersVisible(v: boolean) {
    this.helpers.visible = v
  }

  restart() {
    this.sim.reset()
    this.accumulator = 0
  }

  /** 暂停时手动推进一帧 */
  stepOnce() {
    this.sim.step(1 / this.spec.sim.simFps)
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop)
    const delta = this.lastTime === 0 ? 0 : Math.min((now - this.lastTime) / 1000, 0.25)
    this.lastTime = now
    if (delta > 0) this.fpsEma = this.fpsEma * 0.92 + (1 / delta) * 0.08

    if (this.playing) {
      const dt = 1 / Math.max(1, this.spec.sim.simFps)
      this.accumulator += delta
      let steps = 0
      while (this.accumulator >= dt && steps < this.spec.sim.maxSubSteps) {
        this.sim.step(dt)
        this.accumulator -= dt
        steps++
      }
      if (steps >= this.spec.sim.maxSubSteps) this.accumulator = 0
    }

    this.sprites.setSimTextures(
      this.sim.positionTexture,
      this.sim.velocityTexture,
      this.sim.attribTexture,
      this.sim.texSize,
      this.sim.count
    )
    this.controls.update()
    this.renderer.render(this.scene, this.camera)

    this.onStats?.({
      simTime: this.sim.time,
      frame: this.sim.frame,
      capacity: this.sim.count,
      fps: this.fpsEma,
    })
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.sim.dispose()
    this.sprites.dispose()
    this.textures.dispose()
    this.curveTex.dispose()
    this.colorTex.dispose()
    this.userTextures.forEach((t) => t.dispose())
    this.userTextures.clear()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
