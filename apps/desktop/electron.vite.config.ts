import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Workspace packages ship TypeScript source, so they must be bundled rather
// than externalized to node_modules.
const workspacePackages = ['@ion/agent', '@ion/xai', '@ion/proxy']

// The packaged app excludes node_modules entirely, so every runtime dep of
// the main process must be bundled too.
const bundledDeps = [...workspacePackages, 'electron-updater']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })]
  },
  renderer: {
    plugins: [react(), tailwindcss()]
  }
})
