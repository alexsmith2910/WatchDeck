import { useContext } from 'react'
import { SSEContext, type SSEContextValue } from '../context/SSEContext'

/**
 * Access the SSE connection state and subscribe to events.
 * Must be used within an <SSEProvider>.
 */
export function useSSE(): SSEContextValue {
  const ctx = useContext(SSEContext)
  if (!ctx) {
    throw new Error('useSSE must be used within an <SSEProvider>')
  }
  return ctx
}
