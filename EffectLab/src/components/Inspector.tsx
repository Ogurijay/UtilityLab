import { useEditor } from '../store/editor'
import { IntField, Section, SelectField, Slider, Toggle, Vec3Field } from './controls'
import { CurveEditor } from './CurveEditor'
import { GradientEditor } from './GradientEditor'
import { BUILTIN_NOISES, BUILTIN_SPRITES } from '../core/glsl/gen'
import type { BlendMode, EmissionMode, EmitterShape } from '../types'

export function Inspector() {
  const spec = useEditor((s) => s.spec)
  const update = useEditor((s) => s.update)
  const textures = useEditor((s) => s.textures)
  const capacity = useEditor((s) => s.stats.capacity)

  const spriteOptions = [
    ...BUILTIN_SPRITES.map((s) => ({ value: s.id as string, label: s.label })),
    ...textures.map((t) => ({ value: `lib:${t.id}`, label: `导入 · ${t.name}` })),
  ]
  const noiseOptions = [
    ...BUILTIN_NOISES.map((n) => ({ value: n.id as string, label: n.label })),
    ...textures.map((t) => ({ value: `lib:${t.id}`, label: `导入 · ${t.name}` })),
  ]

  return (
    <div className="inspector">
      <Section title="发射器">
        <SelectField<EmitterShape>
          label="形状"
          value={spec.emitter.shape}
          options={[
            { value: 'point', label: '点' },
            { value: 'sphere', label: '球体' },
            { value: 'box', label: '盒体' },
            { value: 'disc', label: '圆盘' },
            { value: 'cone', label: '锥（顶点发射）' },
          ]}
          onChange={(v) => update((s) => void (s.emitter.shape = v))}
        />
        <SelectField<EmissionMode>
          label="发射模式"
          value={spec.emitter.mode}
          options={[
            { value: 'continuous', label: '连续' },
            { value: 'burst', label: '爆发（循环）' },
          ]}
          onChange={(v) => update((s) => void (s.emitter.mode = v))}
        />
        {spec.emitter.mode === 'continuous' ? (
          <Slider label="发射率 /秒" value={spec.emitter.rate} min={1} max={20000} step={1}
            onChange={(v) => update((s) => void (s.emitter.rate = v))} />
        ) : (
          <Slider label="爆发间隔 秒" value={spec.emitter.burstInterval} min={0.1} max={10} step={0.05}
            onChange={(v) => update((s) => void (s.emitter.burstInterval = v))} />
        )}
        <IntField label="粒子容量" value={spec.emitter.capacity} min={16} max={262144} step={256}
          hint={`向上取整到平方数，当前实际 ${capacity} 个`}
          onChange={(v) => update((s) => void (s.emitter.capacity = v))} />
        <Vec3Field label="位置" value={spec.emitter.position}
          onChange={(v) => update((s) => void (s.emitter.position = v))} />
        <Vec3Field label="主方向" value={spec.emitter.direction}
          onChange={(v) => update((s) => void (s.emitter.direction = v))} />
        {spec.emitter.shape === 'box' ? (
          <Vec3Field label="盒体尺寸" value={spec.emitter.boxSize}
            onChange={(v) => update((s) => void (s.emitter.boxSize = v))} />
        ) : (
          <Slider label="半径" value={spec.emitter.radius} min={0} max={5} step={0.01}
            onChange={(v) => update((s) => void (s.emitter.radius = v))} />
        )}
        <Slider label="发射锥半角 °" value={spec.emitter.coneAngle} min={0} max={180} step={1}
          onChange={(v) => update((s) => void (s.emitter.coneAngle = v))} />
        <Slider label="初速" value={spec.emitter.speed} min={0} max={20} step={0.05}
          onChange={(v) => update((s) => void (s.emitter.speed = v))} />
        <Slider label="初速抖动" value={spec.emitter.speedJitter} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.emitter.speedJitter = v))} />
        <Slider label="径向速度" value={spec.emitter.radialSpeed} min={-10} max={10} step={0.05}
          hint="沿出生点法向的额外速度，做爆炸壳层用"
          onChange={(v) => update((s) => void (s.emitter.radialSpeed = v))} />
        <Slider label="寿命 秒" value={spec.emitter.lifetime} min={0.05} max={12} step={0.01}
          onChange={(v) => update((s) => void (s.emitter.lifetime = v))} />
        <Slider label="寿命抖动" value={spec.emitter.lifetimeJitter} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.emitter.lifetimeJitter = v))} />
        <Slider label="尺寸抖动" value={spec.emitter.sizeJitter} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.emitter.sizeJitter = v))} />
        <Slider label="自转速度" value={spec.emitter.rotationSpeed} min={0} max={6} step={0.05}
          onChange={(v) => update((s) => void (s.emitter.rotationSpeed = v))} />
      </Section>

      <Section title="力场">
        <Slider label="重力" value={spec.forces.gravity} min={-20} max={20} step={0.05}
          onChange={(v) => update((s) => void (s.forces.gravity = v))} />
        <Slider label="浮力" value={spec.forces.buoyancy} min={0} max={10} step={0.05}
          hint="随生命衰减的向上加速度，烟火上升靠它"
          onChange={(v) => update((s) => void (s.forces.buoyancy = v))} />
        <Slider label="阻力" value={spec.forces.drag} min={0} max={8} step={0.05}
          onChange={(v) => update((s) => void (s.forces.drag = v))} />
        <Vec3Field label="恒风" value={spec.forces.wind}
          onChange={(v) => update((s) => void (s.forces.wind = v))} />
        <Slider label="湍流强度" value={spec.forces.turbulence} min={0} max={6} step={0.02}
          hint="无散度 curl 噪声，不会把粒子压成团"
          onChange={(v) => update((s) => void (s.forces.turbulence = v))} />
        <Slider label="湍流尺度" value={spec.forces.turbulenceScale} min={0.05} max={8} step={0.05}
          onChange={(v) => update((s) => void (s.forces.turbulenceScale = v))} />
        <Slider label="湍流演化" value={spec.forces.turbulenceEvolve} min={0} max={3} step={0.02}
          onChange={(v) => update((s) => void (s.forces.turbulenceEvolve = v))} />
        <Slider label="涡流强度" value={spec.forces.vortexStrength} min={-8} max={8} step={0.05}
          onChange={(v) => update((s) => void (s.forces.vortexStrength = v))} />
        <Vec3Field label="涡流轴" value={spec.forces.vortexAxis}
          onChange={(v) => update((s) => void (s.forces.vortexAxis = v))} />
        <Slider label="吸引强度" value={spec.forces.attractorStrength} min={-8} max={8} step={0.05}
          hint="负值为排斥"
          onChange={(v) => update((s) => void (s.forces.attractorStrength = v))} />
        <Vec3Field label="吸引点" value={spec.forces.attractorPosition}
          onChange={(v) => update((s) => void (s.forces.attractorPosition = v))} />
      </Section>

      <Section title="碰撞" defaultOpen={false}>
        <Toggle label="地面平面" value={spec.collision.planeEnabled}
          onChange={(v) => update((s) => void (s.collision.planeEnabled = v))} />
        <Slider label="平面高度" value={spec.collision.planeHeight} min={-5} max={5} step={0.01}
          onChange={(v) => update((s) => void (s.collision.planeHeight = v))} />
        <Toggle label="球体障碍" value={spec.collision.sphereEnabled}
          onChange={(v) => update((s) => void (s.collision.sphereEnabled = v))} />
        <Vec3Field label="球心" value={spec.collision.sphereCenter}
          onChange={(v) => update((s) => void (s.collision.sphereCenter = v))} />
        <Slider label="球半径" value={spec.collision.sphereRadius} min={0.01} max={5} step={0.01}
          onChange={(v) => update((s) => void (s.collision.sphereRadius = v))} />
        <Slider label="弹性" value={spec.collision.restitution} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.collision.restitution = v))} />
        <Slider label="摩擦" value={spec.collision.friction} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.collision.friction = v))} />
        <Slider label="碰撞消亡概率" value={spec.collision.killOnCollide} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.collision.killOnCollide = v))} />
      </Section>

      <Section title="生命曲线">
        <CurveEditor label="尺寸" points={spec.curves.size} color="#4fd4ff"
          onChange={(pts) => update((s) => void (s.curves.size = pts))} />
        <CurveEditor label="透明度" points={spec.curves.alpha} color="#8ef0a0"
          onChange={(pts) => update((s) => void (s.curves.alpha = pts))} />
        <CurveEditor label="溶解阈值" points={spec.curves.erosion} color="#ffb35c"
          onChange={(pts) => update((s) => void (s.curves.erosion = pts))} />
        <GradientEditor stops={spec.curves.color}
          onChange={(stops) => update((s) => void (s.curves.color = stops))} />
      </Section>

      <Section title="材质">
        <SelectField<BlendMode>
          label="混合模式"
          value={spec.material.blend}
          options={[
            { value: 'additive', label: '相加 Additive' },
            { value: 'alpha', label: '透明 AlphaBlend' },
            { value: 'premultiplied', label: '预乘 Premultiplied' },
          ]}
          onChange={(v) => update((s) => void (s.material.blend = v))}
        />
        <SelectField label="精灵贴图" value={spec.material.sprite} options={spriteOptions}
          onChange={(v) => update((s) => void (s.material.sprite = v))} />
        <SelectField label="溶解噪声" value={spec.material.noise} options={noiseOptions}
          onChange={(v) => update((s) => void (s.material.noise = v))} />
        <Slider label="基础尺寸" value={spec.material.baseSize} min={0.005} max={4} step={0.005}
          onChange={(v) => update((s) => void (s.material.baseSize = v))} />
        <Slider label="亮度倍数" value={spec.material.intensity} min={0} max={8} step={0.02}
          hint="M2 烘焙时会归一化并把该值写进 effect.json"
          onChange={(v) => update((s) => void (s.material.intensity = v))} />
        <Slider label="溶解强度" value={spec.material.erosionAmount} min={0} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.material.erosionAmount = v))} />
        <Slider label="溶解过渡" value={spec.material.erosionSoftness} min={0.01} max={1} step={0.01}
          onChange={(v) => update((s) => void (s.material.erosionSoftness = v))} />
        <Slider label="噪声平铺" value={spec.material.erosionScale} min={0.2} max={6} step={0.05}
          onChange={(v) => update((s) => void (s.material.erosionScale = v))} />
      </Section>

      <Section title="模拟" defaultOpen={false}>
        <IntField label="随机种子" value={spec.sim.seed} min={0} max={2147483647}
          hint="同一种子 + 同一步长 = 可复现的模拟，烘焙依赖这一点"
          onChange={(v) => update((s) => void (s.sim.seed = v))} />
        <IntField label="模拟帧率" value={spec.sim.simFps} min={15} max={240} step={5}
          hint="固定步长 = 1 / 该值"
          onChange={(v) => update((s) => void (s.sim.simFps = v))} />
        <IntField label="单帧最大补步" value={spec.sim.maxSubSteps} min={1} max={16}
          onChange={(v) => update((s) => void (s.sim.maxSubSteps = v))} />
      </Section>
    </div>
  )
}
