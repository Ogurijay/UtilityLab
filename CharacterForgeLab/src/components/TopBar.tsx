import { useEffect, useState } from 'react'
import { useEditor } from '../store/editor'
import {
  createNewObject, exportObjectGlb, leaveObjectEditor, openCharacterWorkspace,
  saveCharacterToLibrary, saveCurrentCharacterWorkspace, saveObjectToLibrary, setObjectName,
  takeScreenshot,
} from '../app/controller'
import { redoLast, undoLast } from '../app/history'
import { listCharacterWorkspaces, type WorkspaceSummary } from '../services/animotionHub'
import { Modal } from './common'
import { Icon } from './Icons'

export function TopBar() {
  const workspaceMode = useEditor((s) => s.workspaceMode)
  const hasCharacter = useEditor((s) => s.hasCharacter)
  const characterName = useEditor((s) => s.characterName)
  const skeletonGuess = useEditor((s) => s.skeletonGuess)
  const objectDirty = useEditor((s) => s.objectDirty)
  const objectCount = useEditor((s) => s.objectNodes.length)
  const workspaceDirty = useEditor((s) => s.workspaceDirty)
  const workspaceSavedAt = useEditor((s) => s.workspaceSavedAt)
  const undoCount = useEditor((s) => s.undoCount)
  const redoCount = useEditor((s) => s.redoCount)
  const undoLabel = useEditor((s) => s.undoLabel)
  const redoLabel = useEditor((s) => s.redoLabel)
  const set = useEditor((s) => s.set)
  const objectMode = workspaceMode === 'object'
  const [workspacesOpen, setWorkspacesOpen] = useState(false)

  return (
    <header className={`topbar ${objectMode ? 'object-topbar' : ''}`}>
      {objectMode && (
        <button className="btn small object-back" onClick={leaveObjectEditor}>
          <span aria-hidden="true">←</span>
          返回人物编辑
        </button>
      )}

      <div className="brand">
        CharacterForgeLab
        <span className="sub">{objectMode ? '物体建模工作台' : '人物资产编辑器'}</span>
      </div>

      {!objectMode && (
        <>
          <button className="btn small" onClick={() => setWorkspacesOpen(true)}>
            打开人物项目
          </button>
          <button className="btn primary small new-object-button" onClick={createNewObject}>
            <Icon name="plus" size={13} />
            新增物体
          </button>
        </>
      )}

      {objectMode ? (
        <div className="object-document-status">
          <input
            type="text"
            aria-label="物体名称"
            value={characterName}
            placeholder="未命名物体"
            onChange={(event) => setObjectName(event.target.value)}
          />
          <span className={objectDirty ? 'dirty' : 'saved'}>
            <i />
            {objectDirty ? '未保存' : '已保存'}
          </span>
        </div>
      ) : hasCharacter ? (
        <div className="top-status" title={`${characterName} · ${skeletonGuess}`}>
          <b>{characterName}</b>
          <span>·</span>
          <span>{skeletonGuess}</span>
          <span>·</span>
          <span className={workspaceDirty ? 'workspace-dirty' : 'workspace-saved'}>
            {workspaceDirty ? '人物项目未保存' : workspaceSavedAt ? '人物项目已保存' : '尚未正式保存'}
          </span>
        </div>
      ) : null}

      <div className="spacer" />

      {objectMode && (
        <button className="btn small" onClick={createNewObject}>
          <Icon name="plus" size={13} />
          新建空白物体
        </button>
      )}

      <button
        className="icon-btn solid"
        disabled={undoCount === 0}
        title={undoCount > 0 ? `撤销：${undoLabel}（Ctrl+Z）` : '没有可撤销的操作'}
        onClick={undoLast}
      >
        <Icon name="undo" />
      </button>
      <button
        className="icon-btn solid"
        disabled={redoCount === 0}
        title={redoCount > 0 ? `重做：${redoLabel}（Ctrl+Y）` : '没有可重做的操作'}
        onClick={redoLast}
      >
        <Icon name="redo" />
      </button>

      <div className="top-divider" />

      <button className="btn small" title="保存当前视角截图" onClick={takeScreenshot}>
        <Icon name="camera" />
        截图
      </button>

      {objectMode ? (
        <>
          <button
            className="btn small"
            disabled={objectCount === 0}
            title="保存到左侧人物页面的资源库；本地资产会更新，系统资产会另存副本"
            onClick={() => void saveObjectToLibrary()}
          >
            <Icon name="save" />
            保存到资产库
          </button>
          <button
            className="btn primary small"
            disabled={objectCount === 0}
            onClick={() => void exportObjectGlb()}
          >
            <Icon name="export" />
            导出物体 GLB
          </button>
        </>
      ) : (
        <>
          <button
            className="btn small"
            disabled={!hasCharacter}
            title="保存可重新打开的人物项目：基础角色、头部组件、挂载关系、姿势和动画"
            onClick={() => void saveCurrentCharacterWorkspace()}
          >
            <Icon name="save" />
            保存人物项目
          </button>
          <button
            className="btn small"
            disabled={!hasCharacter}
            title="把当前角色（含动画）作为资源存进库里"
            onClick={saveCharacterToLibrary}
          >
            <Icon name="save" />
            保存角色到库
          </button>
          <button
            className="btn primary small"
            disabled={!hasCharacter}
            onClick={() => set({ exportOpen: true })}
          >
            <Icon name="export" />
            导出角色 GLB
          </button>
        </>
      )}
      {workspacesOpen && <WorkspaceDialog onClose={() => setWorkspacesOpen(false)} />}
    </header>
  )
}

function WorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<WorkspaceSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    void listCharacterWorkspaces()
      .then((result) => {
        if (active) setItems(result.sort((left, right) => String(right.updated || '').localeCompare(String(left.updated || ''))))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <Modal title="打开人物项目" onClose={onClose} width={560}>
      {loading ? (
        <div className="hint">正在读取人物项目…</div>
      ) : items.length === 0 ? (
        <div className="empty-panel">还没有正式保存的人物项目。</div>
      ) : (
        <div className="workspace-list">
          {items.map((item) => (
            <button
              className="workspace-row"
              key={item.id}
              onClick={async () => {
                onClose()
                await openCharacterWorkspace(item.id)
              }}
            >
              <span>
                <b>{item.name}</b>
                <small>{item.id}</small>
              </span>
              <time>{item.updated ? new Date(item.updated).toLocaleString('zh-CN') : '未记录时间'}</time>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
