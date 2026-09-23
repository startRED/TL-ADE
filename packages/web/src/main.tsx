import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bodoni-moda/opsz.css'
import '@fontsource-variable/bodoni-moda/opsz-italic.css'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '@fontsource/bravura/400.css'
import './app.css'
import App from './App.tsx'
import { startSmoothScroll } from './motion.ts'

const root = document.getElementById('root')
if (!root) throw new Error('Elemento #root ausente no index.html do painel.')
startSmoothScroll()
createRoot(root).render(<StrictMode><App /></StrictMode>)
