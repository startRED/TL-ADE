import React from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@radix-ui/themes'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Theme appearance="dark" accentColor="teal" grayColor="slate" radius="medium" scaling="95%">
      <App />
    </Theme>
  </React.StrictMode>,
)
