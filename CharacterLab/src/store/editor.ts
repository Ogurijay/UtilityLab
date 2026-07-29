import { create } from 'zustand'
import type {
  AttachmentInfo, BoneMap, ClipInfo, GizmoMode, InspectorTab, MaterialInfo, MeshInfo,
  MorphInfo, PartInfo, PlaybackState, Selection, Toast, ToastKind, TransformInfo,
} from '../types'

/**
 * 编辑器 UI 状态：three.js 对象的"可渲染镜像"。
 * 真正的三维对象由 app/controller 持有，这里只存 React 需要展示的数据。
 */
interface EditorState {
  hasCharacter: boolean
  characterName: string
  skeletonGuess: string
  meshes: MeshInfo[]
  materials: MaterialInfo[]
  morphs: MorphInfo[]
  bones: string[]
  boneMap: BoneMap
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
  hasCharacter: false,
  characterName: '',
  skeletonGuess: '',
  meshes: [],
  materials: [],
  morphs: [],
  bones: [],
  boneMap: {},
  transform: { x: 0, z: 0, rotY: 0, scale: 1 },
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
