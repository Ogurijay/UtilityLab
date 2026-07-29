import { openDB, type IDBPDatabase } from 'idb'
import type { AssetMeta, Folder } from '../types'

/**
 * 资源库持久化：IndexedDB 三张表。
 *  - meta    资源元数据（列表页只读这张，速度快）
 *  - blobs   原始文件内容，按需取
 *  - folders 用户自定义文件夹
 */
const DB_NAME = 'characterlab'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase> | null = null

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' })
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs')
        if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' })
      },
    })
  }
  return dbPromise
}

export async function listAssetMeta(): Promise<AssetMeta[]> {
  return (await (await db()).getAll('meta')) as AssetMeta[]
}

export async function listFolders(): Promise<Folder[]> {
  return (await (await db()).getAll('folders')) as Folder[]
}

export async function putAsset(meta: AssetMeta, blob: Blob): Promise<void> {
  const d = await db()
  const tx = d.transaction(['meta', 'blobs'], 'readwrite')
  await Promise.all([
    tx.objectStore('meta').put(meta),
    tx.objectStore('blobs').put(blob, meta.id),
    tx.done,
  ])
}

export async function putMeta(meta: AssetMeta): Promise<void> {
  await (await db()).put('meta', meta)
}

export async function getAssetBlob(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('blobs', id)) as Blob | undefined
}

export async function deleteAsset(id: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['meta', 'blobs'], 'readwrite')
  await Promise.all([
    tx.objectStore('meta').delete(id),
    tx.objectStore('blobs').delete(id),
    tx.done,
  ])
}

export async function putFolder(folder: Folder): Promise<void> {
  await (await db()).put('folders', folder)
}

export async function deleteFolder(id: string): Promise<void> {
  await (await db()).delete('folders', id)
}
