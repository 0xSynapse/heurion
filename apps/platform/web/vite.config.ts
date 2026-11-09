import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 页面开发服务器：/api、/collab 代理到平台 server（8787）
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    // 多页：主应用（index.html）与知家移动外壳（phr.html，docs/design/PATIENT.md）
    rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), phr: resolve(import.meta.dirname, 'phr.html') } },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      // pdf.js 的 CMap 与标准字体由平台服务提供
      '/pdfjs': 'http://127.0.0.1:8787',
      '/collab': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
