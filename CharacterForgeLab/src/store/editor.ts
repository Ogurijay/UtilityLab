import { create } from 'zustand'
import type {
  AttachmentInfo, BoneMap, ClipInfo, GizmoMode, InspectorTab, MaterialInfo, MeshInfo,
  MorphInfo, ObjectNodeInfo, ObjectTool, PartInfo, PlaybackState, SculptBrush, Selection,
  ReferencePoseName, Toast, ToastKind, TransformInfo, WorkspaceMode,
} from '../types'

/**
 * 编辑器 UI 状态：three.js 对象的"可渲染镜像"。
 * 真正的三维对象由 app/controller 持有，这里只存 React 需要展示的数据。
 */
interface EditorState {
  workspaceMode: WorkspaceMode
  workspaceId: string | null
  workspaceDirty: boolean
  workspaceSavedAt: string | null
  rigJob: { id: string; status: string; progress: number } | null
  objectSourceAssetId: string | null
  objectSourceKind: 'model' | 'prop' | null
  objectDirty: boolean
  objectNodes: ObjectNodeInfo[]
  objectSelectedIds: string[]
  objectTool: ObjectTool
  sculptBrush: SculptBrush
  sculptRadius: number
  sculptStrength: number
  objectTransform: TransformInfo
  hasCharacter: boolean
  characterName: string
  skeletonGuess: string
  meshes: MeshInfo[]
  materials: MaterialInfo[]
  morphs: MorphInfo[]
  bones: string[]
  rigFitActive: boolean
  rigFitProfileId: string | null
  rigFitSourcePose: 't' | 'a'
  rigFitBones: string[]
  rigFitAdjustedCount: number
  boneMap: BoneMap
  referencePose: ReferencePoseName
  referencePoseProfileId: string | null
  boneTransform: TransformInfo
  animationEditTracks: number
  transform: TransformInfo
  clips: ClipInfo[]
  playback: PlaybackState
  attachments: AttachmentInfo[]
  /** 拼装台部件 */
  parts: PartInfo[]
  /** 视口选中对象 */
  selection: Selection | null
  gizmoMode: GizmoMode
  /** 等比缩放锁：操纵器缩放任意轴时归一为整体缩放，防止拉伸变形 */
  uniformScale: boolean
  /** 切割平面是否显示 */
  cutPlaneOn: boolean
  undoCount: number
  redoCount: number
  undoLabel: string
  redoLabel: string

  tab: InspectorTab
  showSkeleton: boolean
  showGrid: boolean
  exportOpen: boolean
  wireframe: boolean
  toasts: Toast[]

  set: (patch: Partial<EditorState>) => void
  setPlayback: (patch: Partial<PlaybackState>) => void
  toast: (kind: ToastKind, text: string) => void
  dismissToast: (id: number) => void
}

export const DEFAULT_PLAYBACK: PlaybackState = {
  clipId: null,
  playing: false,
  time: 0,
  duration: 0,
  speed: 1,
  loop: true,
  inPlace: true,
  trimIn: 0,
  trimOut: 0,
}

let toastId = 1

export const useEditor = create<EditorState>()((set, get) => ({
  workspaceMode: 'character',
  workspaceId: null,
  workspaceDirty: false,
  workspaceSavedAt: null,
  rigJob: null,
  objectSourceAssetId: null,
  objectSourceKind: null,
  objectDirty: false,
  objectNodes: [],
  objectSelectedIds: [],
  objectTool: 'select',
  sculptBrush: 'grab',
  sculptRadius: 0.18,
  sculptStrength: 0.45,
  objectTransform: {
    px: 0, py: 0, pz: 0,
    rx: 0, ry: 0, rz: 0,
    sx: 1, sy: 1, sz: 1,
  },
  hasCharacter: false,
  characterName: '',
  skeletonGuess: '',
  meshes: [],
  materials: [],
  morphs: [],
  bones: [],
  rigFitActive: false,
  rigFitProfileId: null,
  rigFitSourcePose: 't',
  rigFitBones: [],
  rigFitAdjustedCount: 0,
  boneMap: {},
  referencePose: 'source',
  referencePoseProfileId: null,
  boneTransform: {
    px: 0, py: 0, pz: 0,
    rx: 0, ry: 0, rz: 0,
    sx: 1, sy: 1, sz: 1,
  },
  animationEditTracks: 0,
  transform: {
    px: 0, py: 0, pz: 0,
    rx: 0, ry: 0, rz: 0,
    sx: 1, sy: 1, sz: 1,
  },
  clips: [],
  playback: { ...DEFAULT_PLAYBACK },
  attachments: [],
  parts: [],
  selection: null,
  gizmoMode: 'translate',
  uniformScale: true,
  cutPlaneOn: false,
  undoCount: 0,
  redoCount: 0,
  undoLabel: '',
  redoLabel: '',

  tab: 'model',
  showSkeleton: false,
  showGrid: true,
  exportOpen: false,
  wireframe: false,
  toasts: [],

  set: (patch) => set(patch),
  setPlayback: (patch) => set({ playback: { ...get().playback, ...patch } }),
  toast: (kind, text) => {
    const id = toastId++
    set({ toasts: [...get().toasts, { id, kind, text }] })
    const ttl = kind === 'err' || kind === 'warn' ? 6500 : 3600
    setTimeout(() => get().dismissToast(id), ttl)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const toast = (kind: ToastKind, text: string): void => useEditor.getState().toast(kind, text)
