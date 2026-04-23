import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { SSEProvider } from './context/SSEContext'
import { PreferencesProvider } from './context/PreferencesContext'
import { ToastProvider, ToastBridge } from './ui/toast'
import App from './App'
import './globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <PreferencesProvider>
          <SSEProvider>
            <ToastProvider />
            <ToastBridge />
            <App />
          </SSEProvider>
        </PreferencesProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)
