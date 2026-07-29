import * as THREE from 'three'
import { STANDARD_BONES } from '../skeletons/standard'

/**
 * 程序化示例动画：直接在标准骨架的本地空间按参数曲线采样烘焙。
 * 所有曲线周期都与时长对齐，保证首尾帧一致、可无缝循环。
 */

type ChannelSample = { rot?: [number, number, number]; pos?: [number, number, number] }
type ChannelFn = (t: number) => ChannelSample

const REST_POS: Record<string, [number, number, number]> = {}
for (const b of STANDARD_BONES) REST_POS[b.name] = b.pos

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function bakePoseClip(name: string, duration: number, channels: Record<string, ChannelFn>, fps = 30): THREE.AnimationClip {
  const frames = Math.round(duration * fps) + 1
  const dt = duration / (frames - 1)
  const times = new Float32Array(frames)
  for (let f = 0; f < frames; f++) times[f] = f * dt

  const tracks: THREE.KeyframeTrack[] = []
  const euler = new THREE.Euler()
  const quat = new THREE.Quaternion()

  for (const [bone, fn] of Object.entries(channels)) {
    const probe = fn(0)
    if (probe.rot) {
      const values = new Float32Array(frames * 4)
      let px = 0, py = 0, pz = 0, pw = 1
      for (let f = 0; f < frames; f++) {
        const r = fn(times[f]).rot!
        euler.set(r[0], r[1], r[2], 'XYZ')
        quat.setFromEuler(euler)
        if (px * quat.x + py * quat.y + pz * quat.z + pw * quat.w < 0) {
          quat.set(-quat.x, -quat.y, -quat.z, -quat.w)
        }
        px = quat.x; py = quat.y; pz = quat.z; pw = quat.w
        values[f * 4] = quat.x
        values[f * 4 + 1] = quat.y
        values[f * 4 + 2] = quat.z
        values[f * 4 + 3] = quat.w
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times as unknown as number[], values as unknown as number[]))
    }
    if (probe.pos) {
      const values = new Float32Array(frames * 3)
      for (let f = 0; f < frames; f++) {
        const p = fn(times[f]).pos!
        values[f * 3] = p[0]
        values[f * 3 + 1] = p[1]
        values[f * 3 + 2] = p[2]
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${bone}.position`, times as unknown as number[], values as unknown as number[]))
    }
  }
  return new THREE.AnimationClip(name, duration, tracks)
}

/** 手臂自然下垂的基础姿势参数 */
const ARM_DOWN = 1.12
const ELBOW = 0.16

export function buildIdleClip(): THREE.AnimationClip {
  const D = 4
  const w = (t: number) => Math.sin((2 * Math.PI * t) / D)
  const rest = REST_POS['pelvis']
  return bakePoseClip('待机呼吸', D, {
    pelvis: (t) => ({ pos: [rest[0], rest[1] + 0.009 * w(t), rest[2]], rot: [0.02, 0, 0] }),
    spine_03: (t) => ({ rot: [0.045 * w(t), 0, 0] }),
    spine_05: (t) => ({ rot: [0.032 * w(t + 0.25), 0, 0] }),
    neck_01: (t) => ({ rot: [-0.035 * w(t), 0, 0] }),
    head: (t) => ({ rot: [-0.02 * w(t + 0.5), 0.03 * w(t * 0.5 + 1), 0] }),
    upperarm_l: (t) => ({ rot: [0.03 * w(t + 1), 0.04, -(ARM_DOWN + 0.025 * w(t))] }),
    upperarm_r: (t) => ({ rot: [0.03 * w(t + 1), -0.04, ARM_DOWN + 0.025 * w(t)] }),
    lowerarm_l: () => ({ rot: [0, -0.22, -ELBOW] }),
    lowerarm_r: () => ({ rot: [0, 0.22, ELBOW] }),
    hand_l: () => ({ rot: [0, 0, -0.08] }),
    hand_r: () => ({ rot: [0, 0, 0.08] }),
  })
}

export function buildWalkClip(): THREE.AnimationClip {
  const D = 1.2
  const W = (2 * Math.PI) / D
  const rest = REST_POS['pelvis']
  const kneeFlex = (phi: number) => 0.1 + 0.66 * Math.max(0, Math.sin(phi - 2.0))
  return bakePoseClip('原地行走', D, {
    pelvis: (t) => ({
      pos: [rest[0], rest[1] - 0.016 + 0.02 * Math.sin(2 * W * t - 0.6), rest[2]],
      rot: [0.05, 0.07 * Math.sin(W * t), 0.02 * Math.sin(W * t)],
    }),
    spine_01: (t) => ({ rot: [0.02, -0.04 * Math.sin(W * t), 0] }),
    spine_03: (t) => ({ rot: [0.02, -0.07 * Math.sin(W * t), 0] }),
    spine_05: (t) => ({ rot: [0.01, -0.05 * Math.sin(W * t), 0] }),
    neck_01: (t) => ({ rot: [-0.04, 0.05 * Math.sin(W * t), 0] }),
    thigh_l: (t) => ({ rot: [-0.6 * Math.sin(W * t), 0, 0.015] }),
    thigh_r: (t) => ({ rot: [0.6 * Math.sin(W * t), 0, -0.015] }),
    calf_l: (t) => ({ rot: [kneeFlex(W * t), 0, 0] }),
    calf_r: (t) => ({ rot: [kneeFlex(W * t + Math.PI), 0, 0] }),
    foot_l: (t) => ({ rot: [-0.22 * Math.sin(W * t - 0.5) - 0.06, 0, 0] }),
    foot_r: (t) => ({ rot: [0.22 * Math.sin(W * t + 0.5) - 0.06, 0, 0] }),
    upperarm_l: (t) => ({ rot: [0.4 * Math.sin(W * t), 0.05, -ARM_DOWN + 0.05] }),
    upperarm_r: (t) => ({ rot: [-0.4 * Math.sin(W * t), -0.05, ARM_DOWN - 0.05] }),
    lowerarm_l: (t) => ({ rot: [0.12 * Math.max(0, Math.sin(W * t)), -0.3, -ELBOW] }),
    lowerarm_r: (t) => ({ rot: [0.12 * Math.max(0, -Math.sin(W * t)), 0.3, ELBOW] }),
  })
}

export function buildWaveClip(): THREE.AnimationClip {
  const D = 2.4
  const env = (t: number) => smoothstep(0, 0.4, t) * (1 - smoothstep(D - 0.45, D - 0.05, t))
  const osc = (t: number) => Math.sin(2 * Math.PI * 2.5 * t)
  const mix = (a: number, b: number, k: number) => a + (b - a) * k
  const rest = REST_POS['pelvis']
  return bakePoseClip('打招呼·挥手', D, {
    pelvis: (t) => ({ pos: [rest[0], rest[1] + 0.004 * Math.sin((2 * Math.PI * t) / D), rest[2]] }),
    spine_03: (t) => ({ rot: [0.02, 0, -0.03 * env(t)] }),
    head: (t) => ({ rot: [0, 0.06 * env(t), 0.09 * env(t)] }),
    clavicle_r: (t) => ({ rot: [0, 0, 0.18 * env(t)] }),
    upperarm_r: (t) => {
      const e = env(t)
      return { rot: [mix(0.03, -0.35, e), mix(-0.04, 0.45, e), mix(ARM_DOWN, -0.5, e)] }
    },
    lowerarm_r: (t) => {
      const e = env(t)
      return { rot: [0, mix(0.22, 0.1, e), mix(ELBOW, -0.95, e) + 0.3 * osc(t) * e] }
    },
    hand_r: (t) => ({ rot: [0, 0, 0.16 * osc(t) * env(t)] }),
    upperarm_l: () => ({ rot: [0.03, 0.04, -ARM_DOWN] }),
    lowerarm_l: () => ({ rot: [0, -0.22, -ELBOW] }),
  })
}
