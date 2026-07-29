import { useRef, useState } from 'react'
import type { AssetMeta } from '../types'
import { useLibrary } from '../store/library'
import { addPartFromAsset, bindAnimAsset, deleteAssetWithUndo, mountAsset, useAssetAsCharacter } from '../app/controller'
import { formatBytes } from '../core/loaders'
import { SOCKET_PRESETS } from '../core/skeletons/standard'
import { PopMenu, type MenuItem } from './common'
import { Icon } from './Icons'

const KIND_ICON: Record<string, string> = { model: 'person', anim: 'film', prop: 'cube' }
const KIND_LABEL: Record<string, string> = { model: '模型', anim: '动画', prop: '道具' }

export function LibraryPanel() {
  const lib = useLibrary()
  const fileInput = useRef<HTMLInputElement>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null)

  const assets = lib.visibleAssets()
  const countIn = (folderId: string) => lib.assets.filter((a) => a.folderId === folderId).length

  return (
    <aside className="lib">
      <div className="lib-head">
        <div className="row1">
          <h2>资源库</h2>
          <button className="btn primary small" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={13} />
            导入
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept=".glb,.gltf,.fbx,.obj"
            onChange={(e) => {
              if (e.target.files?.length) lib.importFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
        <input
          className="lib-search"
          type="text"
          placeholder="搜索资源…"
          value={lib.search}
          onChange={(e) => lib.setSearch(e.target.value)}
        />
        <div className="lib-tabs">
          {(
            [
              ['all', '全部'],
              ['model', '模型'],
              ['anim', '动画'],
              ['prop', '道具'],
              ['builtin', '内置'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={`chip ${lib.view === v ? 'active' : ''}`} onClick={() => lib.setView(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="lib-body">
        {lib.importing && <div className="importing-bar">正在解析导入的文件…</div>}

        <div className="folders">
          <div className="head">
            <span>我的文件夹</span>
            <button className="btn ghost small" onClick={() => setNewFolder('')}>
              <Icon name="plus" size={12} />
              新建
            </button>
          </div>
          {newFolder !== null && (
            <div className="folder-row">
              <Icon name="folder" size={13} />
              <input
                type="text"
                autoFocus
                placeholder="文件夹名"
                value={newFolder}
                style={{ flex: 1 }}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    lib.createFolder(newFolder)
                    setNewFolder(null)
                  }
                  if (e.key === 'Escape') setNewFolder(null)
                }}
                onBlur={() => {
                  if (newFolder.trim()) lib.createFolder(newFolder)
                  setNewFolder(null)
                }}
              />
            </div>
          )}
          {lib.folders.length === 0 && newFolder === null && (
            <div className="hint" style={{ padding: '2px 8px' }}>新建文件夹，按你的习惯归档资源</div>
          )}
          {lib.folders.map((f) => (
            <div
              key={f.id}
              className={`folder-row ${lib.view === `folder:${f.id}` ? 'active' : ''}`}
              onClick={() => lib.setView(`folder:${f.id}`)}
            >
              <Icon name="folder" size={13} />
              {renamingFolder?.id === f.id ? (
                <input
                  type="text"
                  autoFocus
                  value={renamingFolder.name}
                  style={{ flex: 1 }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenamingFolder({ id: f.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      lib.renameFolder(f.id, renamingFolder.name)
                      setRenamingFolder(null)
                    }
                    if (e.key === 'Escape') setRenamingFolder(null)
                  }}
                  onBlur={() => {
                    lib.renameFolder(f.id, renamingFolder.name)
                    setRenamingFolder(null)
                  }}
                />
              ) : (
                <span className="name">{f.name}</span>
              )}
              <span className="count">{countIn(f.id)}</span>
              <span className="ops">
                <button
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenamingFolder({ id: f.id, name: f.name })
                  }}
                >
                  <Icon name="edit" size={12} />
                </button>
                <button
                  title="删除文件夹（资源会回到未归档）"
                  onClick={(e) => {
                    e.stopPropagation()
                    lib.removeFolder(f.id)
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>

        {assets.length === 0 ? (
          <div className="lib-empty">
            这里还没有资源。
            <br />
            点击「导入」或把 GLB / FBX / OBJ
            <br />
            文件直接拖进窗口。
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function AssetCard({ asset }: { asset: AssetMeta }) {
  const lib = useLibrary()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  const primary = () => {
    if (asset.kind === 'model') useAssetAsCharacter(asset.id)
    else if (asset.kind === 'anim') bindAnimAsset(asset.id)
    else addPartFromAsset(asset.id)
  }
  const primaryLabel = asset.kind === 'model' ? '设为角色' : asset.kind === 'anim' ? '绑定动画' : '加入拼装台'

  const menuItems: MenuItem[] = [
    { label: `${KIND_LABEL[asset.kind]} · ${asset.builtin ? '内置' : (asset.format || '?').toUpperCase()}`, title: true },
    ...(asset.kind === 'model'
      ? [{ label: '设为当前角色', onClick: () => useAssetAsCharacter(asset.id) }]
      : []),
    ...(asset.kind === 'anim'
      ? [{ label: '绑定到当前角色', onClick: () => bindAnimAsset(asset.id) }]
      : []),
    ...(asset.kind !== 'anim'
      ? [
          { label: '加入拼装台', onClick: () => addPartFromAsset(asset.id) },
          {
            label: '挂载到…',
            children: SOCKET_PRESETS.map((p) => ({
              label: p.label,
              onClick: () => mountAsset(asset.id, { presetId: p.id }),
            })),
          },
        ]
      : []),
    ...(!asset.builtin
      ? [
          {
            label: '移动到文件夹…',
            children: [
              { label: '（未归档）', onClick: () => lib.moveAsset(asset.id, null) },
              ...lib.folders.map((f) => ({
                label: f.name,
                onClick: () => lib.moveAsset(asset.id, f.id),
              })),
            ],
          },
          {
            label: '更改类型…',
            children: (['model', 'anim', 'prop'] as const).map((k) => ({
              label: KIND_LABEL[k] + (asset.kind === k ? '（当前）' : ''),
              onClick: () => lib.setAssetKind(asset.id, k),
            })),
          },
          { label: '重命名', onClick: () => setRenaming(asset.name) },
          { label: '下载源文件', onClick: () => lib.downloadAsset(asset.id) },
          { label: '删除（可撤销）', danger: true, onClick: () => deleteAssetWithUndo(asset.id) },
        ]
      : []),
  ]

  return (
    <div className="asset-card">
      <div className="asset-thumb">
        {asset.thumb ? (
          <img src={asset.thumb} alt="" draggable={false} />
        ) : (
          <Icon name={KIND_ICON[asset.kind]} size={26} />
        )}
        <span className="asset-badge">{asset.builtin ? '内置' : (asset.format || '?').toUpperCase()}</span>
        <button className="asset-menu-btn" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>
          <Icon name="more" size={14} />
        </button>
      </div>
      <div className="asset-info">
        {renaming !== null ? (
          <input
            type="text"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                lib.renameAsset(asset.id, renaming)
                setRenaming(null)
              }
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => {
              lib.renameAsset(asset.id, renaming)
              setRenaming(null)
            }}
          />
        ) : (
          <div className="asset-name" title={`${asset.name}${asset.size ? ` · ${formatBytes(asset.size)}` : ''}`}>
            {asset.name}
          </div>
        )}
        <button className="btn" onClick={primary}>{primaryLabel}</button>
      </div>
      {menu && <PopMenu anchor={menu} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
