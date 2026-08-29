import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dataLibrary } from './plugins/dataLibrary'

export default defineConfig({
  plugins: [react(), dataLibrary({ directory: 'data' })],
  server: { port: 5173 },
})
