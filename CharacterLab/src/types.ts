// 全局共享类型定义

/** 资源种类：模型（带骨骼/网格）、动画（只含动画片段）、道具（静态网格，可挂载） */
export type AssetKind = 'model' | 'anim' | 'prop'

/** 资源库里一条资源的元数据（二进制内容单独存 IndexedDB 的 blob 表） */
export interface AssetMeta {
  id: string
  name: string
  kind: AssetKind
  /** 原始文件格式：glb / gltf / fbx / obj / builtin */
  format: string
  /** 原始文件字节数；内置资源为 0 */
  size: number
  /** 所属自定义文件夹 id；null 表示未归档 */
  folderId: string | null
  /** 缩略图 dataURL（png），动画资源可能没有 */
  thumb?: string
  /** 该资源包含的骨骼名（动画/模型资源都会记录，用于重定向提示） */
  bones?: string[]
  /** 该资源包含的动画片段名 */
  clipNames?: string[]
  /** 是否内置资源（程序生成，不能删除/移动） */
  builtin?: boolean
  createdAt: number
}

export interface Folder {
  id: string
  name: string
  createdAt: number
}

/** 库面板当前的过滤视图 */
export type LibraryView =
  | 'all'
  | 'model'
  | 'anim'
  | 'prop'
  | 'builtin'
  | `folder:${string}`

/** 标准人形骨骼槽位（用于自动映射与重定向） */
export type BoneSlot =
  | 'root'
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'shoulderR'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR'
  | 'upLegL'
  | 'lowerLegL'
  | 'footL'
  | 'toeL'
  | 'upLegR'
  | 'lowerLegR'
  | 'footR'
  | 'toeR'

export type BoneMap = Partial<Record<BoneSlot, string>>

/** 角色身上一条可播放的动画 */
export interface ClipInfo {
  id: string
  name: string
  duration: number
  frames: number
  /** 来源说明：随模型导入 / 重定向自 xxx / 内置 / 裁剪 */
  source: string
}

export interface MeshInfo {
  id: string
  name: string
  visible: boolean
}

export interface MaterialInfo {
  id: string
  name: string
  color: string
  /** null 表示该材质不支持此参数（如 Phong 材质没有 metalness） */
  metalness: number | null
  roughness: number | null
}

export interface MorphInfo {
  /** meshUuid + '::' + morphIndex */
  key: string
  label: string
  value: number
}

export interface AttachmentInfo {
  id: string
  name: string
  bone: string
  /** 位置偏移，单位厘米 */
  px: number
  py: number
  pz: number
  /** 旋转偏移，单位角度 */
  rx: number
  ry: number
  rz: number
  scale: number
}

export interface TransformInfo {
  x: number
  z: number
  rotY: number
  scale: number
}

export interface PlaybackState {
  clipId: string | null
  playing: boolean
  time: number
  duration: number
  speed: number
  loop: boolean
  inPlace: boolean
  /** 裁剪起止（秒）；trimOut<=0 表示未裁剪 */
  trimIn: number
  trimOut: number
}

export type ToastKind = 'info' | 'ok' | 'warn' | 'err'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

export type InspectorTab = 'model' | 'anim' | 'skeleton' | 'mount' | 'parts'

/** 身体部位切割的区域 */
export type BodyRegion = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR'

/** 拼装台里的一个部件 */
export interface PartInfo {
  id: string
  name: string
  /** 位置（米） */
  x: number
  y: number
  z: number
  /** 旋转（度） */
  rx: number
  ry: number
  rz: number
  /** 缩放（各轴） */
  sx: number
  sy: number
  sz: number
  /** X 轴镜像（左臂变右臂等） */
  mirror: boolean
}

/** 视口中的选中对象 */
export type SelectionKind = 'part' | 'character' | 'attachment' | 'plane'

export interface Selection {
  kind: SelectionKind
  /** part / attachment 的 id */
  id?: string
}

export type GizmoMode = 'translate' | 'rotate' | 'scale'

/** 挂载部位预设 */
export interface SocketPreset {
  id: string
  label: string
  slot: BoneSlot
  /** 默认偏移：厘米 / 角度 */
  pos: [number, number, number]
  rot: [number, number, number]
}
