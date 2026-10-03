import { useEditor } from '../store/editor'
import { Icon } from './Icons'

export function ObjectFooter() {
  const count = useEditor((s) => s.objectNodes.length)
  const materialCount = useEditor((s) => s.materials.length)
  const dirty = useEditor((s) => s.objectDirty)
  const selection = useEditor((s) => s.selection)
  const selectedCount = useEditor((s) => s.objectSelectedIds.length)
  const objectTool = useEditor((s) => s.objectTool)
  const brush = useEditor((s) => s.sculptBrush)
  const toolLabel = objectTool === 'sculpt'
    ? `雕刻 · ${brush === 'grab' ? '抓取' : brush === 'inflate' ? '鼓起' : brush === 'smooth' ? '平滑' : brush === 'flatten' ? '压平' : '延长'}`
    : objectTool === 'split'
      ? '拆分'
      : '选择与变换'

  return (
    <footer className="object-footer">
      <div className="object-footer-title">
        <Icon name="cube" size={14} />
        物体编辑
      </div>
      <span>{count} 个网格</span>
      <span>{materialCount} 个材质</span>
      <span className="object-tool-status">{toolLabel}</span>
      <span className={dirty ? 'object-unsaved' : 'object-saved'}>
        <i />
        {dirty ? '有未保存修改' : '已保存'}
      </span>
      <div className="spacer" />
      <span>{selectedCount > 1 ? `已多选 ${selectedCount} 个网格` : selection ? '当前已选中对象' : '点击视口或左侧结构选择组件'}</span>
      {objectTool === 'select' && (
        <>
          <kbd>W</kbd> 移动
          <kbd>E</kbd> 旋转
          <kbd>R</kbd> 缩放
        </>
      )}
      <kbd>Del</kbd> 删除
    </footer>
  )
}
