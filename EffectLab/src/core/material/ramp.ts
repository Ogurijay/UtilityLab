import * as THREE from 'three'
import type { CurvePoint, CurvesSpec, GradientStop } from '../../types'

export const RAMP_WIDTH = 512

export function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
export function linearToSrgb(c: number) {
  const v = Math.max(0, c)
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim()
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0')
  return [
    parseInt(n.slice(0, 2), 16) / 255,
    parseInt(n.slice(2, 4), 16) / 255,
    parseInt(n.slice(4, 6), 16) / 255,
  ]
}

export function rgbToHex(rgb: [number, number, number]) {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`
}

/** 分段线性求值，端点外取端点值 */
export function evalCurve(points: CurvePoint[], t: number): number {
  if (points.length === 0) return 1
  const pts = [...points].sort((a, b) => a.t - b.t)
  if (t <= pts[0].t) return pts[0].v
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const k = span <= 1e-6 ? 0 : (t - a.t) / span
      return a.v + (b.v - a.v) * k
    }
  }
  return pts[pts.length - 1].v
}

/** 渐变求值。在线性空间插值（火焰这类高亮渐变的中间色才不会发灰），返回 sRGB 分量。 */
export function evalGradient(stops: GradientStop[], t: number): [number, number, number] {
  if (stops.length === 0) return [1, 1, 1]
  const s = [...stops].sort((a, b) => a.t - b.t)
  const pick = (i: number) => hexToRgb(s[i].color).map(srgbToLinear) as [number, number, number]
  let lin: [number, number, number]
  if (t <= s[0].t) lin = pick(0)
  else if (t >= s[s.length - 1].t) lin = pick(s.length - 1)
  else {
    lin = pick(s.length - 1)
    for (let i = 0; i < s.length - 1; i++) {
      if (t >= s[i].t && t <= s[i + 1].t) {
        const span = s[i + 1].t - s[i].t
        const k = span <= 1e-6 ? 0 : (t - s[i].t) / span
        const a = pick(i)
        const b = pick(i + 1)
        lin = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
        break
      }
    }
  }
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])]
}

function makeRampTexture(data: Uint8Array) {
  const tex = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RGBAFormat)
  tex.colorSpace = THREE.NoColorSpace // 传输函数在着色器里手工处理
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

/** R=尺寸 G=透明度 B=溶解阈值，8 位线性数据 */
export function buildCurveTexture(curves: CurvesSpec, existing?: THREE.DataTexture) {
  const data = new Uint8Array(RAMP_WIDTH * 4)
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const t = i / (RAMP_WIDTH - 1)
    const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
    data[i * 4 + 0] = q(evalCurve(curves.size, t))
    data[i * 4 + 1] = q(evalCurve(curves.alpha, t))
    data[i * 4 + 2] = q(evalCurve(curves.erosion, t))
    data[i * 4 + 3] = 255
  }
  if (existing) {
    ;(existing.image.data as Uint8Array).set(data)
    existing.needsUpdate = true
    return existing
  }
  return makeRampTexture(data)
}

/** 生命渐变，按 sRGB 编码存储，着色器采样后解码 */
export function buildColorTexture(stops: GradientStop[], existing?: THREE.DataTexture) {
  const data = new Uint8Array(RAMP_WIDTH * 4)
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const t = i / (RAMP_WIDTH - 1)
    const c = evalGradient(stops, t)
    data[i * 4 + 0] = Math.round(Math.min(1, Math.max(0, c[0])) * 255)
    data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, c[1])) * 255)
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, c[2])) * 255)
    data[i * 4 + 3] = 255
  }
  if (existing) {
    ;(existing.image.data as Uint8Array).set(data)
    existing.needsUpdate = true
    return existing
  }
  return makeRampTexture(data)
}

/** 给界面用的 CSS 渐变串 */
export function gradientToCss(stops: GradientStop[]) {
  const s = [...stops].sort((a, b) => a.t - b.t)
  if (s.length === 0) return 'linear-gradient(90deg, #000, #000)'
  const parts: string[] = []
  for (let i = 0; i <= 16; i++) {
    const t = i / 16
    parts.push(`${rgbToHex(evalGradient(s, t))} ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`
}
