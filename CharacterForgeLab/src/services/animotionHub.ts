import type { AssetKind, AssetMeta } from '../types'
import type { ReferencePosePayload } from '../core/poses/reference'

interface HubAsset {
  id: string
  name: string
  display_name?: string
  asset_class?: string
  subtype?: string
  tags?: string[]
  source?: {
    format?: string
    runtime_file?: string
    size_bytes?: number
  }
  preview?: {
    runtime_file?: string
    thumbnail?: string | null
  }
  skeleton?: {
    profile_id?: string | null
  }
  availability?: {
    state?: string
  }
}

const CANONICAL_BASELINES = new Map([
  ['ue5-mannequin-simple', 'asset_0e94ed1a6dee4c7c'],
  ['uefn-mannequin', 'asset_167167ca63af4e35'],
])

function assetKind(item: HubAsset): AssetKind | null {
  if (item.asset_class === 'character') return 'model'
  if (item.asset_class === 'animation') return 'anim'
  return null
}

function toMeta(item: HubAsset): AssetMeta | null {
  const kind = assetKind(item)
  const runtimeUrl = item.preview?.runtime_file || item.source?.runtime_file
  if (!kind || !runtimeUrl) return null
  return {
    id: `hub:${item.id}`,
    name: item.display_name || item.name,
    kind,
    format: String(item.source?.format || 'glb').toLowerCase(),
    size: Number(item.source?.size_bytes || 0),
    folderId: null,
    thumb: item.preview?.thumbnail || undefined,
    builtin: true,
    system: true,
    runtimeUrl,
    skeletonProfileId: item.skeleton?.profile_id || undefined,
    createdAt: 0,
  }
}

/**
 * 只接入人物编辑器需要的系统基准与默认动作。
 * Manny 按骨架配置去重，并强制选择经过参考姿势验证的 Simple 基准。
 */
export async function loadAnimotionHubSystemAssets(): Promise<AssetMeta[]> {
  const response = await fetch('/api/assets', { cache: 'no-store' })
  if (!response.ok) throw new Error(`AnimotionHub 资产接口返回 HTTP ${response.status}`)
  const payload = await response.json() as { items?: HubAsset[] }
  const items = (payload.items || []).filter(
    item => item.availability?.state === 'ready',
  )

  const baselines = items.filter(item => {
    if (item.subtype !== 'system_baseline') return false
    const profileId = item.skeleton?.profile_id || ''
    return CANONICAL_BASELINES.get(profileId) === item.id
  })
  const animations = items.filter(
    item => item.asset_class === 'animation'
      && item.tags?.includes('默认动画')
      && ['ue5-mannequin-simple', 'uefn-mannequin'].includes(
        item.skeleton?.profile_id || '',
      ),
  )

  return [...baselines, ...animations]
    .map(toMeta)
    .filter((item): item is AssetMeta => Boolean(item))
}

export async function fetchSystemAsset(meta: AssetMeta): Promise<Blob> {
  if (!meta.runtimeUrl) throw new Error(`系统资产“${meta.name}”没有运行地址`)
  const response = await fetch(meta.runtimeUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`系统资产加载失败：HTTP ${response.status}`)
  }
  return response.blob()
}

let referencePosePromise: Promise<ReferencePosePayload> | null = null

/** 读取由真实 Manny / UEFN 基准资产生成并带骨架签名的参考姿势。 */
export function loadReferencePoseProfiles(): Promise<ReferencePosePayload> {
  referencePosePromise ??= fetch('/CharacterStudio/data/reference_pose_profiles_v2.json', {
    cache: 'no-store',
  }).then(async (response) => {
    if (!response.ok) throw new Error(`参考姿势接口返回 HTTP ${response.status}`)
    const payload = await response.json() as ReferencePosePayload
    if (payload.schema_version !== 2 || !payload.profiles) {
      throw new Error('参考姿势配置版本无效')
    }
    return payload
  })
  return referencePosePromise
}

export interface WorkspaceSummary {
  id: string
  name: string
  schema_version: number
  updated?: string
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || `请求失败：HTTP ${response.status}`)
  return payload
}

export async function listCharacterWorkspaces(): Promise<WorkspaceSummary[]> {
  const payload = await jsonRequest<{ items?: WorkspaceSummary[] }>('/api/workspaces', {
    cache: 'no-store',
  })
  return payload.items || []
}

export async function loadCharacterWorkspace<T = Record<string, unknown>>(id: string): Promise<T> {
  return jsonRequest<T>(`/api/workspaces/${encodeURIComponent(id)}`, { cache: 'no-store' })
}

export async function saveCharacterWorkspace<T>(workspace: T): Promise<T> {
  const payload = await jsonRequest<{ workspace: T }>('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workspace),
  })
  return payload.workspace
}

export interface HubJob {
  id: string
  type: string
  status: string
  progress: number
  result?: {
    asset_id?: string
    file?: string
    profile_id?: string
    quality?: string
  } | null
  error?: string | null
}

export async function submitAutoRigJob(
  blob: Blob,
  options: {
    name: string
    profileId: string
    sourcePose: 't' | 'a' | 'source'
    baselineAssetId: string
    sourceAssetId?: string | null
  },
): Promise<HubJob> {
  const response = await fetch('/api/jobs/auto-rig', {
    method: 'POST',
    headers: {
      'Content-Type': 'model/gltf-binary',
      'X-Rig-Name': encodeURIComponent(options.name),
      'X-Rig-Profile': options.profileId,
      'X-Source-Pose': options.sourcePose,
      'X-Baseline-Asset-Id': options.baselineAssetId.replace(/^hub:/, ''),
      'X-Source-Asset-Id': options.sourceAssetId?.replace(/^hub:/, '') || '',
    },
    body: blob,
  })
  const payload = await response.json().catch(() => ({})) as { job?: HubJob; error?: string }
  if (!response.ok || !payload.job) {
    throw new Error(payload.error || `后台自动蒙皮任务创建失败：HTTP ${response.status}`)
  }
  return payload.job
}

export async function fetchHubJob(jobId: string): Promise<HubJob> {
  return jsonRequest<HubJob>(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' })
}
