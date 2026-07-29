import type { EffectSpec } from '../types'

export function defaultSpec(): EffectSpec {
  return {
    version: 1,
    name: '新建特效',
    emitter: {
      shape: 'disc',
      mode: 'continuous',
      rate: 800,
      burstInterval: 2,
      capacity: 4096,
      position: [0, 0.05, 0],
      direction: [0, 1, 0],
      radius: 0.2,
      boxSize: [0.6, 0.2, 0.6],
      coneAngle: 15,
      speed: 1,
      speedJitter: 0.35,
      radialSpeed: 0,
      lifetime: 1.4,
      lifetimeJitter: 0.3,
      sizeJitter: 0.35,
      rotationSpeed: 0.6,
    },
    forces: {
      gravity: 0,
      buoyancy: 1.2,
      drag: 1,
      wind: [0, 0, 0],
      turbulence: 0.6,
      turbulenceScale: 1.4,
      turbulenceEvolve: 0.4,
      vortexStrength: 0,
      vortexAxis: [0, 1, 0],
      attractorStrength: 0,
      attractorPosition: [0, 1, 0],
    },
    collision: {
      planeEnabled: false,
      planeHeight: 0,
      sphereEnabled: false,
      sphereCenter: [0, 0.6, 0],
      sphereRadius: 0.5,
      restitution: 0.35,
      friction: 0.25,
      killOnCollide: 0,
    },
    curves: {
      size: [
        { t: 0, v: 0.35 },
        { t: 0.3, v: 1 },
        { t: 1, v: 0.25 },
      ],
      alpha: [
        { t: 0, v: 0 },
        { t: 0.15, v: 1 },
        { t: 0.6, v: 0.7 },
        { t: 1, v: 0 },
      ],
      erosion: [
        { t: 0, v: 0 },
        { t: 1, v: 0.85 },
      ],
      color: [
        { t: 0, color: '#fff3c4' },
        { t: 0.2, color: '#ffb43c' },
        { t: 0.55, color: '#ff5a1e' },
        { t: 1, color: '#3a0d02' },
      ],
    },
    material: {
      blend: 'additive',
      sprite: 'builtin:puff',
      noise: 'builtin:fbm',
      baseSize: 0.4,
      intensity: 1.4,
      erosionAmount: 0.8,
      erosionSoftness: 0.25,
      erosionScale: 1.3,
    },
    sim: { seed: 1337, simFps: 60, maxSubSteps: 4 },
  }
}

export function cloneSpec(spec: EffectSpec): EffectSpec {
  return JSON.parse(JSON.stringify(spec)) as EffectSpec
}

/** 载入外部 JSON 时与默认值逐段合并，缺字段不至于炸掉 */
export function normalizeSpec(input: unknown): EffectSpec {
  const base = defaultSpec()
  if (!input || typeof input !== 'object') return base
  const raw = input as Partial<EffectSpec>
  return {
    version: 1,
    name: typeof raw.name === 'string' ? raw.name : base.name,
    emitter: { ...base.emitter, ...(raw.emitter ?? {}) },
    forces: { ...base.forces, ...(raw.forces ?? {}) },
    collision: { ...base.collision, ...(raw.collision ?? {}) },
    curves: { ...base.curves, ...(raw.curves ?? {}) },
    material: { ...base.material, ...(raw.material ?? {}) },
    sim: { ...base.sim, ...(raw.sim ?? {}) },
  }
}

function make(name: string, patch: (s: EffectSpec) => void): EffectSpec {
  const s = defaultSpec()
  s.name = name
  patch(s)
  return s
}

