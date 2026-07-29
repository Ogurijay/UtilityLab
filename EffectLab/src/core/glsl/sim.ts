import { GLSL_RANDOM, GLSL_SIMPLEX } from './noise'

/** 全屏三角/四边形的顶点着色器：直接输出裁剪空间坐标。 */
export const FULLSCREEN_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

/**
 * 粒子求解器（一次 MRT 输出三张贴图）：
 *   layout 0  position.xyz + age
 *   layout 1  velocity.xyz + lifetime   （lifetime <= 0 表示从未出生）
 *   layout 2  cycle, rand01, rotation, sizeScale
 *
 * 出生时机完全由「时间 → cycle」的解析式决定，不累加计数器，
 * 因此从任意时刻重跑都能得到相同结果，这是后续离线烘焙的基础。
 */
export const SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;

${GLSL_RANDOM}
${GLSL_SIMPLEX}

uniform sampler2D tPosition;
uniform sampler2D tVelocity;
uniform sampler2D tAttrib;

uniform int   uInit;
uniform int   uTexSize;
uniform float uTime;
uniform float uDt;
uniform int   uFrame;
uniform int   uSeed;

uniform int   uShape;          // 0 point / 1 sphere / 2 box / 3 disc / 4 cone
uniform int   uMode;           // 0 continuous / 1 burst
uniform float uRate;
uniform float uBurstInterval;
uniform vec3  uEmitPos;
uniform vec3  uEmitDir;
uniform float uEmitRadius;
uniform vec3  uBoxSize;
uniform float uConeAngle;      // 度
uniform float uSpeed;
uniform float uSpeedJitter;
uniform float uRadialSpeed;
uniform float uLifetime;
uniform float uLifeJitter;
uniform float uSizeJitter;
uniform float uRotSpeed;

uniform float uGravity;
uniform float uBuoyancy;
uniform float uDrag;
uniform vec3  uWind;
uniform float uTurb;
uniform float uTurbScale;
uniform float uTurbEvolve;
uniform float uVortex;
uniform vec3  uVortexAxis;
uniform float uAttract;
uniform vec3  uAttractPos;

uniform int   uPlaneOn;
uniform float uPlaneY;
uniform int   uSphereOn;
uniform vec3  uSphereC;
uniform float uSphereR;
uniform float uRestitution;
uniform float uFriction;
uniform float uKill;

layout(location = 0) out vec4 oPosition;
layout(location = 1) out vec4 oVelocity;
layout(location = 2) out vec4 oAttrib;

void emitDead() {
  oPosition = vec4(0.0, 0.0, 0.0, 1.0);
  oVelocity = vec4(0.0, 0.0, 0.0, -1.0);
  oAttrib = vec4(-1.0, 0.0, 0.0, 1.0);
}

