import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A pasta de saída vem do build (packages/web/dist/builds/<carimbo>), nunca daqui.
export default defineConfig({ plugins: [react()] })
