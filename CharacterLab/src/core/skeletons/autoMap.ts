import * as THREE from 'three'
import type { BoneMap, BoneSlot } from '../../types'
import { REQUIRED_SLOTS } from './standard'

/**
 * 骨骼名自动识别：把任意命名习惯（Mixamo、UE/Manny、VRM、3ds Max Biped、
 * Blender Rigify、Character Creator…）的骨骼映射到标准槽位。
 *
 * 思路：骨骼名 → 拆分为 token（按分隔符与驼峰）→ 剔除前缀/噪声 token 与
 * 左右标记 → 剩余部分拼成"核心名"，与同义词字典做精确匹配。
 * 脊柱、颈部等链式骨骼按层级深度排序后再分配槽位。
 */

type Category =
  | 'root'
  | 'hips'
  | 'spineChain'
  | 'neckChain'
  | 'head'
  | 'shoulder'
  | 'upperArm'
  | 'lowerArm'
  | 'hand'
  | 'upLeg'
  | 'lowerLeg'
  | 'foot'
  | 'toe'

const CORE_DICT: Record<string, Category> = {
  root: 'root',
  reference: 'root',
  trajectory: 'root',
  hips: 'hips',
  hip: 'hips',
  pelvis: 'hips',
  waist: 'hips',
  cog: 'hips',
  spine: 'spineChain',
  chest: 'spineChain',
  upperchest: 'spineChain',
  abdomen: 'spineChain',
  torso: 'spineChain',
  abdomenupper: 'spineChain',
  neck: 'neckChain',
  head: 'head',
  shoulder: 'shoulder',
  clavicle: 'shoulder',
  collar: 'shoulder',
  collarbone: 'shoulder',
  arm: 'upperArm',
  upperarm: 'upperArm',
  uparm: 'upperArm',
  armupper: 'upperArm',
  bicep: 'upperArm',
  shldrbend: 'upperArm',
  forearm: 'lowerArm',
  lowerarm: 'lowerArm',
  armlower: 'lowerArm',
  elbow: 'lowerArm',
  forearmbend: 'lowerArm',
  hand: 'hand',
  wrist: 'hand',
  palm: 'hand',
  upleg: 'upLeg',
  thigh: 'upLeg',
  upperleg: 'upLeg',
  legupper: 'upLeg',
  thighbend: 'upLeg',
  leg: 'lowerLeg',
  lowerleg: 'lowerLeg',
  leglower: 'lowerLeg',
  calf: 'lowerLeg',
  shin: 'lowerLeg',
  knee: 'lowerLeg',
  foot: 'foot',
  ankle: 'foot',
  toe: 'toe',
  toes: 'toe',
  toebase: 'toe',
  ball: 'toe',
}

/** 出现这些 token 的骨骼不参与自动映射（辅助骨、手指、面部等） */
const EXCLUDE_TOKENS = new Set([
  'twist', 'roll', 'ik', 'fk', 'pole', 'target', 'ctrl', 'control', 'helper',
  'driver', 'offset', 'adj', 'corrective', 'prop', 'weapon', 'attach', 'socket',
  'end', 'nub', 'tip', 'eye', 'jaw', 'tongue', 'teeth', 'hair', 'cloth', 'skirt',
  'breast', 'dyn', 'phys', 'ponytail', 'ear', 'eyebrow', 'thumb', 'index',
  'middle', 'ring', 'pinky', 'finger', 'metacarpal', 'heel', 'gun', 'item',
  'interaction', 'center_of_mass', 'camera',
])

/** 纯噪声 token：常见前缀、序号壳等，匹配核心名时直接丢弃 */
const IGNORE_TOKENS = new Set([
  'mixamorig', 'armature', 'bip', 'bn', 'b', 'def', 'rig', 'jnt', 'joint',
  'bone', 'char', 'character', 'skeleton', 'avatar', 'j', 'sk', 'cc', 'base',
  'valvebiped', 'genesis', 'bip01', 'bip001', 'c', 'm', 'mid', 'center', 'ct',
])

const SIDE_L = new Set(['l', 'left', 'lft'])
const SIDE_R = new Set(['r', 'right', 'rgt'])

interface ParsedBone {
  name: string
  depth: number
  side: 'L' | 'R' | ''
  category: Category | null
  /** 名字里出现的序号（spine_02 → 2），链式骨骼排序的次级依据 */
  index: number
}

function tokenize(raw: string): string[] {
  // 去掉命名空间前缀（mixamorig:Hips、Armature|Hips）
  let s = raw.replace(/^.*[:|]/, '')
  // 驼峰拆分
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return s
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .filter(Boolean)
}

