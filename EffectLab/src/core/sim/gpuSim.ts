import * as THREE from 'three'
import { FULLSCREEN_VERT, SIM_FRAG } from '../glsl/sim'
import type { EffectSpec, EmissionMode, EmitterShape } from '../../types'

const SHAPE_INDEX: Record<EmitterShape, number> = {
  point: 0,
  sphere: 1,
  box: 2,
  disc: 3,
  cone: 4,
}
const MODE_INDEX: Record<EmissionMode, number> = { continuous: 0, burst: 1 }

function makeTarget(size: number) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    count: 3,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  for (const tex of rt.textures) tex.colorSpace = THREE.NoColorSpace
  return rt
}

/**
 * GPGPU 粒子求解器。位置 / 速度 / 属性三张贴图靠 MRT 一次写出，
 * 双缓冲 ping-pong；时间只通过 `step(dt)` 推进，绝不读挂钟，
 * 因此同一 seed + 同一步长序列必然复现同一结果。
 */
export class GpuSim {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private material: THREE.RawShaderMaterial
  private quad: THREE.Mesh
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private current = 0

  texSize = 0
  count = 0
  time = 0
  frame = 0

  constructor(renderer: THREE.WebGLRenderer, capacity: number) {
    this.renderer = renderer
    const gl = renderer.getContext()
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('EffectLab 需要 WebGL2。')
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('缺少 EXT_color_buffer_float 扩展，无法进行浮点 GPU 模拟。')
    }

    this.texSize = GpuSim.texSizeFor(capacity)
    this.count = this.texSize * this.texSize

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SIM_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tPosition: { value: null },
        tVelocity: { value: null },
        tAttrib: { value: null },
        uInit: { value: 0 },
        uTexSize: { value: this.texSize },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uFrame: { value: 0 },
        uSeed: { value: 1 },

        uShape: { value: 1 },
        uMode: { value: 0 },
        uRate: { value: 1000 },
        uBurstInterval: { value: 1 },
        uEmitPos: { value: new THREE.Vector3() },
        uEmitDir: { value: new THREE.Vector3(0, 1, 0) },
        uEmitRadius: { value: 0.2 },
        uBoxSize: { value: new THREE.Vector3(1, 1, 1) },
        uConeAngle: { value: 20 },
        uSpeed: { value: 1 },
        uSpeedJitter: { value: 0.3 },
        uRadialSpeed: { value: 0 },
        uLifetime: { value: 2 },
        uLifeJitter: { value: 0.3 },
        uSizeJitter: { value: 0.3 },
        uRotSpeed: { value: 0.5 },

        uGravity: { value: -1 },
        uBuoyancy: { value: 0 },
        uDrag: { value: 0.5 },
        uWind: { value: new THREE.Vector3() },
        uTurb: { value: 0 },
        uTurbScale: { value: 1 },
        uTurbEvolve: { value: 0.2 },
        uVortex: { value: 0 },
        uVortexAxis: { value: new THREE.Vector3(0, 1, 0) },
        uAttract: { value: 0 },
        uAttractPos: { value: new THREE.Vector3() },

