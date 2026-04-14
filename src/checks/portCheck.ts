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
      finish({ portOpen: false, responseTime, errorMessage: err.message })
    })

    socket.on('timeout', () => {
      const responseTime = Math.round(performance.now() - start)
      finish({ portOpen: false, responseTime, errorMessage: 'Connection timed out' })
    })
  })
}
