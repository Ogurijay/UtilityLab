import { useEffect, useState } from 'react'
import type { ObjectNodeInfo, ObjectTool, PrimitiveKind } from '../types'
import { useEditor } from '../store/editor'
import {
  addObjectPrimitive, duplicateObjectNode, removeObjectNode, renameObjectNode,
  mergeSelectedObjectNodes, selectObjectRoot, setObjectNodeVisible, setObjectTool,
  toggleObjectSelection,
} from '../app/controller'
import { Icon } from './Icons'

const PRIMITIVES: { kind: PrimitiveKind; label: string; shape: string }[] = [
  { kind: 'box', label: '方块', shape: '□' },
  { kind: 'sphere', label: '球体', shape: '○' },
  { kind: 'cylinder', label: '圆柱', shape: '▯' },
  { kind: 'cone', label: '圆锥', shape: '△' },
  { kind: 'capsule', label: '胶囊', shape: '⬭' },
  { kind: 'torus', label: '圆环', shape: '◎' },
]

export function ObjectStructurePanel() {
  const nodes = useEditor((s) => s.objectNodes)
  const selectedIds = useEditor((s) => s.objectSelectedIds)
  const objectTool = useEditor((s) => s.objectTool)
  const selection = useEditor((s) => s.selection)
  const characterName = useEditor((s) => s.characterName)

  return (
    <aside className="lib object-structure">
      <div className="object-panel-head">
        <div>
          <h2>单物体结构</h2>
          <p>从基础形状创建，或编辑导入资产的独立网格。</p>
        </div>
      </div>

      <div className="object-side-body">
        <section className="object-side-section">
          <div className="object-side-title">
            <span>编辑工具</span>
            <small>单一工作台</small>
          </div>
          <div className="object-tool-tabs">
            {([
              ['select', '选择与变换'],
              ['sculpt', '雕刻'],
              ['split', '拆分'],
            ] as [ObjectTool, string][]).map(([tool, label]) => (
              <button
                key={tool}
                type="button"
                className={objectTool === tool ? 'active' : ''}
                onClick={() => setObjectTool(tool)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="object-side-section">
          <div className="object-side-title">
            <span>添加基础形状</span>
            <small>从 0 创建</small>
          </div>
          <div className="primitive-grid">
            {PRIMITIVES.map((item) => (
              <button
                key={item.kind}
                type="button"
                className="primitive-btn"
                onClick={() => addObjectPrimitive(item.kind)}
              >
                <b>{item.shape}</b>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="object-side-section object-tree-section">
          <div className="object-side-title">
            <span>物体结构</span>
            <small>{nodes.length} 个网格 · 已选 {selectedIds.length}</small>
          </div>
          <button
            type="button"
            className="btn primary small object-merge-button"
            disabled={selectedIds.length < 2}
            onClick={mergeSelectedObjectNodes}
          >
            合并选中网格
          </button>
          <button
            type="button"
            className={`object-root-row ${selection?.kind === 'character' ? 'active' : ''}`}
            onClick={selectObjectRoot}
          >
            <Icon name="layers" size={14} />
            <span className="name">{characterName || '未命名物体'}</span>
            <span className="object-root-tag">整体</span>
          </button>

          {nodes.length === 0 ? (
            <div className="object-empty">
              <Icon name="cube" size={28} />
              <b>这是一个空白物体</b>
              <span>点击上面的基础形状开始创建。</span>
            </div>
          ) : (
            <div className="object-node-list">
              {nodes.map((node) => (
                <ObjectNodeRow
                  key={node.id}
                  node={node}
                  selected={selection?.kind === 'object' && selection.id === node.id}
                  checked={selectedIds.includes(node.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function ObjectNodeRow({
  node,
  selected,
  checked,
}: {
  node: ObjectNodeInfo
  selected: boolean
  checked: boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(node.name)

  useEffect(() => setDraft(node.name), [node.name])

  const finishRename = () => {
    setRenaming(false)
    const next = draft.trim()
    if (next && next !== node.name) renameObjectNode(node.id, next)
    else setDraft(node.name)
  }

  return (
    <div
      className={`object-node-row ${selected ? 'active' : ''} ${checked ? 'checked' : ''}`}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) toggleObjectSelection(node.id, true)
        else toggleObjectSelection(node.id, false)
      }}
      onDoubleClick={() => setRenaming(true)}
    >
      <input
        className="node-select-check"
        type="checkbox"
        checked={checked}
        title="勾选多个网格后可以合并"
        onClick={(event) => event.stopPropagation()}
        onChange={() => toggleObjectSelection(node.id, true)}
      />
      <button
        type="button"
        className={`node-eye ${node.visible ? '' : 'off'}`}
        title={node.visible ? '隐藏组件' : '显示组件'}
        onClick={(event) => {
          event.stopPropagation()
          setObjectNodeVisible(node.id, !node.visible)
        }}
      >
        <Icon name="eye" size={13} />
      </button>
      <Icon name="cube" size={13} />
      <div className="node-main">
        {renaming ? (
          <input
            type="text"
            autoFocus
            value={draft}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishRename()
              if (event.key === 'Escape') {
                setDraft(node.name)
                setRenaming(false)
              }
            }}
            onBlur={finishRename}
          />
        ) : (
          <>
            <span className="node-name" title={node.name}>{node.name}</span>
            <span className="node-type">{node.type} · {node.vertices.toLocaleString()} 顶点</span>
          </>
        )}
      </div>
      {!renaming && (
        <div className="node-actions">
          <button
            type="button"
            title="重命名"
            onClick={(event) => {
              event.stopPropagation()
              setRenaming(true)
            }}
          >
            <Icon name="edit" size={12} />
          </button>
          <button
            type="button"
            title="复制组件"
            onClick={(event) => {
              event.stopPropagation()
              duplicateObjectNode(node.id)
            }}
          >
            <Icon name="layers" size={12} />
          </button>
          <button
            type="button"
            className="danger"
            title="删除组件（Delete）"
            onClick={(event) => {
              event.stopPropagation()
              removeObjectNode(node.id)
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
