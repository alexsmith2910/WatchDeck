/**
 * TCP port check using net.createConnection.
 *
 * Attempts to open a TCP connection to host:port within the timeout.
 * Response time is always the real elapsed time — never null.
 */

import { performance } from 'node:perf_hooks'
import * as net from 'node:net'

export interface PortCheckResult {
  portOpen: boolean
  responseTime: number
  errorMessage: string | null
}

export function runPortCheck(params: {
  host: string
  port: number
  timeout?: number
}): Promise<PortCheckResult> {
  const { host, port, timeout = 10_000 } = params
  const start = performance.now()

  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    function finish(result: PortCheckResult): void {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeout)

    socket.connect(port, host, () => {
      const responseTime = Math.round(performance.now() - start)
      finish({ portOpen: true, responseTime, errorMessage: null })
    })

    socket.on('error', (err: Error) => {
      const responseTime = Math.round(performance.now() - start)
      const errnoErr = err as NodeJS.ErrnoException
      const msg = err.message || errnoErr.code || 'Connection failed'
      finish({ portOpen: false, responseTime, errorMessage: msg })
    })

    // Catch clean close (no preceding error) — can occur on some platforms
    // when a packet is dropped rather than actively refused.
    socket.on('close', (hadError: boolean) => {
      if (!hadError) {
        const responseTime = Math.round(performance.now() - start)
        finish({ portOpen: false, responseTime, errorMessage: 'Connection closed' })
      }
    })

    socket.on('timeout', () => {
      const responseTime = Math.round(performance.now() - start)
      finish({ portOpen: false, responseTime, errorMessage: 'Connection timed out' })
    })
  })
}
