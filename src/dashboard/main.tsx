import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AppShell from './AppShell'
import { getBasePath } from './lib/apiBase'
import './globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell basename={getBasePath()} />
  </StrictMode>,
)
