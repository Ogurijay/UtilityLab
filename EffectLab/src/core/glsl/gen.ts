import { GLSL_TILEABLE } from './noise'

/**
 * 程序化贴图生成着色器。仓库规则禁止提交贴图资产，
 * 所以内置精灵与噪声全部在运行时用 GPU 生成，没有任何图片文件。
 *
 * 噪声类使用精确周期的格点 hash，四边严格无缝；
 * 精灵类不需要平铺，边缘强制衰减到 0，避免图集里出现方形接缝。
 */
export const GEN_FRAG = /* glsl */ `
precision highp float;

${GLSL_TILEABLE}

uniform int   uMode;
uniform float uSeed;
uniform float uScale;
uniform float uResolution;

out vec4 fragColor;

float edgeFade(float r) { return smoothstep(1.0, 0.82, r); }

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 c = uv - 0.5;
  float r = length(c) * 2.0;

  // --- 精灵 ---
  if (uMode == 0) {                      // puff：带 FBM 扰动的软球，用于烟
    float n = fbmTiled(uv * 4.0, 4.0, 5, uSeed);
    float falloff = pow(clamp(1.0 - r, 0.0, 1.0), 1.7);
    float a = falloff * mix(0.45, 1.0, n) * edgeFade(r);
    fragColor = vec4(1.0, 1.0, 1.0, clamp(a, 0.0, 1.0));
    return;
  }
  if (uMode == 1) {                      // spark：锐核 + 弱辉光，用于火星
    float core = pow(clamp(1.0 - r, 0.0, 1.0), 7.0);
    float glow = pow(clamp(1.0 - r, 0.0, 1.0), 1.8) * 0.28;
    fragColor = vec4(1.0, 1.0, 1.0, clamp((core + glow) * edgeFade(r), 0.0, 1.0));
    return;
  }
  if (uMode == 2) {                      // flame：向上收口的水滴
    float y = clamp(uv.y, 0.0, 1.0);
    float halfW = 0.5 * sin(3.14159265 * pow(y, 0.62));
    float d = abs(uv.x - 0.5) / max(halfW, 1e-3);
    float n = fbmTiled(uv * 5.0, 5.0, 4, uSeed);
    float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.4) * mix(0.5, 1.0, n);
    a *= smoothstep(0.0, 0.12, y) * smoothstep(1.0, 0.86, y);
    fragColor = vec4(1.0, 1.0, 1.0, clamp(a, 0.0, 1.0));
    return;
  }
  if (uMode == 3) {                      // ring：冲击波环
    float a = exp(-pow((r - 0.74) / 0.13, 2.0));
    fragColor = vec4(1.0, 1.0, 1.0, clamp(a * edgeFade(r), 0.0, 1.0));
    return;
  }
  if (uMode == 4) {                      // disc：干净的软圆，做基础遮罩
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.2);
    fragColor = vec4(1.0, 1.0, 1.0, clamp(a * edgeFade(r), 0.0, 1.0));
    return;
  }

  // --- 无缝噪声 ---
  float v;
  if (uMode == 11) {
    v = 1.0 - worleyTiled(uv * uScale, uScale, uSeed);
  } else if (uMode == 12) {
    float f = fbmTiled(uv * uScale, uScale, 5, uSeed);
    v = 1.0 - abs(f * 2.0 - 1.0);                       // ridged，纤维状
  } else {
    v = fbmTiled(uv * uScale, uScale, 5, uSeed);        // uMode == 10
  }
  v = clamp(v, 0.0, 1.0);
  fragColor = vec4(v, v, v, 1.0);
}
`

export const BUILTIN_SPRITES = [
  { id: 'builtin:puff', label: '烟团 puff', mode: 0 },
  { id: 'builtin:spark', label: '火星 spark', mode: 1 },
  { id: 'builtin:flame', label: '火舌 flame', mode: 2 },
  { id: 'builtin:ring', label: '冲击环 ring', mode: 3 },
  { id: 'builtin:disc', label: '软圆 disc', mode: 4 },
] as const

export const BUILTIN_NOISES = [
  { id: 'builtin:fbm', label: 'FBM 云雾', mode: 10, scale: 4 },
  { id: 'builtin:worley', label: 'Worley 细胞', mode: 11, scale: 5 },
  { id: 'builtin:ridged', label: 'Ridged 纤维', mode: 12, scale: 4 },
] as const
