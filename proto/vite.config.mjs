import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.ADE_UI_PORT) || 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.ADE_PORT || 4317}`, changeOrigin: true } },
  },
})
