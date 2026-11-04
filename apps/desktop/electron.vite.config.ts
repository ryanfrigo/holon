import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], define: { __HOLON_ROOT__: JSON.stringify(root) } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
})