void main() {
  if (uInit == 1) { emitDead(); return; }

  ivec2 tc = ivec2(gl_FragCoord.xy);
  int id = tc.y * uTexSize + tc.x;

  vec4 P = texelFetch(tPosition, tc, 0);
  vec4 V = texelFetch(tVelocity, tc, 0);
  vec4 A = texelFetch(tAttrib, tc, 0);

  // ---- 出生排程：由时间解析求出当前应处于第几个发射周期 ----
  float cycle, birth;
  if (uMode == 0) {
    float rate = max(uRate, 1e-3);
    float period = float(uTexSize * uTexSize) / rate;
    float slot = float(id) / rate;
    cycle = floor((uTime - slot) / period);
    birth = slot + cycle * period;
  } else {
    float interval = max(uBurstInterval, 1e-3);
    cycle = floor(uTime / interval);
    birth = cycle * interval;
  }

  if (cycle >= 0.0 && cycle > A.x + 0.5) {
    uint s = uhash(uint(id) * 747796405u + uint(int(cycle)) * 2891336453u + uint(uSeed));

    vec3 localPos = vec3(0.0);
    vec3 radialDir = normalize(uEmitDir + vec3(1e-6));
    if (uShape == 1) {
      vec3 b = rndInBall(s);
      localPos = b * uEmitRadius;
      radialDir = normalize(b + vec3(1e-6));
    } else if (uShape == 2) {
      vec3 r = rnd3(s) * 2.0 - 1.0;
      localPos = r * uBoxSize * 0.5;
      radialDir = normalize(r + vec3(1e-6));
    } else if (uShape == 3) {
      float ang = rnd(s) * 6.28318531;
      float rr = sqrt(rnd(s)) * uEmitRadius;
      localPos = vec3(cos(ang) * rr, 0.0, sin(ang) * rr);
      radialDir = normalize(vec3(cos(ang), 0.0, sin(ang)));
    }

    vec3 dir = rndInCone(s, uEmitDir, radians(uConeAngle));
    float sp = uSpeed * (1.0 + (rnd(s) * 2.0 - 1.0) * uSpeedJitter);
    float life = max(0.02, uLifetime * (1.0 + (rnd(s) * 2.0 - 1.0) * uLifeJitter));
    float sizeScale = max(0.05, 1.0 + (rnd(s) * 2.0 - 1.0) * uSizeJitter);
    float rand01 = rnd(s);
    float rot = rnd(s) * 6.28318531;

    oPosition = vec4(uEmitPos + localPos, max(0.0, uTime - birth));
    oVelocity = vec4(dir * sp + radialDir * uRadialSpeed, life);
    oAttrib = vec4(cycle, rand01, rot, sizeScale);
    return;
  }

  // ---- 未出生 / 已死亡：原样透传 ----
  float life = V.w;
  if (life <= 0.0) { oPosition = P; oVelocity = V; oAttrib = A; return; }

  float age = P.w + uDt;
  if (age > life) { oPosition = vec4(P.xyz, age); oVelocity = V; oAttrib = A; return; }

  // ---- 力场积分（半隐式欧拉，固定步长）----
  float t = clamp(age / life, 0.0, 1.0);
  vec3 pos = P.xyz;
  vec3 vel = V.xyz;

  vec3 acc = vec3(0.0, uGravity + uBuoyancy * (1.0 - t), 0.0) + uWind;
  if (uTurb != 0.0) {
    acc += curlNoise(pos * uTurbScale + vec3(uTurbEvolve * uTime)) * uTurb;
  }
  if (uVortex != 0.0) {
    vec3 ax = normalize(uVortexAxis + vec3(1e-6));
    vec3 tangent = cross(ax, pos - uEmitPos);
    float d = length(tangent);
    if (d > 1e-4) acc += tangent / d * uVortex;
  }
  if (uAttract != 0.0) {
    vec3 d = uAttractPos - pos;
    float len = length(d);
    if (len > 1e-4) acc += d / len * uAttract / (1.0 + len * len * 0.25);
  }

  vel += acc * uDt;
  vel *= exp(-max(uDrag, 0.0) * uDt);
  pos += vel * uDt;

  // ---- 碰撞 ----
  uint cs = uhash(uint(id) * 2654435761u + uint(uFrame) * 40503u + uint(uSeed));
  if (uPlaneOn == 1 && pos.y < uPlaneY) {
    pos.y = uPlaneY;
    float vn = min(dot(vel, vec3(0.0, 1.0, 0.0)), 0.0);
    vec3 vt = vel - vec3(0.0, vn, 0.0);
    vel = vt * (1.0 - uFriction) - vec3(0.0, vn, 0.0) * uRestitution;
    if (uKill > 0.0 && rnd(cs) < uKill) age = life + 1.0;
  }
  if (uSphereOn == 1) {
    vec3 d = pos - uSphereC;
    float len = length(d);
    if (len < uSphereR && len > 1e-5) {
      vec3 n = d / len;
      pos = uSphereC + n * uSphereR;
      float vn = min(dot(vel, n), 0.0);
      vec3 vt = vel - n * vn;
      vel = vt * (1.0 - uFriction) - n * vn * uRestitution;
      if (uKill > 0.0 && rnd(cs) < uKill) age = life + 1.0;
    }
  }

  oPosition = vec4(pos, age);
  oVelocity = vec4(vel, life);
  oAttrib = vec4(A.x, A.y, A.z + (A.y * 2.0 - 1.0) * uRotSpeed * uDt, A.w);
}
`
