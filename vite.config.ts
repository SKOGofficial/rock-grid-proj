import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dataLibrary } from './plugins/dataLibrary'

export default defineConfig({
  plugins: [react(), dataLibrary({ directory: 'data' })],
  server: {
    port: 5173,
    proxy: {
      // `/api/detect` only, never `/api`. The library listing at `/api/library` is served by the
      // dataLibrary plugin above; forwarding it to the detection service - which does not
      // implement it - would empty the file list.
      '/api/detect': {
        target: 'http://127.0.0.1:8000',
        // Correlation across eight orientations on a large sheet can outrun the default.
        proxyTimeout: 120_000,
        timeout: 120_000,
      },
    },
  },
})
