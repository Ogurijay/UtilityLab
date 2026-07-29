import * as THREE from 'three'
import { SPRITE_FRAG, SPRITE_VERT } from '../glsl/sprite'
import type { BlendMode, MaterialSpec } from '../../types'

function applyBlend(mat: THREE.RawShaderMaterial, mode: BlendMode) {
  mat.transparent = true
  mat.depthWrite = false
  mat.depthTest = true
  if (mode === 'additive') {
    mat.blending = THREE.AdditiveBlending
    mat.uniforms.uPremultiply.value = 0
  } else if (mode === 'premultiplied') {
    mat.blending = THREE.CustomBlending
    mat.blendSrc = THREE.OneFactor
    mat.blendDst = THREE.OneMinusSrcAlphaFactor
    mat.blendEquation = THREE.AddEquation
    mat.uniforms.uPremultiply.value = 1
  } else {
    mat.blending = THREE.NormalBlending
    mat.uniforms.uPremultiply.value = 0
  }
  mat.needsUpdate = true
}

/** 实例化 billboard 粒子渲染器。逐实例状态直接从模拟贴图取，无 CPU 回读。 */
export class SpriteRenderer {
  readonly mesh: THREE.Mesh
  private material: THREE.RawShaderMaterial
  private geometry: THREE.InstancedBufferGeometry
  private blend: BlendMode = 'additive'

  constructor() {
    const plane = new THREE.PlaneGeometry(1, 1)
    this.geometry = new THREE.InstancedBufferGeometry()
    this.geometry.index = plane.index
    this.geometry.setAttribute('position', plane.getAttribute('position'))
    this.geometry.instanceCount = 0
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    plane.dispose()

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      uniforms: {
        tPosition: { value: null },
        tVelocity: { value: null },
        tAttrib: { value: null },
        tCurves: { value: null },
        tColor: { value: null },
        tSprite: { value: null },
        tNoise: { value: null },
        uTexSize: { value: 4 },
        uBaseSize: { value: 0.3 },
        uIntensity: { value: 1 },
        uErosionAmount: { value: 0 },
        uErosionSoftness: { value: 0.15 },
        uErosionScale: { value: 1 },
        uPremultiply: { value: 0 },
        uOutputSRGB: { value: 1 },
      },
    })
    applyBlend(this.material, this.blend)

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
  }

  setSimTextures(position: THREE.Texture, velocity: THREE.Texture, attrib: THREE.Texture, texSize: number, count: number) {
    const u = this.material.uniforms
    u.tPosition.value = position
    u.tVelocity.value = velocity
    u.tAttrib.value = attrib
    u.uTexSize.value = texSize
    this.geometry.instanceCount = count
  }

  setRampTextures(curves: THREE.Texture, color: THREE.Texture) {
    this.material.uniforms.tCurves.value = curves
    this.material.uniforms.tColor.value = color
  }

  setSprite(tex: THREE.Texture | null) {
    this.material.uniforms.tSprite.value = tex
  }

  setNoise(tex: THREE.Texture | null) {
    this.material.uniforms.tNoise.value = tex
  }

  /** 烘焙需要线性数据，预览需要 sRGB 显示 */
  setOutputSRGB(on: boolean) {
    this.material.uniforms.uOutputSRGB.value = on ? 1 : 0
  }

  applyMaterialSpec(spec: MaterialSpec) {
    const u = this.material.uniforms
    u.uBaseSize.value = spec.baseSize
    u.uIntensity.value = spec.intensity
    u.uErosionAmount.value = spec.erosionAmount
    u.uErosionSoftness.value = spec.erosionSoftness
    u.uErosionScale.value = spec.erosionScale
    if (spec.blend !== this.blend) {
      this.blend = spec.blend
      applyBlend(this.material, this.blend)
    }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
