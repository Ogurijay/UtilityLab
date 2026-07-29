/**
 * 粒子精灵渲染：InstancedBufferGeometry + 屏幕对齐 billboard。
 * 逐实例从模拟贴图 texelFetch 取状态，避免每帧回读到 CPU。
 *
 * 色彩空间全部手工处理（RawShaderMaterial 不会被 three 注入转换）：
 * 贴图与渐变按 sRGB 存储、采样时解码到线性；输出端由 uOutputSRGB 决定
 * 是否再编码回 sRGB —— 视口预览为 1，离线烘焙需要线性数据时置 0。
 */
export const COLOR_TRANSFER = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`

export const SPRITE_VERT = /* glsl */ `
precision highp float;
precision highp int;

${COLOR_TRANSFER}

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform sampler2D tPosition;
uniform sampler2D tVelocity;
uniform sampler2D tAttrib;
uniform sampler2D tCurves;   // R=size G=alpha B=erosion
uniform sampler2D tColor;    // 生命渐变（sRGB 编码）
uniform int   uTexSize;
uniform float uBaseSize;

in vec3 position;

out vec2  vUv;
out vec4  vColor;
out float vErosion;
out vec2  vNoiseOffset;

void main() {
  int id = gl_InstanceID;
  ivec2 tc = ivec2(id % uTexSize, id / uTexSize);

  vec4 P = texelFetch(tPosition, tc, 0);
  vec4 V = texelFetch(tVelocity, tc, 0);
  vec4 A = texelFetch(tAttrib, tc, 0);

  float life = V.w;
  float age = P.w;
  bool alive = life > 0.0 && age >= 0.0 && age <= life;
  if (!alive) {
    // 推出裁剪空间，整个实例被剔除
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    vErosion = 0.0;
    vNoiseOffset = vec2(0.0);
    return;
  }

  float t = clamp(age / life, 0.0, 1.0);
  vec4 curve = texture(tCurves, vec2(t, 0.5));
  vec3 tint = srgbToLinear(texture(tColor, vec2(t, 0.5)).rgb);

  float size = max(uBaseSize * curve.r * A.w, 0.0);
  float rot = A.z;
  float c = cos(rot), s = sin(rot);
  vec2 q = position.xy * size;

  vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
  mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = projectionMatrix * mv;

  vUv = position.xy + 0.5;
  vColor = vec4(tint, curve.g);
  vErosion = curve.b;
  vNoiseOffset = vec2(fract(A.y * 7.13), fract(A.y * 19.71));
}
`

export const SPRITE_FRAG = /* glsl */ `
precision highp float;

${COLOR_TRANSFER}

uniform sampler2D tSprite;
uniform sampler2D tNoise;
uniform float uIntensity;
uniform float uErosionAmount;
uniform float uErosionSoftness;
uniform float uErosionScale;
uniform int   uPremultiply;
uniform int   uOutputSRGB;

in vec2  vUv;
in vec4  vColor;
in float vErosion;
in vec2  vNoiseOffset;

out vec4 fragColor;

void main() {
  vec4 sp = texture(tSprite, vUv);
  float a = sp.a * vColor.a;

  if (uErosionAmount > 0.0) {
    float n = texture(tNoise, vUv * uErosionScale + vNoiseOffset).r;
    float thr = vErosion * uErosionAmount;
    a *= smoothstep(thr, thr + max(uErosionSoftness, 1e-3), n);
  }

  if (a <= 0.002) discard;

  vec3 rgb = srgbToLinear(sp.rgb) * vColor.rgb * uIntensity;
  if (uOutputSRGB == 1) rgb = linearToSrgb(rgb);
  if (uPremultiply == 1) rgb *= a;

  fragColor = vec4(rgb, a);
}
`
