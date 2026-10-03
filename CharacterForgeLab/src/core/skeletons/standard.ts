import type { BoneMap, BoneSlot, SocketPreset } from '../../types'

/**
 * 内置标准骨架：命名与层级遵循 UE5 / UEFN Manny 约定（pelvis、spine_01…、
 * clavicle_l…），坐标为米、Y 向上、T-pose、面朝 +Z，全部骨骼旋转为单位四元数,
 * 便于程序化蒙皮与动画创作。
 */
export interface StandardBoneDef {
  name: string
  parent: string | null
  pos: [number, number, number]
}

export const STANDARD_BONES: StandardBoneDef[] = [
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'pelvis', parent: 'root', pos: [0, 0.95, 0] },
  { name: 'spine_01', parent: 'pelvis', pos: [0, 0.06, 0.015] },
  { name: 'spine_02', parent: 'spine_01', pos: [0, 0.07, 0.005] },
  { name: 'spine_03', parent: 'spine_02', pos: [0, 0.08, -0.005] },
  { name: 'spine_04', parent: 'spine_03', pos: [0, 0.09, -0.01] },
  { name: 'spine_05', parent: 'spine_04', pos: [0, 0.1, -0.005] },
  { name: 'neck_01', parent: 'spine_05', pos: [0, 0.1, 0.01] },
  { name: 'neck_02', parent: 'neck_01', pos: [0, 0.05, 0.005] },
  { name: 'head', parent: 'neck_02', pos: [0, 0.06, 0.01] },
  { name: 'clavicle_l', parent: 'spine_05', pos: [0.055, 0.06, 0.02] },
  { name: 'upperarm_l', parent: 'clavicle_l', pos: [0.125, 0.02, -0.02] },
  { name: 'lowerarm_l', parent: 'upperarm_l', pos: [0.28, 0, 0] },
  { name: 'hand_l', parent: 'lowerarm_l', pos: [0.26, 0, 0] },
  { name: 'clavicle_r', parent: 'spine_05', pos: [-0.055, 0.06, 0.02] },
  { name: 'upperarm_r', parent: 'clavicle_r', pos: [-0.125, 0.02, -0.02] },
  { name: 'lowerarm_r', parent: 'upperarm_r', pos: [-0.28, 0, 0] },
  { name: 'hand_r', parent: 'lowerarm_r', pos: [-0.26, 0, 0] },
  { name: 'thigh_l', parent: 'pelvis', pos: [0.095, -0.03, 0] },
  { name: 'calf_l', parent: 'thigh_l', pos: [0, -0.44, 0] },
  { name: 'foot_l', parent: 'calf_l', pos: [0, -0.43, 0] },
  { name: 'ball_l', parent: 'foot_l', pos: [0, -0.045, 0.13] },
  { name: 'thigh_r', parent: 'pelvis', pos: [-0.095, -0.03, 0] },
  { name: 'calf_r', parent: 'thigh_r', pos: [0, -0.44, 0] },
  { name: 'foot_r', parent: 'calf_r', pos: [0, -0.43, 0] },
  { name: 'ball_r', parent: 'foot_r', pos: [-0, -0.045, 0.13] },
]

/** 槽位 → UEFN/Manny 标准骨骼名（用于骨骼重命名替换与标准骨架自身的映射） */
export const UE_SLOT_NAMES: Record<BoneSlot, string> = {
  root: 'root',
  hips: 'pelvis',
  spine: 'spine_01',
  chest: 'spine_03',
  upperChest: 'spine_05',
  neck: 'neck_01',
  head: 'head',
  shoulderL: 'clavicle_l',
  upperArmL: 'upperarm_l',
  lowerArmL: 'lowerarm_l',
  handL: 'hand_l',
  shoulderR: 'clavicle_r',
  upperArmR: 'upperarm_r',
  lowerArmR: 'lowerarm_r',
  handR: 'hand_r',
  upLegL: 'thigh_l',
  lowerLegL: 'calf_l',
  footL: 'foot_l',
  toeL: 'ball_l',
  upLegR: 'thigh_r',
  lowerLegR: 'calf_r',
  footR: 'foot_r',
  toeR: 'ball_r',
}

/** 标准骨架的槽位映射（骨骼名完全等于标准名） */
export const STANDARD_BONE_MAP: BoneMap = { ...UE_SLOT_NAMES }

export const SLOT_LABELS: Record<BoneSlot, string> = {
  root: '根骨骼',
  hips: '骨盆（髋）',
  spine: '脊柱·下',
  chest: '脊柱·中（胸）',
  upperChest: '脊柱·上',
  neck: '颈部',
  head: '头部',
  shoulderL: '左锁骨（肩）',
  upperArmL: '左上臂',
  lowerArmL: '左前臂',
  handL: '左手',
  shoulderR: '右锁骨（肩）',
  upperArmR: '右上臂',
  lowerArmR: '右前臂',
  handR: '右手',
  upLegL: '左大腿',
  lowerLegL: '左小腿',
  footL: '左脚',
  toeL: '左脚趾',
  upLegR: '右大腿',
  lowerLegR: '右小腿',
  footR: '右脚',
  toeR: '右脚趾',
}

/** 映射表 UI 的分组展示顺序 */
export const SLOT_GROUPS: { label: string; slots: BoneSlot[] }[] = [
  { label: '躯干', slots: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'] },
  { label: '左臂', slots: ['shoulderL', 'upperArmL', 'lowerArmL', 'handL'] },
  { label: '右臂', slots: ['shoulderR', 'upperArmR', 'lowerArmR', 'handR'] },
  { label: '左腿', slots: ['upLegL', 'lowerLegL', 'footL', 'toeL'] },
  { label: '右腿', slots: ['upLegR', 'lowerLegR', 'footR', 'toeR'] },
]

/** 重定向 / 播放动画时必须映射到的关键槽位 */
export const REQUIRED_SLOTS: BoneSlot[] = [
  'hips',
  'upperArmL',
  'upperArmR',
  'upLegL',
  'upLegR',
]

/** 挂载部位预设（偏移针对内置假人调校，其他模型可用滑杆微调） */
export const SOCKET_PRESETS: SocketPreset[] = [
  { id: 'handR', label: '右手', slot: 'handR', pos: [-8, 0, 0], rot: [0, 0, 90] },
  { id: 'handL', label: '左手', slot: 'handL', pos: [8, 0, 0], rot: [0, 0, -90] },
  { id: 'back', label: '背部', slot: 'upperChest', pos: [0, 5, -14], rot: [0, 0, 145] },
  { id: 'hip', label: '腰侧', slot: 'hips', pos: [-14, -4, 6], rot: [15, 0, 170] },
  { id: 'head', label: '头顶', slot: 'head', pos: [0, 24, 0], rot: [0, 0, 0] },
]
