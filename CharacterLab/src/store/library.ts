import { create } from 'zustand'
import type { AssetKind, AssetMeta, Folder, LibraryView } from '../types'
import * as db from '../db/assetDb'
import { BUILTIN_ASSETS, isBuiltinId } from '../core/builtins'
import { classifyAsset, disposeObject, downloadBlob, fileExtension, parseAssetFile, SUPPORTED_EXTENSIONS } from '../core/loaders'
import { renderThumbnail } from '../core/thumbs'
import { uid } from '../core/character'
import { toast } from './editor'

interface LibraryState {
  ready: boolean
  assets: AssetMeta[]
  folders: Folder[]
  view: LibraryView
  search: string
  importing: boolean

  init: () => Promise<void>
  setView: (v: LibraryView) => void
  setSearch: (s: string) => void
  importFiles: (files: FileList | File[]) => Promise<void>
  renameAsset: (id: string, name: string) => Promise<void>
  moveAsset: (id: string, folderId: string | null) => Promise<void>
  setAssetKind: (id: string, kind: AssetKind) => Promise<void>
  removeAsset: (id: string, quiet?: boolean) => Promise<void>
  /** 恢复一条被删除的资源（撤销栈使用，保留原 id） */
  restoreAsset: (meta: AssetMeta, blob: Blob) => Promise<void>
  downloadAsset: (id: string) => Promise<void>
  /** 应用内部生成的资源（切割部件 / 拼装结果 / 保存的角色）入库 */
  addGeneratedAsset: (
    blob: Blob,
    name: string,
    kind: AssetKind,
    opts?: { thumb?: string; bones?: string[]; clipNames?: string[] },
  ) => Promise<string>
  createFolder: (name: string) => Promise<void>
  renameFolder: (id: string, name: string) => Promise<void>
  removeFolder: (id: string) => Promise<void>
  visibleAssets: () => AssetMeta[]
}

