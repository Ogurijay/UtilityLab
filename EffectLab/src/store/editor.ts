import { create } from 'zustand'
import type { EffectSpec, TextureEntry } from '../types'
import { BUILTIN_PRESETS, cloneSpec } from '../presets'

export interface Stats {
  simTime: number
  frame: number
  capacity: number
  fps: number
}

interface EditorState {
  spec: EffectSpec
  playing: boolean
  showHelpers: boolean
  stats: Stats
  textures: TextureEntry[]
  toast: string | null

  update: (fn: (draft: EffectSpec) => void) => void
  loadSpec: (spec: EffectSpec) => void
  setPlaying: (v: boolean) => void
  toggleHelpers: () => void
  setStats: (s: Stats) => void
  setTextures: (list: TextureEntry[]) => void
  notify: (msg: string | null) => void
}

export const useEditor = create<EditorState>((set, get) => ({
  spec: cloneSpec(BUILTIN_PRESETS[0]),
  playing: true,
  showHelpers: true,
  stats: { simTime: 0, frame: 0, capacity: 0, fps: 0 },
  textures: [],
  toast: null,

  update: (fn) => {
    const next = cloneSpec(get().spec)
    fn(next)
    set({ spec: next })
  },
  loadSpec: (spec) => set({ spec: cloneSpec(spec) }),
  setPlaying: (v) => set({ playing: v }),
  toggleHelpers: () => set({ showHelpers: !get().showHelpers }),
  setStats: (stats) => set({ stats }),
  setTextures: (textures) => set({ textures }),
  notify: (toast) => set({ toast }),
}))
