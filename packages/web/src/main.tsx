import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@radix-ui/themes/styles.css'
import './app.css'
import App from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('Elemento #root ausente no index.html do painel.')
createRoot(root).render(<StrictMode><App /></StrictMode>)
