export interface SegmentDef {
  bone: string
  /** 目标骨骼名称；省略时使用显式方向与长度。 */
  to?: string
  dir?: [number, number, number]
  len?: number
  w: number
  d: number
  g: 0 | 1
}

/** 基础自动蒙皮使用的身体权重胶囊，不生成模型或动画。 */
export const SEGMENTS: SegmentDef[] = [
  { bone: 'pelvis', to: 'spine_01', w: 0.28, d: 0.18, g: 0 },
  { bone: 'pelvis', dir: [0, -1, 0], len: 0.1, w: 0.27, d: 0.17, g: 0 },
  { bone: 'spine_01', to: 'spine_02', w: 0.25, d: 0.165, g: 0 },
  { bone: 'spine_02', to: 'spine_03', w: 0.255, d: 0.165, g: 0 },
  { bone: 'spine_03', to: 'spine_04', w: 0.27, d: 0.17, g: 0 },
  { bone: 'spine_04', to: 'spine_05', w: 0.285, d: 0.175, g: 0 },
  { bone: 'spine_05', to: 'neck_01', w: 0.3, d: 0.18, g: 0 },
  { bone: 'neck_01', to: 'neck_02', w: 0.095, d: 0.095, g: 0 },
  { bone: 'neck_02', to: 'head', w: 0.09, d: 0.09, g: 0 },
  { bone: 'head', dir: [0, 1, 0], len: 0.235, w: 0.17, d: 0.2, g: 1 },
  { bone: 'clavicle_l', to: 'upperarm_l', w: 0.07, d: 0.07, g: 0 },
  { bone: 'upperarm_l', to: 'lowerarm_l', w: 0.092, d: 0.092, g: 0 },
  { bone: 'lowerarm_l', to: 'hand_l', w: 0.078, d: 0.078, g: 0 },
  { bone: 'hand_l', dir: [1, 0, 0], len: 0.17, w: 0.04, d: 0.09, g: 1 },
  { bone: 'clavicle_r', to: 'upperarm_r', w: 0.07, d: 0.07, g: 0 },
  { bone: 'upperarm_r', to: 'lowerarm_r', w: 0.092, d: 0.092, g: 0 },
  { bone: 'lowerarm_r', to: 'hand_r', w: 0.078, d: 0.078, g: 0 },
  { bone: 'hand_r', dir: [-1, 0, 0], len: 0.17, w: 0.04, d: 0.09, g: 1 },
  { bone: 'thigh_l', to: 'calf_l', w: 0.128, d: 0.128, g: 0 },
  { bone: 'calf_l', to: 'foot_l', w: 0.1, d: 0.1, g: 0 },
  { bone: 'foot_l', to: 'ball_l', w: 0.09, d: 0.08, g: 0 },
  { bone: 'ball_l', dir: [0, 0, 1], len: 0.07, w: 0.088, d: 0.05, g: 1 },
  { bone: 'thigh_r', to: 'calf_r', w: 0.128, d: 0.128, g: 0 },
  { bone: 'calf_r', to: 'foot_r', w: 0.1, d: 0.1, g: 0 },
  { bone: 'foot_r', to: 'ball_r', w: 0.09, d: 0.08, g: 0 },
  { bone: 'ball_r', dir: [0, 0, 1], len: 0.07, w: 0.088, d: 0.05, g: 1 },
]