export const BUILTIN_PRESETS: EffectSpec[] = [
  make('火焰 Fire', (s) => {
    s.emitter = {
      ...s.emitter,
      shape: 'disc',
      rate: 1300,
      capacity: 4096,
      radius: 0.18,
      coneAngle: 12,
      speed: 0.9,
      speedJitter: 0.45,
      radialSpeed: 0.05,
      lifetime: 1.1,
      lifetimeJitter: 0.35,
      sizeJitter: 0.4,
      rotationSpeed: 0.7,
    }
    s.forces = { ...s.forces, gravity: 0, buoyancy: 1.8, drag: 1.3, turbulence: 0.9, turbulenceScale: 1.7, turbulenceEvolve: 0.6 }
    s.material = { ...s.material, blend: 'additive', sprite: 'builtin:puff', baseSize: 0.42, intensity: 1.7, erosionAmount: 0.85, erosionScale: 1.4 }
  }),

  make('烟雾 Smoke', (s) => {
    s.emitter = {
      ...s.emitter,
      shape: 'disc',
      rate: 220,
      capacity: 1024,
      radius: 0.24,
      coneAngle: 24,
      speed: 0.45,
      speedJitter: 0.35,
      lifetime: 3.4,
      lifetimeJitter: 0.3,
      sizeJitter: 0.45,
      rotationSpeed: 0.35,
    }
    s.forces = { ...s.forces, gravity: 0, buoyancy: 0.5, drag: 0.85, turbulence: 0.5, turbulenceScale: 0.9, turbulenceEvolve: 0.22 }
    s.curves.size = [
      { t: 0, v: 0.25 },
      { t: 1, v: 1 },
    ]
    s.curves.alpha = [
      { t: 0, v: 0 },
      { t: 0.2, v: 0.55 },
      { t: 0.7, v: 0.35 },
      { t: 1, v: 0 },
    ]
    s.curves.color = [
      { t: 0, color: '#8d9199' },
      { t: 0.4, color: '#5c6068' },
      { t: 1, color: '#2b2e34' },
    ]
    s.material = { ...s.material, blend: 'alpha', sprite: 'builtin:puff', noise: 'builtin:worley', baseSize: 0.95, intensity: 1, erosionAmount: 0.6, erosionSoftness: 0.3, erosionScale: 1.1 }
  }),

  make('火星 Sparks', (s) => {
    s.emitter = {
      ...s.emitter,
      shape: 'point',
      position: [0, 0.8, 0],
      rate: 420,
      capacity: 1024,
      coneAngle: 70,
      speed: 3.4,
      speedJitter: 0.7,
      lifetime: 1.5,
      lifetimeJitter: 0.5,
      sizeJitter: 0.6,
      rotationSpeed: 0,
    }
    s.forces = { ...s.forces, gravity: -6, buoyancy: 0, drag: 0.45, turbulence: 0.25, turbulenceScale: 2.2, turbulenceEvolve: 0.8 }
    s.collision = { ...s.collision, planeEnabled: true, planeHeight: 0, restitution: 0.35, friction: 0.35, killOnCollide: 0.3 }
    s.curves.size = [
      { t: 0, v: 1 },
      { t: 0.7, v: 0.6 },
      { t: 1, v: 0 },
    ]
    s.curves.alpha = [
      { t: 0, v: 1 },
      { t: 0.75, v: 0.9 },
      { t: 1, v: 0 },
    ]
    s.curves.color = [
      { t: 0, color: '#fffbe8' },
      { t: 0.35, color: '#ffc247' },
      { t: 0.8, color: '#ff4d12' },
      { t: 1, color: '#5c1200' },
    ]
    s.material = { ...s.material, blend: 'additive', sprite: 'builtin:spark', baseSize: 0.07, intensity: 3.2, erosionAmount: 0 }
  }),

  make('魔法漩涡 Swirl', (s) => {
    s.emitter = {
      ...s.emitter,
      shape: 'sphere',
      position: [0, 0.9, 0],
      radius: 0.65,
      rate: 900,
      capacity: 4096,
      coneAngle: 180,
      speed: 0.15,
      speedJitter: 0.6,
      lifetime: 2.6,
      lifetimeJitter: 0.3,
      sizeJitter: 0.5,
      rotationSpeed: 1.2,
    }
    s.forces = {
      ...s.forces,
      gravity: 0,
      buoyancy: 0.12,
      drag: 0.55,
      turbulence: 0.35,
      turbulenceScale: 1.2,
      turbulenceEvolve: 0.35,
      vortexStrength: 1.8,
      vortexAxis: [0, 1, 0],
      attractorStrength: 1.1,
      attractorPosition: [0, 0.9, 0],
    }
    s.curves.size = [
      { t: 0, v: 0 },
      { t: 0.25, v: 1 },
      { t: 1, v: 0.1 },
    ]
    s.curves.alpha = [
      { t: 0, v: 0 },
      { t: 0.2, v: 1 },
      { t: 1, v: 0 },
    ]
    s.curves.color = [
      { t: 0, color: '#e6fbff' },
      { t: 0.3, color: '#4fd4ff' },
      { t: 0.7, color: '#7a5cff' },
      { t: 1, color: '#180a3a' },
    ]
    s.material = { ...s.material, blend: 'additive', sprite: 'builtin:disc', baseSize: 0.1, intensity: 1.9, erosionAmount: 0 }
  }),

  make('爆炸 Explosion', (s) => {
    s.emitter = {
      ...s.emitter,
      shape: 'sphere',
      mode: 'burst',
      burstInterval: 2.4,
      position: [0, 1, 0],
      radius: 0.12,
      capacity: 4096,
      coneAngle: 180,
      speed: 3.2,
      speedJitter: 0.65,
      radialSpeed: 1.8,
      lifetime: 1.3,
      lifetimeJitter: 0.4,
      sizeJitter: 0.5,
      rotationSpeed: 1.4,
    }
    s.forces = { ...s.forces, gravity: -1.2, buoyancy: 1.1, drag: 3.4, turbulence: 1.2, turbulenceScale: 1.5, turbulenceEvolve: 0.7 }
    s.curves.size = [
      { t: 0, v: 0.3 },
      { t: 0.35, v: 1 },
      { t: 1, v: 0.8 },
    ]
    s.curves.alpha = [
      { t: 0, v: 0 },
      { t: 0.08, v: 1 },
      { t: 0.45, v: 0.6 },
      { t: 1, v: 0 },
    ]
    s.curves.color = [
      { t: 0, color: '#ffffff' },
      { t: 0.15, color: '#ffd06b' },
      { t: 0.4, color: '#ff6a1a' },
      { t: 0.75, color: '#6b2a12' },
      { t: 1, color: '#1c1c1e' },
    ]
    s.material = { ...s.material, blend: 'additive', sprite: 'builtin:puff', baseSize: 0.32, intensity: 2.2, erosionAmount: 0.9, erosionScale: 1.6 }
  }),
]
