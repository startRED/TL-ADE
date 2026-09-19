import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.ADE_UI_PORT) || 5173,
    // .ade/ guarda o estado do motor e as cópias do projeto (chat e partes em paralelo); vigiar recarregava a página a cada escrita
    watch: { ignored: ['**/.ade/**'] },
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.ADE_PORT || 4317}`, changeOrigin: true } },
  },
})