export const useLibrary = create<LibraryState>()((set, get) => ({
  ready: false,
  assets: [],
  folders: [],
  view: 'all',
  search: '',
  importing: false,

  init: async () => {
    try {
      const [metas, folders] = await Promise.all([db.listAssetMeta(), db.listFolders()])
      metas.sort((a, b) => b.createdAt - a.createdAt)
      folders.sort((a, b) => a.createdAt - b.createdAt)
      set({ assets: metas, folders, ready: true })
    } catch (e) {
      console.error(e)
      toast('err', '资源库初始化失败（浏览器可能禁用了 IndexedDB）')
      set({ ready: true })
    }
  },

  setView: (view) => set({ view }),
  setSearch: (search) => set({ search }),

  importFiles: async (files) => {
    const list = Array.from(files).filter((f) => SUPPORTED_EXTENSIONS.includes(fileExtension(f.name)))
    const skipped = Array.from(files).length - list.length
    if (skipped > 0) toast('warn', `已跳过 ${skipped} 个不支持的文件（支持 GLB / GLTF / FBX / OBJ）`)
    if (list.length === 0) return

    set({ importing: true })
    let ok = 0
    for (const file of list) {
      try {
        const buffer = await file.arrayBuffer()
        const parsed = await parseAssetFile(buffer, file.name)
        const kind = classifyAsset(parsed)
        const thumb = kind === 'anim' ? undefined : renderThumbnail(parsed.object)
        disposeObject(parsed.object)

        const meta: AssetMeta = {
          id: uid('asset'),
          name: file.name.replace(/\.[^.]+$/, ''),
          kind,
          format: fileExtension(file.name),
          size: file.size,
          folderId: null,
          thumb,
          bones: parsed.boneNames.length > 0 ? parsed.boneNames.slice(0, 400) : undefined,
          clipNames: parsed.clips.map((c) => c.name),
          createdAt: Date.now(),
        }
        await db.putAsset(meta, file)
        set({ assets: [meta, ...get().assets] })
        ok++
      } catch (e) {
        console.error(e)
        toast('err', `导入「${file.name}」失败：${e instanceof Error ? e.message : '无法解析'}`)
      }
    }
    set({ importing: false })
    if (ok > 0) toast('ok', `已导入 ${ok} 个资源`)
  },

  renameAsset: async (id, name) => {
    const meta = get().assets.find((a) => a.id === id)
    if (!meta || meta.builtin || !name.trim()) return
    const next = { ...meta, name: name.trim() }
    await db.putMeta(next)
    set({ assets: get().assets.map((a) => (a.id === id ? next : a)) })
  },

  moveAsset: async (id, folderId) => {
    const meta = get().assets.find((a) => a.id === id)
    if (!meta || meta.builtin) return
    const next = { ...meta, folderId }
    await db.putMeta(next)
    set({ assets: get().assets.map((a) => (a.id === id ? next : a)) })
  },

  setAssetKind: async (id, kind) => {
    const meta = get().assets.find((a) => a.id === id)
    if (!meta || meta.builtin) return
    const next = { ...meta, kind }
    await db.putMeta(next)
    set({ assets: get().assets.map((a) => (a.id === id ? next : a)) })
  },

  removeAsset: async (id, quiet = false) => {
    if (isBuiltinId(id)) return
    await db.deleteAsset(id)
    set({ assets: get().assets.filter((a) => a.id !== id) })
    if (!quiet) toast('info', '已删除资源')
  },

  restoreAsset: async (meta, blob) => {
    await db.putAsset(meta, blob)
    if (!get().assets.some((a) => a.id === meta.id)) {
      set({ assets: [meta, ...get().assets] })
    }
  },

  downloadAsset: async (id) => {
    const meta = get().assets.find((a) => a.id === id)
    if (!meta) return
    if (meta.builtin) {
      toast('info', '内置资源没有源文件；绑定到角色后可随角色一起导出')
      return
    }
    const blob = await db.getAssetBlob(id)
    if (!blob) {
      toast('err', '找不到该资源的文件内容')
      return
    }
    downloadBlob(blob, `${meta.name}.${meta.format}`)
  },

  addGeneratedAsset: async (blob, name, kind, opts) => {
    const meta: AssetMeta = {
      id: uid('asset'),
      name,
      kind,
      format: 'glb',
      size: blob.size,
      folderId: null,
      thumb: opts?.thumb,
      bones: opts?.bones,
      clipNames: opts?.clipNames ?? [],
      createdAt: Date.now(),
    }
    await db.putAsset(meta, blob)
    set({ assets: [meta, ...get().assets] })
    return meta.id
  },

  createFolder: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const folder: Folder = { id: uid('folder'), name: trimmed, createdAt: Date.now() }
    await db.putFolder(folder)
    set({ folders: [...get().folders, folder] })
  },

  renameFolder: async (id, name) => {
    const folder = get().folders.find((f) => f.id === id)
    if (!folder || !name.trim()) return
    const next = { ...folder, name: name.trim() }
    await db.putFolder(next)
    set({ folders: get().folders.map((f) => (f.id === id ? next : f)) })
  },

  removeFolder: async (id) => {
    await db.deleteFolder(id)
    const affected = get().assets.filter((a) => a.folderId === id)
    for (const meta of affected) {
      await db.putMeta({ ...meta, folderId: null })
    }
    set({
      folders: get().folders.filter((f) => f.id !== id),
      assets: get().assets.map((a) => (a.folderId === id ? { ...a, folderId: null } : a)),
      view: get().view === `folder:${id}` ? 'all' : get().view,
    })
  },

  visibleAssets: () => {
    const { assets, view, search } = get()
    let filtered: AssetMeta[]
    if (view === 'builtin') {
      filtered = [...BUILTIN_ASSETS]
    } else if (view.startsWith('folder:')) {
      filtered = assets.filter((a) => a.folderId === view.slice(7))
    } else if (view === 'model' || view === 'anim' || view === 'prop') {
      filtered = [...assets, ...BUILTIN_ASSETS].filter((a) => a.kind === view)
    } else {
      filtered = [...assets, ...BUILTIN_ASSETS]
    }
    const q = search.trim().toLowerCase()
    if (q) filtered = filtered.filter((a) => a.name.toLowerCase().includes(q))
    return filtered
  },
}))
