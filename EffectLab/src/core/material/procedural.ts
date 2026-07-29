import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../glsl/sim'
import { BUILTIN_NOISES, BUILTIN_SPRITES, GEN_FRAG } from '../glsl/gen'

const SPRITE_SIZE = 256
const NOISE_SIZE = 256

type GenSpec = { mode: number; scale: number; size: number; repeat: boolean }

function lookup(id: string): GenSpec | null {
  const sprite = BUILTIN_SPRITES.find((s) => s.id === id)
  if (sprite) return { mode: sprite.mode, scale: 1, size: SPRITE_SIZE, repeat: false }
  const noise = BUILTIN_NOISES.find((n) => n.id === id)
  if (noise) return { mode: noise.mode, scale: noise.scale, size: NOISE_SIZE, repeat: true }
  return null
}

/**
 * 内置精灵与噪声的 GPU 生成器。
 * 仓库不允许提交贴图资产，所有内置图案都在运行时算出来，结果缓存复用。
 */
export class TextureFactory {
  private cache = new Map<string, THREE.Texture>()
  private targets: THREE.WebGLRenderTarget[] = []
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private material: THREE.RawShaderMaterial

  constructor(private renderer: THREE.WebGLRenderer) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: GEN_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        uMode: { value: 0 },
        uSeed: { value: 3.17 },
        uScale: { value: 4 },
        uResolution: { value: SPRITE_SIZE },
      },
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
  }

  /** 取内置贴图；未知 id 返回 null，由调用方回退 */
  get(id: string): THREE.Texture | null {
    const cached = this.cache.get(id)
    if (cached) return cached
    const spec = lookup(id)
    if (!spec) return null

    const rt = new THREE.WebGLRenderTarget(spec.size, spec.size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    })
    rt.texture.colorSpace = THREE.NoColorSpace
    rt.texture.wrapS = spec.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
    rt.texture.wrapT = rt.texture.wrapS

    this.material.uniforms.uMode.value = spec.mode
    this.material.uniforms.uScale.value = spec.scale
    this.material.uniforms.uResolution.value = spec.size

    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(rt)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(prev)

    this.targets.push(rt)
    this.cache.set(id, rt.texture)
    return rt.texture
  }

  dispose() {
    this.targets.forEach((t) => t.dispose())
    this.targets = []
    this.cache.clear()
    this.material.dispose()
  }
}

/** 从用户导入的图片创建贴图。色彩空间标记为 NoColorSpace，转换在着色器里做。 */
export async function textureFromBlob(blob: Blob, repeat: boolean): Promise<THREE.Texture> {
  // ImageBitmap 不支持 texture.flipY，改在解码阶段翻转
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' })
  const tex = new THREE.Texture(bitmap)
  tex.flipY = false
  tex.colorSpace = THREE.NoColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  tex.wrapT = tex.wrapS
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}
