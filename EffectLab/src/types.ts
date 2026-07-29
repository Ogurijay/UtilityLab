export type Vec3 = [number, number, number]

/** 生命曲线控制点：t 为归一化生命 [0,1]，v 为取值 [0,1]。 */
export interface CurvePoint {
  t: number
  v: number
}

/** 颜色渐变停靠点：color 为 `#rrggbb`。 */
export interface GradientStop {
  t: number
  color: string
}

export type EmitterShape = 'point' | 'sphere' | 'box' | 'disc' | 'cone'
export type EmissionMode = 'continuous' | 'burst'
export type BlendMode = 'additive' | 'alpha' | 'premultiplied'

export interface EmitterSpec {
  shape: EmitterShape
  mode: EmissionMode
  /** 每秒发射粒子数（continuous） */
  rate: number
  /** 爆发间隔秒数（burst） */
  burstInterval: number
  /** 粒子容量，会被向上取整到平方数 */
  capacity: number
  position: Vec3
  /** 发射主方向，会在着色器里归一化 */
  direction: Vec3
  radius: number
  boxSize: Vec3
  /** 发射锥半角（度），180 表示全向 */
  coneAngle: number
  speed: number
  speedJitter: number
  /** 沿出生点法向的额外速度 */
  radialSpeed: number
  lifetime: number
  lifetimeJitter: number
  sizeJitter: number
  /** 自转角速度上限（弧度/秒），每粒子在 ±该值间取随机 */
  rotationSpeed: number
}

export interface ForcesSpec {
  gravity: number
  /** 浮力，随生命衰减，用于烟火上升 */
  buoyancy: number
  /** 阻力系数，按 exp(-drag*dt) 衰减速度 */
  drag: number
  wind: Vec3
  turbulence: number
  turbulenceScale: number
  turbulenceEvolve: number
  vortexStrength: number
  vortexAxis: Vec3
  attractorStrength: number
  attractorPosition: Vec3
}

export interface CollisionSpec {
  planeEnabled: boolean
  planeHeight: number
  sphereEnabled: boolean
  sphereCenter: Vec3
  sphereRadius: number
  restitution: number
  friction: number
  /** 碰撞后消亡概率 [0,1] */
  killOnCollide: number
}

export interface CurvesSpec {
  size: CurvePoint[]
  alpha: CurvePoint[]
  /** 溶解阈值随生命的变化 */
  erosion: CurvePoint[]
  color: GradientStop[]
}

export interface MaterialSpec {
  blend: BlendMode
  /** `builtin:<name>` 或 `lib:<id>` */
  sprite: string
  noise: string
  baseSize: number
  /** 颜色乘数，为 M2 的 HDR 归一化预留 */
  intensity: number
  erosionAmount: number
  erosionSoftness: number
  erosionScale: number
}

export interface SimSpec {
  seed: number
  /** 模拟频率，固定步长 = 1/simFps */
  simFps: number
  /** 单帧最多补几步，防止卡顿后爆炸 */
  maxSubSteps: number
}

export interface EffectSpec {
  version: 1
  name: string
  emitter: EmitterSpec
  forces: ForcesSpec
  collision: CollisionSpec
  curves: CurvesSpec
  material: MaterialSpec
  sim: SimSpec
}

/** 贴图库条目（真实像素数据存 IndexedDB，不入 Git） */
export interface TextureEntry {
  id: string
  name: string
  width: number
  height: number
  createdAt: number
}
