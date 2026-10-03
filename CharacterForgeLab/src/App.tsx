import { useEffect, useRef, useState } from 'react'
import { useEditor } from './store/editor'
import { useLibrary } from './store/library'
import { deleteSelection, select, setGizmoMode, togglePlay } from './app/controller'
import { redoLast, undoLast } from './app/history'
import { TopBar } from './components/TopBar'
import { LibraryPanel } from './components/LibraryPanel'
import { Viewport } from './components/Viewport'
import { Inspector } from './components/Inspector'
import { Timeline } from './components/Timeline'
import { ExportDialog } from './components/ExportDialog'
import { Toasts } from './components/Toasts'
import { ObjectStructurePanel } from './components/ObjectStructurePanel'
import { ObjectInspector } from './components/ObjectInspector'
import { ObjectFooter } from './components/ObjectFooter'

export default function App() {
  const exportOpen = useEditor((s) => s.exportOpen)
  const workspaceMode = useEditor((s) => s.workspaceMode)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    useLibrary.getState().init()
  }, [])

  // 全局拖拽导入
  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        depth++
        setDragging(true)
      }
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files.length) useLibrary.getState().importFiles(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // 快捷键：空格播放、Ctrl+Z/Y 撤销重做、W/E/R 操纵器模式、Delete 删除选中、Esc 取消选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'
      // 输入框内不劫持任何快捷键（保留文本自身的撤销等行为）
      if (typing) return

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redoLast()
        else undoLast()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault()
        redoLast()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'KeyW') {
        setGizmoMode('translate')
      } else if (e.code === 'KeyE') {
        setGizmoMode('rotate')
      } else if (e.code === 'KeyR') {
        setGizmoMode('scale')
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        deleteSelection()
      } else if (e.code === 'Escape') {
        select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={`app ${workspaceMode === 'object' ? 'object-mode' : ''}`}>
      <TopBar />
      {workspaceMode === 'object' ? <ObjectStructurePanel /> : <LibraryPanel />}
      <Viewport />
      {workspaceMode === 'object' ? <ObjectInspector /> : <Inspector />}
      {workspaceMode === 'object' ? <ObjectFooter /> : <Timeline />}
      <Toasts />
      {workspaceMode === 'character' && exportOpen && <ExportDialog />}
      {dragging && <div className="drop-overlay">松开鼠标，导入 GLB / GLTF / FBX / OBJ 文件</div>}
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".glb,.gltf,.fbx,.obj"
        onChange={(e) => {
          if (e.target.files?.length) useLibrary.getState().importFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
