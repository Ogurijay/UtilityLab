import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { TextureEntry } from '../types'

interface EffectLabDB extends DBSchema {
  textures: { key: string; value: TextureEntry }
  blobs: { key: string; value: Blob }
  presets: { key: string; value: { id: string; json: string; updatedAt: number } }
}

let dbPromise: Promise<IDBPDatabase<EffectLabDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<EffectLabDB>('effectlab', 1, {
      upgrade(d) {
        d.createObjectStore('textures', { keyPath: 'id' })
        d.createObjectStore('blobs')
        d.createObjectStore('presets', { keyPath: 'id' })
      },
    })
  }
  return dbPromise
}

export async function listTextures(): Promise<TextureEntry[]> {
  const all = await (await db()).getAll('textures')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putTexture(entry: TextureEntry, blob: Blob) {
  const d = await db()
  await d.put('textures', entry)
  await d.put('blobs', blob, entry.id)
}

export async function getTextureBlob(id: string): Promise<Blob | undefined> {
  return (await db()).get('blobs', id)
}

export async function deleteTexture(id: string) {
  const d = await db()
  await d.delete('textures', id)
  await d.delete('blobs', id)
}

export async function listPresets() {
  const all = await (await db()).getAll('presets')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putPreset(id: string, json: string) {
  await (await db()).put('presets', { id, json, updatedAt: Date.now() })
}

export async function deletePreset(id: string) {
  await (await db()).delete('presets', id)
}
