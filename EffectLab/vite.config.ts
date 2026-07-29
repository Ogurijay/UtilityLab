import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 8617 已被 CharacterLab 占用；本机 5173 处于 Windows 保留端口段。
export default defineConfig({
  plugins: [react()],
  server: { port: 8618, strictPort: true },
  build: { chunkSizeWarningLimit: 2000 },
})
