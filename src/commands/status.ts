/**
 * `watchdeck status` — query the running server and report its health.
 *
 * Two modes:
 *   --ping         Minimal up/down liveness (hits /health/ping).
 *   (default)      Full snapshot: overall banner, KPIs, and a 24-hour
 *                  activity bar per subsystem (hits /health).
 *
 * The /health snapshot endpoint is auth-gated on the network, but the auth
 * plugin bypasses auth for GET /health* requests from the loopback interface,
 * so the CLI can run against a local server without a token. Remote queries
 * (--host pointing elsewhere) require the user's middleware to let the CLI in.
 */

import chalk from 'chalk'
import { loadConfig } from '../config/loader.js'
import type { SystemHealthSnapshot, SubsystemView } from '../core/health/snapshot.js'
import type { HeatmapCell } from '../core/health/heatmapAggregator.js'
import type { ProbeStatus } from '../core/health/probeTypes.js'

interface StatusOptions {
  ping: boolean
  json: boolean
  host?: string
  port?: string
  config?: string
}

interface Target {
  host: string
  port: number
  basePath: string
  baseUrl: string
}

const REQUEST_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

async function resolveTarget(options: StatusOptions): Promise<Target> {
  let port = 4000
  let basePath = '/api/mx'

  try {
    const { config } = await loadConfig(options.config)
    port = config.port
    basePath = config.apiBasePath
  } catch {
    // Config file malformed or missing — fall through to defaults. Flags can
    // still override. We stay silent here because this is an ops tool and
    // complaining about the user's config for a status check is noise.
  }

  if (options.port !== undefined) {
    const parsed = parseInt(options.port, 10)
    if (Number.isFinite(parsed) && parsed > 0) port = parsed
  }
  const host = options.host ?? 'localhost'
  const baseUrl = `http://${host}:${port}${basePath}`
  return { host, port, basePath, baseUrl }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface FetchResult<T> {
  ok: boolean
  status?: number
  data?: T
  error?: string
}

async function getJson<T>(url: string): Promise<FetchResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as T
    return { ok: true, status: res.status, data }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// --ping mode
// ---------------------------------------------------------------------------

async function runPing(target: Target, asJson: boolean): Promise<void> {
  const url = `${target.baseUrl}/health/ping`
  const res = await getJson<{ ok: boolean }>(url)

  if (asJson) {
    const payload = res.ok
      ? { ok: true, url }
      : { ok: false, url, error: res.error ?? 'unknown' }
    console.log(JSON.stringify(payload, null, 2))
    process.exitCode = res.ok ? 0 : 1
    return
  }

  if (res.ok) {
    console.log(`${chalk.green('●')} ${chalk.bold('Operational')}  ${chalk.dim(url)}`)
    process.exitCode = 0
  } else {
    console.log(`${chalk.red('●')} ${chalk.bold('Not reachable')}  ${chalk.dim(url)}`)
    console.log(`  ${chalk.dim(res.error ?? 'unknown error')}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Full mode
// ---------------------------------------------------------------------------

type OverallState = SystemHealthSnapshot['overall']['state']

const STATE_GLYPH: Record<OverallState, string> = {
  operational: chalk.green('●'),
  degraded: chalk.yellow('●'),
  outage: chalk.red('●'),
}

const PROBE_STATUS_LABEL: Record<ProbeStatus, string> = {
  healthy: chalk.green('healthy'),
  degraded: chalk.yellow('degraded'),
  down: chalk.red('down'),
  standby: chalk.gray('standby'),
  disabled: chalk.gray('disabled'),
}

const BAR_ACTIVE = '█'
const BAR_IDLE = '░'

function cellGlyph(cell: HeatmapCell): string {
  if (cell.down > 0) return chalk.red(BAR_ACTIVE)
  if (cell.degraded > 0) return chalk.yellow(BAR_ACTIVE)
  if (cell.count > 0) return chalk.green(BAR_ACTIVE)
  return chalk.gray(BAR_IDLE)
}

function renderBar(cells: HeatmapCell[]): string {
  return cells.map(cellGlyph).join('')
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm > 0 ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh > 0 ? `${d}d ${hh}h` : `${d}d`
}

function formatLatency(ms: number | null): string {
  if (ms === null) return chalk.dim('—')
  if (ms < 1) return chalk.dim('<1ms')
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function primaryMetric(view: SubsystemView): string {
  const first = view.metrics[0]
  if (!first) return ''
  const unit = first.unit ?? ''
  return `${first.lbl} ${chalk.bold(String(first.val))}${unit}`
}

/** Pad a string to a target width using visible-character length (strip ANSI). */
function padEndVisible(str: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = str.replace(/\x1B\[[0-9;]*m/g, '')
  const pad = Math.max(0, width - visible.length)
  return str + ' '.repeat(pad)
}

function overallSummary(snapshot: SystemHealthSnapshot): string {
  const { subsystemsHealthy, subsystemsTotal, activeIncidents, p1Count, p2Count } =
    snapshot.overall
  const parts: string[] = []
  parts.push(`${subsystemsHealthy}/${subsystemsTotal} subsystems healthy`)
  if (activeIncidents === 0) {
    parts.push(chalk.dim('no active incidents'))
  } else {
    const p1 = p1Count > 0 ? chalk.red(`${p1Count}×P1`) : ''
    const p2 = p2Count > 0 ? chalk.yellow(`${p2Count}×P2`) : ''
    const detail = [p1, p2].filter(Boolean).join(' ')
    parts.push(
      `${chalk.bold(String(activeIncidents))} active incident${activeIncidents === 1 ? '' : 's'}${detail ? ' ' + detail : ''}`,
    )
  }
  return parts.join(chalk.dim(' · '))
}

function renderFull(snapshot: SystemHealthSnapshot, target: Target): void {
  const { overall, kpis, subsystems, heatmap } = snapshot

  // ── Header ─────────────────────────────────────────────────────────────
  console.log('')
  console.log(
    `  ${chalk.cyan.bold('WatchDeck')} ${chalk.dim(target.baseUrl)}`,
  )
  console.log('')

  // ── Overall banner ─────────────────────────────────────────────────────
  const uptime = formatUptime(overall.processUptimeSeconds)
  console.log(
    `  ${STATE_GLYPH[overall.state]} ${chalk.bold(overall.label)}  ${chalk.dim(`up ${uptime}`)}`,
  )
  console.log(`  ${chalk.dim(overallSummary(snapshot))}`)
  console.log('')

  // ── KPI strip ──────────────────────────────────────────────────────────
  const kpiRows: Array<[string, string]> = [
    ['DB ping', formatLatency(kpis.dbPingMs)],
    ['Scheduler drift', formatLatency(kpis.schedulerDriftMs)],
    ['Buffer latency', formatLatency(kpis.bufferLatencyMs)],
    ['Last probe', `${kpis.lastUpdatedSeconds}s ago`],
  ]
  for (const [label, value] of kpiRows) {
    console.log(`  ${chalk.dim(label.padEnd(16))}${value}`)
  }
  console.log('')

  // ── Subsystems table ───────────────────────────────────────────────────
  const rowsById = new Map(heatmap.rows.map((r) => [r.id, r]))

  const NAME_WIDTH = 16
  const STATUS_WIDTH = 11
  const BAR_WIDTH = heatmap.rows[0]?.values.length ?? 24

  // Header
  console.log(
    `  ${chalk.dim(padEndVisible('Subsystem', NAME_WIDTH))}${chalk.dim(padEndVisible('24h', BAR_WIDTH + 2))}${chalk.dim(padEndVisible('status', STATUS_WIDTH))}${chalk.dim('metric')}`,
  )
  console.log(`  ${chalk.dim('─'.repeat(NAME_WIDTH + BAR_WIDTH + 2 + STATUS_WIDTH + 14))}`)

  for (const sub of subsystems) {
    const row = rowsById.get(sub.id)
    const bar = row ? renderBar(row.values) : chalk.dim(BAR_IDLE.repeat(BAR_WIDTH))
    const name = padEndVisible(sub.title, NAME_WIDTH)
    const statusText = padEndVisible(PROBE_STATUS_LABEL[sub.status], STATUS_WIDTH)
    const metric = primaryMetric(sub) || chalk.dim('—')
    console.log(`  ${name}${bar}  ${statusText}${metric}`)
  }
  console.log('')

  // ── Legend ─────────────────────────────────────────────────────────────
  // Anchor the axis labels under the bar column: left edge aligns with the
  // leftmost cell, "now →" right-aligns with the rightmost cell.
  const leftLabel = '← 24h ago'
  const rightLabel = 'now →'
  const labelFill = Math.max(1, BAR_WIDTH - leftLabel.length - rightLabel.length)
  console.log(
    `  ${' '.repeat(NAME_WIDTH)}${chalk.dim(leftLabel + ' '.repeat(labelFill) + rightLabel)}`,
  )
  const legend = [
    `${chalk.green(BAR_ACTIVE)} healthy`,
    `${chalk.yellow(BAR_ACTIVE)} degraded`,
    `${chalk.red(BAR_ACTIVE)} down`,
    `${chalk.gray(BAR_IDLE)} idle`,
  ].join('   ')
  console.log(`  ${' '.repeat(NAME_WIDTH)}${legend}`)
  console.log('')
}

async function runFull(target: Target, asJson: boolean): Promise<void> {
  const url = `${target.baseUrl}/health`
  const res = await getJson<{ data: SystemHealthSnapshot }>(url)

  if (!res.ok) {
    if (asJson) {
      console.log(
        JSON.stringify(
          { ok: false, url, status: res.status ?? null, error: res.error ?? 'unknown' },
          null,
          2,
        ),
      )
    } else {
      console.log('')
      console.log(`  ${chalk.red('●')} ${chalk.bold('Server not reachable')}  ${chalk.dim(url)}`)
      console.log(`  ${chalk.dim(res.error ?? 'unknown error')}`)
      if (res.status === 401) {
        console.log(
          `  ${chalk.dim('Auth required — localhost bypass only applies when host is 127.0.0.1 or localhost.')}`,
        )
      } else {
        console.log(
          `  ${chalk.dim('Is the server running? Try `watchdeck start` in another terminal.')}`,
        )
      }
      console.log('')
    }
    process.exitCode = 1
    return
  }

  const snapshot = res.data!.data

  if (asJson) {
    console.log(JSON.stringify({ ok: true, url, data: snapshot }, null, 2))
    process.exitCode = 0
    return
  }

  renderFull(snapshot, target)
  process.exitCode = 0
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runStatus(options: StatusOptions): Promise<void> {
  const target = await resolveTarget(options)
  if (options.ping) {
    await runPing(target, options.json)
    return
  }
  await runFull(target, options.json)
}
