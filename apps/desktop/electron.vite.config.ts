import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Workspace packages ship TypeScript source, so they must be bundled rather
// than externalized to node_modules.
const workspacePackages = ['@ion/agent', '@ion/xai', '@ion/proxy']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })]
  },
  renderer: {
    plugins: [react(), tailwindcss()]
  }
})
