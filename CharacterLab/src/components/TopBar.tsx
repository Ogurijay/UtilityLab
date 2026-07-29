import { useEditor } from '../store/editor'
import { saveCharacterToLibrary, takeScreenshot } from '../app/controller'
import { redoLast, undoLast } from '../app/history'
import { Icon } from './Icons'

export function TopBar() {
  const hasCharacter = useEditor((s) => s.hasCharacter)
  const characterName = useEditor((s) => s.characterName)
  const skeletonGuess = useEditor((s) => s.skeletonGuess)
  const undoCount = useEditor((s) => s.undoCount)
  const redoCount = useEditor((s) => s.redoCount)
  const undoLabel = useEditor((s) => s.undoLabel)
  const redoLabel = useEditor((s) => s.redoLabel)
  const set = useEditor((s) => s.set)

  return (
    <header className="topbar">
      <div className="brand">
        CharacterLab
        <span className="sub">角色工坊</span>
      </div>
      {hasCharacter && (
        <div className="top-status" title={`${characterName} · ${skeletonGuess}`}>
          <b>{characterName}</b>
          <span>·</span>
          <span>{skeletonGuess}</span>
        </div>
      )}
      <div className="spacer" />

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
      <button
        className="btn small"
        disabled={!hasCharacter}
        title="把当前角色（含动画）作为资源存进库里"
        onClick={saveCharacterToLibrary}
      >
        <Icon name="save" />
        存入库
      </button>
      <button
        className="btn primary small"
        disabled={!hasCharacter}
        onClick={() => set({ exportOpen: true })}
      >
        <Icon name="export" />
        导出 GLB
      </button>
    </header>
  )
}
