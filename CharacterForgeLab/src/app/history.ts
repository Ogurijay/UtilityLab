import { useEditor } from '../store/editor'

/**
 * 全局撤销 / 重做栈（命令模式）。
 *  - key 相同且间隔小于 900ms 的命令自动合并（滑杆拖动、操纵器拖拽只占一步）
 *  - 被挤出栈或被新分支覆盖的命令会调用 dispose 释放其持有的三维资源
 */
export interface Command {
  label: string
  /** 合并键；相同键的连续操作合并为一步 */
  key?: string
  undo(): void
  redo(): void
  /** 命令被永久丢弃时调用（释放其持有的对象 / 资源） */
  dispose?(): void
}

interface StackEntry extends Command {
  time: number
}

const LIMIT = 50
const COALESCE_MS = 900

let undoStack: StackEntry[] = []
let redoStack: StackEntry[] = []
let busy = false

function syncCounts(): void {
  useEditor.setState({
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    undoLabel: undoStack[undoStack.length - 1]?.label ?? '',
    redoLabel: redoStack[redoStack.length - 1]?.label ?? '',
  })
}

export function pushCommand(cmd: Command): void {
  if (busy) return // undo/redo 执行过程中产生的状态回写不再入栈
  if (useEditor.getState().workspaceMode === 'character') {
    useEditor.setState({ workspaceDirty: true })
  }
  for (const c of redoStack) c.dispose?.()
  redoStack = []

  const now = Date.now()
  const top = undoStack[undoStack.length - 1]
  if (cmd.key && top && top.key === cmd.key && now - top.time < COALESCE_MS) {
    // 合并：保留最早的 undo，替换为最新的 redo
    top.redo = cmd.redo
    top.time = now
    syncCounts()
    return
  }

  undoStack.push({ ...cmd, time: now })
  if (undoStack.length > LIMIT) {
    undoStack.shift()?.dispose?.()
  }
  syncCounts()
}

export function undoLast(): void {
  const cmd = undoStack.pop()
  if (!cmd) return
  busy = true
  try {
    cmd.undo()
  } finally {
    busy = false
  }
  redoStack.push(cmd)
  syncCounts()
}

export function redoLast(): void {
  const cmd = redoStack.pop()
  if (!cmd) return
  busy = true
  try {
    cmd.redo()
  } finally {
    busy = false
  }
  undoStack.push(cmd)
  syncCounts()
}

export function clearHistory(): void {
  for (const c of undoStack) c.dispose?.()
  for (const c of redoStack) c.dispose?.()
  undoStack = []
  redoStack = []
  syncCounts()
}
/** 丢弃某个临时编辑会话产生的命令，避免会话结束后撤销到已释放对象。 */
export function discardCommandsByKeyPrefix(prefix: string): void {
  const discard = (entry: StackEntry): boolean => {
    if (!entry.key?.startsWith(prefix)) return false
    entry.dispose?.()
    return true
  }
  undoStack = undoStack.filter((entry) => !discard(entry))
  redoStack = redoStack.filter((entry) => !discard(entry))
  syncCounts()
}

/** 撤销 / 重做执行中（用于抑制级联入栈） */
export function isHistoryBusy(): boolean {
  return busy
}
