import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { SSEProvider } from './context/SSEContext'
import App from './App'
import './globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <SSEProvider>
          <App />
        </SSEProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)
