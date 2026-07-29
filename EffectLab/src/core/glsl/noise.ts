/**
 * 共享 GLSL 噪声与随机函数。
 *
 * `snoise(vec3)` 为 Ashima Arts / Stefan Gustavson 的 3D simplex noise
 * （webgl-noise，作者 Ian McEwan，MIT 许可）。其余为本项目实现。
 * 参见 https://github.com/ashima/webgl-noise —— MIT License。
 *
 * 所有随机数都走整数 hash，不依赖时间或 GPU 端的不确定行为，
 * 保证同一 seed + 同一固定步长得到逐像素一致的模拟结果（烘焙的前提）。
 */
export const GLSL_RANDOM = /* glsl */ `
uint uhash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16; return x;
}
float rnd(inout uint s) { s = uhash(s); return float(s) * (1.0 / 4294967296.0); }
vec2 rnd2(inout uint s) { return vec2(rnd(s), rnd(s)); }
vec3 rnd3(inout uint s) { return vec3(rnd(s), rnd(s), rnd(s)); }
/** 均匀分布在单位球内 */
vec3 rndInBall(inout uint s) {
  vec3 d = normalize(rnd3(s) * 2.0 - 1.0 + 1e-5);
  return d * pow(rnd(s), 1.0 / 3.0);
}
/** 绕 axis 的锥内随机方向，half 为半角（弧度） */
vec3 rndInCone(inout uint s, vec3 axis, float half_) {
  float cosMax = cos(clamp(half_, 0.0, 3.14159265));
  float c = mix(1.0, cosMax, rnd(s));
  float sn = sqrt(max(0.0, 1.0 - c * c));
  float phi = rnd(s) * 6.28318531;
  vec3 a = normalize(axis);
  vec3 up = abs(a.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, a));
  vec3 b = cross(a, t);
  return normalize(a * c + (t * cos(phi) + b * sin(phi)) * sn);
}
`

export const GLSL_SIMPLEX = /* glsl */ `
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289_4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289_4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289_3(i);
  vec4 p = permute4(permute4(permute4(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

vec3 snoiseVec3(vec3 p) {
  return vec3(
    snoise(p),
    snoise(p + vec3(31.416, 17.234, 7.913)),
    snoise(p - vec3(53.117, 23.719, 11.371))
  );
}

/** 无散度旋度噪声：粒子湍流的标准做法，不会把粒子压成团 */
vec3 curlNoise(vec3 p) {
  const float e = 0.12;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 px0 = snoiseVec3(p - dx), px1 = snoiseVec3(p + dx);
  vec3 py0 = snoiseVec3(p - dy), py1 = snoiseVec3(p + dy);
  vec3 pz0 = snoiseVec3(p - dz), pz1 = snoiseVec3(p + dz);
  float cx = (py1.z - py0.z) - (pz1.y - pz0.y);
  float cy = (pz1.x - pz0.x) - (px1.z - px0.z);
  float cz = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3(cx, cy, cz) / (2.0 * e) * 0.25;
}
`

/** 精确可平铺（周期性）的二维噪声，用于溶解遮罩等需要无缝的贴图。 */
export const GLSL_TILEABLE = /* glsl */ `
float hashCell(vec2 c, float seed) {
  vec3 p3 = fract(vec3(c.x, c.y, c.x + seed) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoiseTiled(vec2 p, float period, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hashCell(mod(i + vec2(0.0, 0.0), period), seed);
  float b = hashCell(mod(i + vec2(1.0, 0.0), period), seed);
  float c = hashCell(mod(i + vec2(0.0, 1.0), period), seed);
  float d = hashCell(mod(i + vec2(1.0, 1.0), period), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbmTiled(vec2 p, float period, int octaves, float seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0, per = period;
  vec2 q = p;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoiseTiled(q, per, seed + float(i) * 13.7);
    norm += amp;
    q *= 2.0; per *= 2.0; amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

float worleyTiled(vec2 p, float period, float seed) {
  vec2 i = floor(p), f = fract(p);
  float best = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, period);
      vec2 o = vec2(hashCell(cell, seed), hashCell(cell, seed + 7.31));
      best = min(best, length(g + o - f));
    }
  }
  return clamp(best, 0.0, 1.0);
}
`
