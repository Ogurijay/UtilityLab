import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/CharacterStudio/',
  plugins: [react()],
  server: {
    port: 8617,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/CharacterStudio/library': 'http://127.0.0.1:8788',
      '/CharacterStudio/data': 'http://127.0.0.1:8788',
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
})
