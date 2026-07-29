import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { LibraryPanel } from './components/LibraryPanel'
import { Viewport } from './components/Viewport'
import { Inspector } from './components/Inspector'
import { useEditor } from './store/editor'

export default function App() {
  const toast = useEditor((s) => s.toast)
  const notify = useEditor((s) => s.notify)

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => notify(null), 3200)
    return () => clearTimeout(id)
  }, [toast, notify])

  return (
    <div className="app">
      <TopBar />
      <main className="layout">
        <LibraryPanel />
        <Viewport />
        <Inspector />
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