function parseBoneName(raw: string, depth: number): ParsedBone {
  const tokens: string[] = []
  for (const t of tokenize(raw)) {
    // "lefthand" 这类无分隔写法：拆出方位词
    if (t.length > 4 && (t.startsWith('left') || t.startsWith('right'))) {
      const side = t.startsWith('left') ? 'left' : 'right'
      tokens.push(side, t.slice(side.length))
    } else {
      tokens.push(t)
    }
  }

  let side: 'L' | 'R' | '' = ''
  let index = 0
  const cores: string[] = []
  for (const t of tokens) {
    const digits = t.match(/^(.*?)(\d+)$/)
    const base = digits ? digits[1] : t
    if (digits && digits[2]) index = parseInt(digits[2], 10) || index
    if (base === '') continue
    if (EXCLUDE_TOKENS.has(base)) return { name: raw, depth, side: '', category: null, index }
    if (SIDE_L.has(base)) { side = 'L'; continue }
    if (SIDE_R.has(base)) { side = 'R'; continue }
    if (IGNORE_TOKENS.has(base)) continue
    cores.push(base)
  }

  const core = cores.join('')
  const category = CORE_DICT[core] ?? null
  return { name: raw, depth, side, category, index }
}

function boneDepth(bone: THREE.Object3D): number {
  let d = 0
  let p = bone.parent
  while (p) {
    d++
    p = p.parent
  }
  return d
}

/**
 * 对一组骨骼做自动映射。
 * @param bones 角色的全部骨骼（THREE.Bone）
 */
export function autoMapBones(bones: THREE.Object3D[]): BoneMap {
  const parsed = bones.map((b) => parseBoneName(b.name, boneDepth(b)))

  const map: BoneMap = {}
  const put = (slot: BoneSlot, p: ParsedBone | undefined) => {
    if (p && !map[slot]) map[slot] = p.name
  }
  const byDepth = (a: ParsedBone, b: ParsedBone) => a.depth - b.depth || a.index - b.index

  // 链式骨骼：脊柱与颈部
  const spines = parsed.filter((p) => p.category === 'spineChain' && p.side === '').sort(byDepth)
  if (spines.length === 1) {
    put('spine', spines[0])
  } else if (spines.length === 2) {
    put('spine', spines[0])
    put('chest', spines[1])
  } else if (spines.length >= 3) {
    put('spine', spines[0])
    put('chest', spines[Math.floor(spines.length / 2)])
    put('upperChest', spines[spines.length - 1])
  }
  const necks = parsed.filter((p) => p.category === 'neckChain' && p.side === '').sort(byDepth)
  put('neck', necks[0])

  // 单一槽位
  const pick = (cat: Category, side: 'L' | 'R' | '') =>
    parsed.filter((p) => p.category === cat && p.side === side).sort(byDepth)[0]

  put('root', pick('root', ''))
  put('hips', pick('hips', ''))
  put('head', pick('head', ''))
  const sided: [Category, BoneSlot, BoneSlot][] = [
    ['shoulder', 'shoulderL', 'shoulderR'],
    ['upperArm', 'upperArmL', 'upperArmR'],
    ['lowerArm', 'lowerArmL', 'lowerArmR'],
    ['hand', 'handL', 'handR'],
    ['upLeg', 'upLegL', 'upLegR'],
    ['lowerLeg', 'lowerLegL', 'lowerLegR'],
    ['foot', 'footL', 'footR'],
    ['toe', 'toeL', 'toeR'],
  ]
  for (const [cat, slotL, slotR] of sided) {
    put(slotL, pick(cat, 'L'))
    put(slotR, pick(cat, 'R'))
  }
  return map
}

/** 猜测骨架命名体系，用于 UI 提示 */
export function guessSkeletonType(boneNames: string[]): string {
  const set = new Set(boneNames.map((n) => n.toLowerCase()))
  const hasAny = (...keys: string[]) => keys.some((k) => set.has(k))
  if (boneNames.some((n) => /^mixamorig/i.test(n))) return 'Mixamo 骨架'
  if (hasAny('pelvis') && hasAny('spine_01') && hasAny('clavicle_l')) return 'UE / Manny 骨架'
  if (boneNames.some((n) => /^j_bip_/i.test(n))) return 'VRM 骨架'
  if (boneNames.some((n) => /^bip0?0?1/i.test(n))) return '3ds Max Biped 骨架'
  if (hasAny('hips') && (hasAny('leftupleg') || hasAny('left_up_leg', 'leftupperleg'))) return '通用人形骨架'
  return '未识别命名（可手动映射）'
}

/** 检查关键槽位是否齐全，返回缺失槽位列表 */
export function missingRequiredSlots(map: BoneMap): BoneSlot[] {
  return REQUIRED_SLOTS.filter((s) => !map[s])
}

/** 由两侧的槽位映射合成 目标骨骼名 → 源骨骼名 的重定向映射（root 除外） */
export function buildRetargetNameMap(target: BoneMap, source: BoneMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const slot of Object.keys(target) as BoneSlot[]) {
    if (slot === 'root') continue
    const t = target[slot]
    const s = source[slot]
    if (t && s) out.set(t, s)
  }
  return out
}
