import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 8617, strictPort: true },
  build: { chunkSizeWarningLimit: 2000 },
})