        uPlaneOn: { value: 0 },
        uPlaneY: { value: 0 },
        uSphereOn: { value: 0 },
        uSphereC: { value: new THREE.Vector3() },
        uSphereR: { value: 1 },
        uRestitution: { value: 0.4 },
        uFriction: { value: 0.2 },
        uKill: { value: 0 },
      },
    })

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.targets = [makeTarget(this.texSize), makeTarget(this.texSize)]
    this.reset()
  }

  static texSizeFor(capacity: number) {
    return Math.max(4, Math.min(1024, Math.ceil(Math.sqrt(Math.max(16, capacity)))))
  }

  get positionTexture() {
    return this.targets[this.current].textures[0]
  }
  get velocityTexture() {
    return this.targets[this.current].textures[1]
  }
  get attribTexture() {
    return this.targets[this.current].textures[2]
  }

  /** 容量变化时重建贴图；返回是否真的重建了 */
  resize(capacity: number) {
    const size = GpuSim.texSizeFor(capacity)
    if (size === this.texSize) return false
    this.targets.forEach((t) => t.dispose())
    this.texSize = size
    this.count = size * size
    this.material.uniforms.uTexSize.value = size
    this.targets = [makeTarget(size), makeTarget(size)]
    this.reset()
    return true
  }

  reset() {
    this.time = 0
    this.frame = 0
    this.material.uniforms.uInit.value = 1
    for (let i = 0; i < 2; i++) {
      this.current = i
      this.renderPass(this.targets[i])
    }
    this.material.uniforms.uInit.value = 0
    this.current = 0
  }

  private renderPass(target: THREE.WebGLRenderTarget) {
    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(prev)
  }

  /** 推进一个固定步长。dt 必须是常量，否则结果不可复现。 */
  step(dt: number) {
    const u = this.material.uniforms
    const src = this.targets[this.current]
    const dst = this.targets[1 - this.current]

    u.tPosition.value = src.textures[0]
    u.tVelocity.value = src.textures[1]
    u.tAttrib.value = src.textures[2]
    u.uDt.value = dt
    u.uTime.value = this.time
    u.uFrame.value = this.frame

    this.renderPass(dst)

    this.current = 1 - this.current
    this.time += dt
    this.frame += 1
  }

  applySpec(spec: EffectSpec) {
    const u = this.material.uniforms
    const { emitter: e, forces: f, collision: c, sim: s } = spec

    u.uSeed.value = s.seed | 0
    u.uShape.value = SHAPE_INDEX[e.shape]
    u.uMode.value = MODE_INDEX[e.mode]
    u.uRate.value = e.rate
    u.uBurstInterval.value = e.burstInterval
    ;(u.uEmitPos.value as THREE.Vector3).fromArray(e.position)
    ;(u.uEmitDir.value as THREE.Vector3).fromArray(e.direction)
    u.uEmitRadius.value = e.radius
    ;(u.uBoxSize.value as THREE.Vector3).fromArray(e.boxSize)
    u.uConeAngle.value = e.coneAngle
    u.uSpeed.value = e.speed
    u.uSpeedJitter.value = e.speedJitter
    u.uRadialSpeed.value = e.radialSpeed
    u.uLifetime.value = e.lifetime
    u.uLifeJitter.value = e.lifetimeJitter
    u.uSizeJitter.value = e.sizeJitter
    u.uRotSpeed.value = e.rotationSpeed

    u.uGravity.value = f.gravity
    u.uBuoyancy.value = f.buoyancy
    u.uDrag.value = f.drag
    ;(u.uWind.value as THREE.Vector3).fromArray(f.wind)
    u.uTurb.value = f.turbulence
    u.uTurbScale.value = f.turbulenceScale
    u.uTurbEvolve.value = f.turbulenceEvolve
    u.uVortex.value = f.vortexStrength
    ;(u.uVortexAxis.value as THREE.Vector3).fromArray(f.vortexAxis)
    u.uAttract.value = f.attractorStrength
    ;(u.uAttractPos.value as THREE.Vector3).fromArray(f.attractorPosition)

    u.uPlaneOn.value = c.planeEnabled ? 1 : 0
    u.uPlaneY.value = c.planeHeight
    u.uSphereOn.value = c.sphereEnabled ? 1 : 0
    ;(u.uSphereC.value as THREE.Vector3).fromArray(c.sphereCenter)
    u.uSphereR.value = c.sphereRadius
    u.uRestitution.value = c.restitution
    u.uFriction.value = c.friction
    u.uKill.value = c.killOnCollide
  }

  dispose() {
    this.targets.forEach((t) => t.dispose())
    this.quad.geometry.dispose()
    this.material.dispose()
  }
}
